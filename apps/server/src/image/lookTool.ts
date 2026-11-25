import { realpath } from "node:fs/promises";
import {
  MAX_CODE_ATTACHMENT_BYTES,
  type CodeRelativePath,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import type {
  MediaImageDescriptionOutcome,
  MediaToolHostPort,
} from "@octant/plugin-api/media-tools";
import {
  LOOK_MEDIA_TOOL_PLUGIN,
  LOOK_TOOL_NAME,
  parseLookToolInput,
} from "@octant/plugin-host/media-tools";
import { readConfinedCodeFile } from "../code/codeConfinedFileRead";
import { liveCodeTestSourcePort } from "../code/codeDirectoryPort";
import {
  isDescribableImageMediaType,
  type ImageDescriber,
  type ImageDescriptionOutcome,
  type ImageDescriptionScope,
  type ImageToDescribe,
} from "../harness/imageDescription";
import type { AppManagedToolSet } from "../providers/appManagedToolSet";
import type { TaintAppManagedToolResultsInput } from "../providers/appManagedToolTaint";
import { adaptMediaToolSet } from "../providers/mediaToolAdapter";

export { LOOK_TOOL_NAME, parseLookToolInput as parseLookInput };

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

function buildLookHostPort(
  options: LookToolOptions & {
    readonly mode: OctantMode;
    readonly isAvailable: () => boolean;
  },
): MediaToolHostPort {
  return {
    turn: {
      mode: options.mode,
      hasFolder: options.folder !== undefined,
      unattended: false,
      inPlan: () => false,
      allowed: () => true,
    },
    imageDescription: {
      isAvailable: options.isAvailable,
      describeAttachment: async ({ attachmentId, question, signal }) => {
        const attached = await options.attachment?.(attachmentId).catch(() => undefined);
        if (attached === undefined) return { status: "not-found" };
        const outcome = await options.describe({
          image: attached,
          ...(question === undefined ? {} : { question }),
          ...(signal === undefined ? {} : { signal }),
        });
        return toPortOutcome(attached.name, outcome);
      },
      describeFolderImage: async ({ relativePath, mediaType, question, signal }) => {
        if (!isDescribableImageMediaType(mediaType)) {
          return { status: "refused", reason: "look reads PNG, JPEG, GIF, or WebP files." };
        }
        if (options.folder === undefined) {
          return {
            status: "refused",
            reason: "No attachment of this thread has that id, and this thread has no folder.",
          };
        }
        const read = await (options.readFile ?? readImageInsideFolder)(
          options.folder,
          relativePath,
        );
        if (read.status === "refused") {
          return {
            status: "refused",
            reason:
              read.reason === "outside-root"
                ? "That file is outside this thread's folder or does not exist."
                : read.reason === "too-large"
                  ? "That image is larger than 10 MB."
                  : "That file cannot be read.",
          };
        }
        const imageName = relativePath.split("/").at(-1) ?? relativePath;
        const outcome = await options.describe({
          image: { name: imageName, mediaType, bytes: read.bytes },
          ...(question === undefined ? {} : { question }),
          ...(signal === undefined ? {} : { signal }),
        });
        return toPortOutcome(imageName, outcome);
      },
    },
  };
}

function toPortOutcome(
  imageName: string,
  outcome: ImageDescriptionOutcome,
): MediaImageDescriptionOutcome {
  if (outcome.kind === "refused") return { status: "refused", reason: outcome.reason };
  return {
    status: "described",
    imageName,
    describedBy: outcome.describedBy,
    description: outcome.text,
  };
}

/**
 * `octant_look`: a thread whose model cannot read images asks the Sees
 * images model about one image, by attachment id or by a path inside its own
 * folder. Composed through the public `LOOK_MEDIA_TOOL_PLUGIN` with host-owned
 * confinement, raw bytes, and Sees images routing.
 */
export function createLookTool(options: LookToolOptions): AppManagedToolSet {
  const tools = LOOK_MEDIA_TOOL_PLUGIN.createTools(
    buildLookHostPort({
      ...options,
      mode: options.folder === undefined ? "chat" : "work",
      isAvailable: () => true,
    }),
  );
  if (tools === undefined) {
    throw new Error("Built-in look media tool plugin was unexpectedly unavailable.");
  }
  return adaptMediaToolSet({ tools });
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
  /** The thread whose spend a describe counts against. */
  readonly threadId: string;
  /** Whose model reads the answer, when that is not the thread's own: a child run. */
  readonly readerId?: string;
  readonly threadType: ImageDescriptionScope["threadType"];
  readonly projectId?: ProjectId | undefined;
  readonly threadModel: string;
  readonly readsImages: boolean;
  readonly attachment?: LookToolOptions["attachment"];
  readonly folder?: string | undefined;
  readonly recordExternalContentIngestion?: TaintAppManagedToolResultsInput["recordExternalContentIngestion"];
  readonly uuid: () => string;
}): AppManagedToolSet | undefined {
  const mode: OctantMode =
    input.threadType === "chat-thread"
      ? "chat"
      : input.threadType === "work-thread"
        ? "work"
        : "code";
  const tools = LOOK_MEDIA_TOOL_PLUGIN.createTools(
    buildLookHostPort({
      mode,
      isAvailable: () =>
        !input.readsImages &&
        input.describer.available({
          projectId: input.projectId,
          threadModel: input.threadModel,
        }).kind === "available",
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
    }),
  );
  if (tools === undefined) return undefined;
  return adaptMediaToolSet({
    tools,
    threadId: input.readerId ?? input.threadId,
    ...(input.recordExternalContentIngestion === undefined
      ? {}
      : { recordExternalContentIngestion: input.recordExternalContentIngestion }),
    uuid: input.uuid,
  });
}
