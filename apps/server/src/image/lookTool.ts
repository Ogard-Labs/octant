import { realpath } from "node:fs/promises";
import {
  decodeCodeRelativePath,
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_LOOK_QUESTION_CHARACTERS,
  type CodeRelativePath,
  type ImageDescribedBy,
  type ProjectId,
} from "@octant/contracts";
import { readConfinedCodeFile } from "../code/codeConfinedFileRead";
import { liveCodeTestSourcePort } from "../code/codeDirectoryPort";
import type {
  ImageDescriber,
  ImageDescriptionScope,
  ImageDescriptionOutcome,
  ImageToDescribe,
} from "../harness/imageDescription";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import {
  taintAppManagedToolResults,
  type TaintAppManagedToolResultsInput,
} from "../providers/appManagedToolTaint";

export const LOOK_TOOL_NAME = "octant_look";

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const DESCRIPTION =
  'Your model cannot read images. Ask the Sees images model to look at one for you: an image attached to this thread, by the attachment id its description names ("[Image <name> (attachment <id>), …]"), or an image file inside this thread\'s folder, by a path relative to it, with an optional question. You get its description in words, marked with the model that described it. No URLs and no paths outside the folder.';

const inputSchema = {
  type: "object",
  properties: {
    image: {
      type: "string",
      description:
        "The attachment id an image description names, or a PNG, JPEG, GIF, or WebP file path relative to the thread's folder.",
    },
    question: { type: "string", description: "What to look for, at most 500 characters." },
  },
  required: ["image"],
} as const;

export interface LookToolOptions {
  readonly describe: (input: {
    readonly image: ImageToDescribe;
    readonly question?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  }) => Promise<ImageDescriptionOutcome>;
  /** An image the person attached to this thread, by its attachment id. */
  readonly attachment?: (attachmentId: string) => Promise<ImageToDescribe | undefined>;
  /**
   * The folder a file path is read inside: the thread's checkout or working
   * folder. Absent (a Chat thread) means only attachments can be looked at.
   */
  readonly folder?: string | undefined;
  /** Reads a confined file; replaced in tests. */
  readonly readFile?: typeof readImageInsideFolder;
}

type LookInput = { readonly image: string; readonly question?: string };

/**
 * `octant_look`: a thread whose model cannot read images asks the Sees
 * images model about one image, by attachment id or by a path inside its own
 * folder. A path is confined like any other file read: relative, no `..`,
 * no link out of the folder, no URL; reading a file the thread may already
 * read asks for nothing new. The answer carries the model that described it.
 *
 * The host offers this set only while the thread's model cannot read images
 * and Sees images has a model that can take one, so it never offers a tool
 * that can only refuse.
 */
export function createLookTool(options: LookToolOptions): AppManagedToolSet {
  return {
    definitions: [{ name: LOOK_TOOL_NAME, description: DESCRIPTION, inputSchema }],
    execute: async ({ name, inputJson, signal }) => {
      if (name !== LOOK_TOOL_NAME) return refused("tool-unavailable");
      const parsed = parseLookInput(inputJson);
      if ("error" in parsed) return refused(parsed.error);
      const image = await resolveImage(options, parsed.image);
      if ("error" in image) return refused(image.error);
      const outcome = await options.describe({
        image,
        ...(parsed.question === undefined ? {} : { question: parsed.question }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (outcome.kind === "refused") return refused(outcome.reason);
      return { result: lookResult(image.name, outcome.describedBy, outcome.text) };
    },
  };
}

function lookResult(name: string, describedBy: ImageDescribedBy, description: string) {
  return {
    image: name,
    described_by: `${describedBy.model} (${describedBy.provider})`,
    description,
  };
}

function refused(error: string) {
  return { result: { error }, isError: true } as const;
}

export function parseLookInput(inputJson: string): LookInput | { readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "The look input is not valid JSON." };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "The look input must be an object with image and an optional question." };
  }
  const record = raw as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "image" && key !== "question");
  if (extra.length > 0) return { error: "The look input takes only image and question." };
  const image = record["image"];
  if (typeof image !== "string" || image.trim().length === 0 || image.length > 1_024) {
    return {
      error: "image must name an attachment id or a file path inside this thread's folder.",
    };
  }
  const question = record["question"];
  if (question !== undefined) {
    if (typeof question !== "string" || question.trim().length === 0) {
      return { error: "question must be text when it is given." };
    }
    if (question.length > MAX_LOOK_QUESTION_CHARACTERS) {
      return { error: `question is longer than ${MAX_LOOK_QUESTION_CHARACTERS} characters.` };
    }
    return { image: image.trim(), question: question.trim() };
  }
  return { image: image.trim() };
}

async function resolveImage(
  options: LookToolOptions,
  reference: string,
): Promise<ImageToDescribe | { readonly error: string }> {
  const attached = await options.attachment?.(reference).catch(() => undefined);
  if (attached !== undefined) return attached;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) {
    return {
      error: "look reads no URL; name an attachment or a file inside this thread's folder.",
    };
  }
  if (options.folder === undefined) {
    return { error: "No attachment of this thread has that id, and this thread has no folder." };
  }
  let path: CodeRelativePath;
  try {
    path = decodeCodeRelativePath(reference.replace(/^\.\//, ""));
  } catch {
    return {
      error: "The path must be relative to this thread's folder, with no .. and no leading /.",
    };
  }
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mediaType = MEDIA_BY_EXTENSION[extension];
  if (mediaType === undefined) return { error: "look reads PNG, JPEG, GIF, or WebP files." };
  const read = await (options.readFile ?? readImageInsideFolder)(options.folder, path);
  if (read.status === "refused") {
    return {
      error:
        read.reason === "outside-root"
          ? "That file is outside this thread's folder or does not exist."
          : read.reason === "too-large"
            ? "That image is larger than 10 MB."
            : "That file cannot be read.",
    };
  }
  return { name: path.split("/").at(-1) ?? path, mediaType, bytes: read.bytes };
}

/** One image file inside a folder, confined as the Code file reads are. */
export async function readImageInsideFolder(
  folder: string,
  relativePath: CodeRelativePath,
): Promise<
  | { readonly status: "read"; readonly bytes: Uint8Array }
  | {
      readonly status: "refused";
      readonly reason: "outside-root" | "not-a-file" | "too-large" | "unreadable";
    }
> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(folder);
  } catch {
    return { status: "refused", reason: "unreadable" };
  }
  return readConfinedCodeFile({
    port: liveCodeTestSourcePort,
    canonicalRoot,
    relativePath,
    maximumBytes: MAX_CODE_ATTACHMENT_BYTES,
  });
}

/**
 * The `look` set for one thread's turn, or nothing: it is offered only while
 * the thread's model cannot read images and Sees images has a model that can
 * describe one for this Project. A described image is the person's own or a
 * file inside the thread's folder, neither of which marks the thread, so the
 * result is not outside content; Octant Shield's Watcher still reads it.
 */
export function lookToolForThread(input: {
  readonly describer: Pick<ImageDescriber, "available" | "describe">;
  readonly threadId: string;
  readonly threadType: ImageDescriptionScope["threadType"];
  readonly projectId?: ProjectId | undefined;
  readonly threadModel: string;
  readonly readsImages: boolean;
  readonly attachment?: LookToolOptions["attachment"];
  readonly folder?: string | undefined;
  readonly recordExternalContentIngestion?: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
  readonly uuid: () => string;
}): AppManagedToolSet | undefined {
  if (input.readsImages) return undefined;
  const available = input.describer.available({
    projectId: input.projectId,
    threadModel: input.threadModel,
  });
  if (available.kind !== "available") return undefined;
  const tools = createLookTool({
    describe: ({ image, question, signal }) =>
      input.describer.describe({
        scope: { threadId: input.threadId, threadType: input.threadType },
        projectId: input.projectId,
        threadModel: input.threadModel,
        image,
        question,
        signal,
      }),
    ...(input.attachment === undefined ? {} : { attachment: input.attachment }),
    ...(input.folder === undefined ? {} : { folder: input.folder }),
  });
  return input.recordExternalContentIngestion === undefined
    ? tools
    : taintAppManagedToolResults({
        tools,
        threadId: input.threadId,
        recordExternalContentIngestion: input.recordExternalContentIngestion,
        uuid: input.uuid,
        resultTaintsThread: () => false,
      });
}
