/**
 * Host-side bridge, validation, registration, and built-in media tool plugins
 * over the public `@octant/plugin-api/media-tools` port.
 *
 * Every built-in media tool (`octant_transcribe`, `octant_look`,
 * `octant_create_image`) and any third-party media tool plugin composes its
 * tool definitions and execution strictly through `MediaToolHostPort`.
 * Confinement, raw media bytes, provider credentials, paid offers, concurrency
 * gates, outside-content tainting, and live admission stay host-owned.
 */
import {
  decodeBrowserCaptureId,
  decodeCodeRelativePath,
  decodeImageArtifactId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeSpeechTranscriptionLanguage,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_REFERENCE_LABEL_LENGTH,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_VARIANTS,
  MAX_LOOK_QUESTION_CHARACTERS,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  type CodeRelativePath,
  type ImageArtifactId,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderToolDefinition,
  type SpeechTranscriptionLanguage,
} from "@octant/contracts";
import {
  MEDIA_TOOL_CONTRIBUTION_KIND,
  type MediaDescribableImageType,
  type MediaImageReferenceInput,
  type MediaToolHostPort,
  type MediaToolPluginDefinition,
  type MediaToolResult,
  type MediaToolSet,
} from "@octant/plugin-api/media-tools";

export const TRANSCRIBE_TOOL_NAME = "octant_transcribe" as const;
export const LOOK_TOOL_NAME = "octant_look" as const;
export const CREATE_IMAGE_TOOL_NAME = "octant_create_image" as const;

export const BUILTIN_MEDIA_TOOL_NAMES = [
  TRANSCRIBE_TOOL_NAME,
  LOOK_TOOL_NAME,
  CREATE_IMAGE_TOOL_NAME,
] as const;

/** Host guide lines for the three built-in media tools, 40 tokens or fewer each. */
export const TRANSCRIBE_TOOL_HOST_LINE =
  "Transcribe a recording from this thread's folder with octant_transcribe instead of installing speech models; page long transcripts with nextOffset.";

export const LOOK_TOOL_HOST_LINE =
  "When you cannot read an image yourself, have octant_look ask the Sees images model to describe it, with your question if you have one.";

export const CREATE_IMAGE_TOOL_HOST_LINE =
  "Call octant_create_image when the person asks for a picture instead of drawing it as SVG or HTML. To restyle photos or screenshots, use references, which always need confirmation. Keep SVG for logos, icons, and diagrams.";

export const MEDIA_TOOL_HOST_LINES: Readonly<Record<string, string>> = {
  [CREATE_IMAGE_TOOL_NAME]: CREATE_IMAGE_TOOL_HOST_LINE,
  [LOOK_TOOL_NAME]: LOOK_TOOL_HOST_LINE,
  [TRANSCRIBE_TOOL_NAME]: TRANSCRIBE_TOOL_HOST_LINE,
};

export interface MediaToolActivationFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly enabled: boolean;
}

export type MediaToolPluginOffer =
  | { readonly status: "offered" }
  | {
      readonly status: "withheld";
      readonly reason: "not-installed" | "not-trusted" | "disabled";
    };

/** Installation, trust, and enablement stay separate preconditions for contributed media tools. */
export function offerMediaToolPlugin(facts: MediaToolActivationFacts): MediaToolPluginOffer {
  if (!facts.installed) return { status: "withheld", reason: "not-installed" };
  if (!facts.trusted) return { status: "withheld", reason: "not-trusted" };
  if (!facts.enabled) return { status: "withheld", reason: "disabled" };
  return { status: "offered" };
}

/** Names for contributed media tools are assigned from host-owned identity, never supplied by a package. */
export function contributedMediaToolName(
  packageId: string,
  componentId: string,
  toolIndex?: number,
): string {
  const base = `octant_plugin_${packageId.replaceAll("-", "")}_${componentId.replaceAll("-", "_")}`;
  return toolIndex === undefined ? base : `${base}_${String(toolIndex)}`;
}

export function isReservedBuiltinMediaToolName(name: string): boolean {
  return (BUILTIN_MEDIA_TOOL_NAMES as ReadonlyArray<string>).includes(name);
}

const textEncoder = new TextEncoder();
const TRANSCRIPTION_PAGE_SIZE = 32_000;
const MAX_SAVE_PATH_CHARACTERS = 512;
const MAX_WORK_RELATIVE_PATH_BYTES = 4_096;

const LOOK_MEDIA_BY_EXTENSION: Readonly<Record<string, MediaDescribableImageType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

const LOOK_DESCRIPTION =
  'Your model cannot read images. Ask the Sees images model to look at one for you: an image attached to this thread, by the attachment id its description names ("[Image <name> (attachment <id>), …]"), or an image file inside this thread\'s folder, by a path relative to it, with an optional question. You get its description in words, marked with the model that described it. No URLs and no paths outside the folder.';

const LOOK_INPUT_SCHEMA = {
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

const IMAGE_DESCRIPTION =
  "Generate or revise a picture (a photo, illustration, or rendered scene) with an image model the person set up in Octant. Call it when the person asks for an image instead of drawing one yourself as SVG, HTML, or CSS: a real image model gives a far better result. Keep SVG for logos, icons, and diagrams, or when the person asks for it. Octant shows the person a card in this thread where they pick the model and confirm, because each generation is billed to their image provider; nothing runs until they answer, unless they already said not to ask again or the thread runs at Full access, where it uses the profile the person named in Settings (else the first one set up) on its default model. Describe the image in prompt; profileInstanceId and modelId only suggest what the card preselects. To revise a generated image, pass its parentAttachmentId. Use references to include up to four images: attachment for the latest photos, generated-image by attachmentId, or in Work and Code browser-capture by captureId or file by relativePath. References always require confirmation. Never pass credentials, endpoints, or absolute paths. The result says what happened: completed with each image's attachmentId (the images are shown in this thread, and to you when you can read images; use an attachmentId to revise one, to place it in a Canvas design as a generated-image asset, or to save it), failed with the reason, generating with a jobId when it takes longer than the call waits (it appears in this thread when done; do not start another), agent-draws (the person wants you to make the visual yourself), or cancelled (do not ask again unless they do). In a Work or Code thread, operation save with an attachmentId from this thread and a relativePath stores that image as a new file in the folder you work in: it never overwrites a file, Plan refuses it, and at Ask first the person confirms the path. Never invent an image URL.";

const IMAGE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["generate", "save"] },
    prompt: { type: "string" },
    profileInstanceId: { type: "string" },
    modelId: { type: "string" },
    variantCount: { type: "number" },
    parentAttachmentId: { type: "string" },
    references: {
      type: "array",
      maxItems: MAX_IMAGE_REFERENCES,
      items: {
        type: "object",
        properties: {
          kind: { enum: ["attachment", "browser-capture", "file", "generated-image"] },
          captureId: { type: "string" },
          relativePath: { type: "string" },
          attachmentId: { type: "string" },
        },
        required: ["kind"],
        additionalProperties: false,
      },
    },
    attachmentId: { type: "string" },
    relativePath: { type: "string" },
  },
} as const;

const FORBIDDEN_IMAGE_INPUT_KEYS = [
  "apiKey",
  "credential",
  "credentials",
  "endpoint",
  "baseUrl",
  "header",
  "headers",
  "path",
  "filePath",
  "canonicalRoot",
] as const;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combineSignals(stopped: AbortSignal, callSignal: AbortSignal | undefined): AbortSignal {
  return callSignal === undefined ? stopped : AbortSignal.any([stopped, callSignal]);
}

function transcriptionRefused(reason: string): MediaToolResult {
  return { isError: true, result: { status: "refused", reason } };
}

function parseTranscriptionInput(json: string):
  | {
      readonly relativePath: CodeRelativePath;
      readonly offset: number;
      readonly language: SpeechTranscriptionLanguage | undefined;
    }
  | undefined {
  try {
    const raw: unknown = JSON.parse(json);
    if (
      !isPlainObject(raw) ||
      !("relativePath" in raw) ||
      Object.keys(raw).some((key) => !["relativePath", "language", "offset"].includes(key))
    ) {
      return undefined;
    }
    const relativePath = decodeCodeRelativePath(raw["relativePath"]);
    if (relativePath.length > 512 || /^[a-z][a-z0-9+.-]*:/i.test(relativePath)) return undefined;
    const offset = "offset" in raw ? raw["offset"] : 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
      return undefined;
    }
    return {
      relativePath,
      offset,
      language: "language" in raw ? decodeSpeechTranscriptionLanguage(raw["language"]) : undefined,
    };
  } catch {
    return undefined;
  }
}

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function pageTranscript(text: string, offset: number): MediaToolResult {
  if (offset > text.length) {
    return transcriptionRefused("The offset is past the end of this transcript.");
  }
  const resultAt = (next: number) => ({
    status: "transcribed",
    text: text.slice(offset, next),
    characters: text.length,
    truncated: next < text.length,
    ...(next < text.length ? { nextOffset: next } : {}),
  });
  let end = Math.min(text.length, offset + TRANSCRIPTION_PAGE_SIZE);
  if (utf8ByteLength(JSON.stringify(resultAt(end))) > MAX_PROVIDER_TOOL_RESULT_BYTES) {
    let lo = offset;
    while (lo < end) {
      const mid = Math.ceil((lo + end) / 2);
      if (utf8ByteLength(JSON.stringify(resultAt(mid))) <= MAX_PROVIDER_TOOL_RESULT_BYTES) {
        lo = mid;
      } else {
        end = mid - 1;
      }
    }
  }
  // Offsets follow JavaScript string indices; do not split a character across two tool answers.
  if (end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
  return { result: resultAt(end) };
}

/**
 * Built-in audio transcription media tool plugin (`octant_transcribe`),
 * composed strictly over `MediaToolHostPort.transcription`.
 */
export const TRANSCRIBE_MEDIA_TOOL_PLUGIN: MediaToolPluginDefinition = {
  kind: MEDIA_TOOL_CONTRIBUTION_KIND,
  id: "transcribe",
  modes: ["work", "code"],
  createTools: (port) => {
    const transcription = port.transcription;
    if (
      transcription === undefined ||
      !TRANSCRIBE_MEDIA_TOOL_PLUGIN.modes.includes(port.turn.mode) ||
      port.turn.unattended ||
      port.turn.inPlan() ||
      !transcription.isAvailable()
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    let closing: Promise<void> | undefined;
    return {
      definitions: [
        {
          name: TRANSCRIBE_TOOL_NAME,
          description:
            "Transcribe an audio file in this thread's folder using the person's Voice endpoint. Use nextOffset to page without another provider call.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              relativePath: { type: "string" },
              language: { type: "string" },
              offset: { type: "integer", minimum: 0 },
            },
            required: ["relativePath"],
          },
        },
      ],
      taintPolicy: "outside-content",
      close: () => {
        stopped.abort();
        closing ??= Promise.resolve(port.close?.());
        return closing;
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        const allowed = () => !signal.aborted && !port.turn.inPlan() && port.turn.allowed();
        if (call.name !== TRANSCRIBE_TOOL_NAME || !allowed()) {
          return transcriptionRefused("Transcription is unavailable for this turn.");
        }
        const args = parseTranscriptionInput(call.inputJson);
        if (args === undefined) {
          return transcriptionRefused(
            "Name a relative audio file in this thread's folder, with an optional language and nonnegative offset.",
          );
        }
        const outcome = await transcription.transcribe({
          relativePath: args.relativePath,
          ...(args.language === undefined ? {} : { language: args.language }),
          allowFreshRequest: args.offset === 0,
          signal,
        });
        if (!allowed()) {
          return transcriptionRefused("The turn can no longer receive this transcript.");
        }
        switch (outcome.status) {
          case "cache-miss":
            return transcriptionRefused(
              "This page is no longer cached. Start at offset 0 to request transcription again.",
            );
          case "refused":
            return transcriptionRefused(outcome.reason);
          case "busy":
            return { isError: true, result: { status: "busy", reason: outcome.reason } };
          case "failed":
            return { isError: true, result: { status: "failed", reason: outcome.reason } };
          case "transcribed":
            return pageTranscript(outcome.text, args.offset);
        }
      },
    };
  },
};

export interface LookToolInput {
  readonly image: string;
  readonly question?: string;
}

export function parseLookToolInput(inputJson: string): LookToolInput | { readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "The look input is not valid JSON." };
  }
  if (!isPlainObject(raw)) {
    return { error: "The look input must be an object with image and an optional question." };
  }
  const extra = Object.keys(raw).filter((key) => key !== "image" && key !== "question");
  if (extra.length > 0) return { error: "The look input takes only image and question." };
  const image = raw["image"];
  if (typeof image !== "string" || image.trim().length === 0 || image.length > 1_024) {
    return {
      error: "image must name an attachment id or a file path inside this thread's folder.",
    };
  }
  const question = raw["question"];
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

function errorResult(error: string): MediaToolResult {
  return { result: { error }, isError: true };
}

/**
 * Built-in image description media tool plugin (`octant_look`), composed
 * strictly over `MediaToolHostPort.imageDescription`.
 */
export const LOOK_MEDIA_TOOL_PLUGIN: MediaToolPluginDefinition = {
  kind: MEDIA_TOOL_CONTRIBUTION_KIND,
  id: "look",
  modes: ["chat", "work", "code"],
  createTools: (port) => {
    const imageDescription = port.imageDescription;
    if (
      imageDescription === undefined ||
      !LOOK_MEDIA_TOOL_PLUGIN.modes.includes(port.turn.mode) ||
      !imageDescription.isAvailable()
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    let closing: Promise<void> | undefined;
    return {
      definitions: [
        { name: LOOK_TOOL_NAME, description: LOOK_DESCRIPTION, inputSchema: LOOK_INPUT_SCHEMA },
      ],
      taintPolicy: "watcher-only",
      close: () => {
        stopped.abort();
        closing ??= Promise.resolve(port.close?.());
        return closing;
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        if (call.name !== LOOK_TOOL_NAME || signal.aborted || !port.turn.allowed()) {
          return errorResult("tool-unavailable");
        }
        const parsed = parseLookToolInput(call.inputJson);
        if ("error" in parsed) return errorResult(parsed.error);
        const question = parsed.question === undefined ? {} : { question: parsed.question };
        const attached = await imageDescription.describeAttachment({
          attachmentId: parsed.image,
          ...question,
          signal,
        });
        if (attached.status === "described") {
          return {
            result: {
              image: attached.imageName,
              described_by: `${attached.describedBy.model} (${attached.describedBy.provider})`,
              description: attached.description,
            },
          };
        }
        if (attached.status === "refused") return errorResult(attached.reason);
        if (/^[a-z][a-z0-9+.-]*:/i.test(parsed.image)) {
          return errorResult(
            "look reads no URL; name an attachment or a file inside this thread's folder.",
          );
        }
        if (!port.turn.hasFolder) {
          return errorResult(
            "No attachment of this thread has that id, and this thread has no folder.",
          );
        }
        let path: CodeRelativePath;
        try {
          path = decodeCodeRelativePath(parsed.image.replace(/^\.\//, ""));
        } catch {
          return errorResult(
            "The path must be relative to this thread's folder, with no .. and no leading /.",
          );
        }
        const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
        const mediaType = LOOK_MEDIA_BY_EXTENSION[extension];
        if (mediaType === undefined) {
          return errorResult("look reads PNG, JPEG, GIF, or WebP files.");
        }
        const outcome = await imageDescription.describeFolderImage({
          relativePath: path,
          mediaType,
          ...question,
          signal,
        });
        if (outcome.status === "refused") return errorResult(outcome.reason);
        return {
          result: {
            image: outcome.imageName,
            described_by: `${outcome.describedBy.model} (${outcome.describedBy.provider})`,
            description: outcome.description,
          },
        };
      },
    };
  },
};

interface ParsedImageGenerateInput {
  readonly operation: "generate";
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  readonly variantCount?: number;
  readonly parentAttachmentId?: ImageArtifactId;
  readonly references: ReadonlyArray<MediaImageReferenceInput>;
}

interface ParsedImageSaveInput {
  readonly operation: "save";
  readonly attachmentId: ImageArtifactId;
  readonly relativePath: string;
}

function canonicalizeRelativeReferencePath(raw: string): string | undefined {
  if (
    raw.length === 0 ||
    raw.includes("\0") ||
    raw.includes("\\") ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.normalize("NFC") !== raw ||
    utf8ByteLength(raw) > MAX_WORK_RELATIVE_PATH_BYTES
  ) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

function parseImageReferenceInputs(
  value: unknown,
): ReadonlyArray<MediaImageReferenceInput> | { readonly error: string } {
  if (!Array.isArray(value) || value.length > MAX_IMAGE_REFERENCES) {
    return { error: "Use at most four image references." };
  }
  const requests: MediaImageReferenceInput[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "An image reference is invalid." };
    const { kind, ...fields } = item;
    try {
      if (kind === "attachment" && Object.keys(fields).length === 0) {
        requests.push({ kind });
      } else if (kind === "browser-capture" && Object.keys(fields).length === 1) {
        requests.push({ kind, captureId: decodeBrowserCaptureId(fields["captureId"]) });
      } else if (kind === "generated-image" && Object.keys(fields).length === 1) {
        requests.push({ kind, attachmentId: decodeImageArtifactId(fields["attachmentId"]) });
      } else if (
        kind === "file" &&
        Object.keys(fields).length === 1 &&
        typeof fields["relativePath"] === "string" &&
        fields["relativePath"].trim().length > 0 &&
        fields["relativePath"].length <= MAX_IMAGE_REFERENCE_LABEL_LENGTH
      ) {
        const canonical = canonicalizeRelativeReferencePath(fields["relativePath"]);
        if (canonical === undefined) {
          return { error: "The image reference must be inside this thread's folder." };
        }
        requests.push({ kind, relativePath: canonical });
      } else {
        return { error: "An image reference is invalid." };
      }
    } catch {
      return { error: "An image reference is invalid." };
    }
  }
  return requests;
}

function parseImageToolInput(
  inputJson: string,
): ParsedImageGenerateInput | ParsedImageSaveInput | { readonly error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "Image tool input is not valid JSON." };
  }
  if (!isPlainObject(raw)) {
    return { error: "Image tool input is invalid." };
  }
  for (const key of FORBIDDEN_IMAGE_INPUT_KEYS) {
    if (key in raw) {
      return { error: "Image generation cannot take credentials, endpoints, or filesystem paths." };
    }
  }
  const operation = raw["operation"] ?? "generate";
  if (operation === "save") {
    const attachmentId = raw["attachmentId"];
    const relativePath = raw["relativePath"];
    if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
      return { error: "A save needs relativePath, a path inside this thread's folder." };
    }
    if (relativePath.length > MAX_SAVE_PATH_CHARACTERS) {
      return { error: "The save path is too long." };
    }
    try {
      return {
        operation: "save",
        attachmentId: decodeImageArtifactId(attachmentId),
        relativePath: relativePath.trim(),
      };
    } catch {
      return { error: "A save needs the attachmentId of a finished image on this thread." };
    }
  }
  if (operation !== "generate") return { error: "The operation is generate or save." };
  const prompt = raw["prompt"];
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { error: "The image prompt must not be empty." };
  }
  if (prompt.length > MAX_IMAGE_PROMPT_CHARACTERS) {
    return { error: "The image prompt exceeded the length limit." };
  }
  const variantCount = raw["variantCount"];
  if (variantCount !== undefined) {
    if (
      typeof variantCount !== "number" ||
      !Number.isSafeInteger(variantCount) ||
      variantCount < 1 ||
      variantCount > MAX_IMAGE_VARIANTS
    ) {
      return { error: "The requested variant count is not supported." };
    }
  }
  const profileInstanceId = raw["profileInstanceId"];
  const modelId = raw["modelId"];
  const parentAttachmentId = raw["parentAttachmentId"];
  const references =
    raw["references"] === undefined ? [] : parseImageReferenceInputs(raw["references"]);
  if ("error" in references) return references;
  try {
    return {
      operation: "generate",
      prompt: prompt.trim(),
      references,
      ...(profileInstanceId === undefined
        ? {}
        : { profileInstanceId: decodeProviderInstanceId(profileInstanceId) }),
      ...(modelId === undefined ? {} : { modelId: decodeProviderModelId(modelId) }),
      ...(variantCount === undefined ? {} : { variantCount }),
      ...(parentAttachmentId === undefined
        ? {}
        : { parentAttachmentId: decodeImageArtifactId(parentAttachmentId) }),
    };
  } catch {
    return { error: "One of the image generation identifiers is invalid." };
  }
}

/**
 * Built-in image generation media tool plugin (`octant_create_image`),
 * composed strictly over `MediaToolHostPort.imageGeneration`.
 */
export const CREATE_IMAGE_MEDIA_TOOL_PLUGIN: MediaToolPluginDefinition = {
  kind: MEDIA_TOOL_CONTRIBUTION_KIND,
  id: "create-image",
  modes: ["chat", "work", "code"],
  createTools: (port) => {
    const imageGeneration = port.imageGeneration;
    if (
      imageGeneration === undefined ||
      !CREATE_IMAGE_MEDIA_TOOL_PLUGIN.modes.includes(port.turn.mode) ||
      !imageGeneration.isAvailable()
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    let closing: Promise<void> | undefined;
    return {
      definitions: [
        {
          name: CREATE_IMAGE_TOOL_NAME,
          description: IMAGE_DESCRIPTION,
          inputSchema: IMAGE_INPUT_SCHEMA,
        },
      ],
      taintPolicy: "none",
      close: () => {
        stopped.abort();
        closing ??= Promise.resolve(port.close?.());
        return closing;
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        if (call.name !== CREATE_IMAGE_TOOL_NAME || !port.turn.allowed()) {
          return errorResult("tool-unavailable");
        }
        const refusal = imageGeneration.refusal?.();
        if (refusal !== undefined) return errorResult(refusal);
        const parsed = parseImageToolInput(call.inputJson);
        if ("error" in parsed) return errorResult(parsed.error);
        if (parsed.operation === "save") {
          if (imageGeneration.save === undefined) {
            return errorResult(
              "This thread has no folder to save into. Chat images stay in the thread.",
            );
          }
          const saved = await imageGeneration.save({
            attachmentId: parsed.attachmentId,
            relativePath: parsed.relativePath,
            signal,
          });
          switch (saved.status) {
            case "saved":
              return { result: { status: "saved", relativePath: saved.relativePath } };
            case "not-saved":
              return {
                result: {
                  status: "not-saved",
                  message: "The person did not save the image. Do not ask again unless they do.",
                },
              };
            case "refused":
              return {
                result:
                  saved.saveStatus === undefined
                    ? { error: saved.error }
                    : { status: saved.saveStatus, error: saved.error },
                isError: true,
              };
          }
        }
        const outcome = await imageGeneration.generate({
          prompt: parsed.prompt,
          references: parsed.references,
          ...(parsed.profileInstanceId === undefined
            ? {}
            : { profileInstanceId: parsed.profileInstanceId }),
          ...(parsed.modelId === undefined ? {} : { modelId: parsed.modelId }),
          ...(parsed.variantCount === undefined ? {} : { variantCount: parsed.variantCount }),
          ...(parsed.parentAttachmentId === undefined
            ? {}
            : { parentAttachmentId: parsed.parentAttachmentId }),
          signal,
        });
        switch (outcome.status) {
          case "completed": {
            const images = outcome.images ?? [];
            return {
              result: {
                status: "completed",
                jobId: outcome.jobId,
                modelId: outcome.modelId,
                profileInstanceId: outcome.profileInstanceId,
                images: outcome.artifacts.map((artifact) => ({
                  attachmentId: artifact.attachmentId,
                  mime: artifact.mime,
                  size: artifact.size,
                })),
                message:
                  images.length > 0
                    ? outcome.withheldCount === 0
                      ? "The images are shown in this thread and attached to this result."
                      : `The images are shown in this thread; ${String(outcome.withheldCount)} could not be attached to this result because of its size or format.`
                    : "The images are shown in this thread. You were not shown them, so do not describe what they look like.",
              },
              ...(images.length === 0 ? {} : { images }),
            };
          }
          case "generating":
            return {
              result: {
                status: "generating",
                jobId: outcome.jobId,
                modelId: outcome.modelId,
                profileInstanceId: outcome.profileInstanceId,
                message:
                  "The image is still being generated. It appears in this thread when it finishes; do not start another for the same request.",
              },
            };
          case "agent-draws":
            return {
              result: {
                status: "agent-draws",
                message:
                  "The person chose not to use an image model for this. Make the visual yourself if the request still calls for one.",
              },
            };
          case "cancelled":
            if (outcome.reason === "aborted") return { result: { status: "cancelled" } };
            if (outcome.jobId !== undefined) {
              return {
                result: {
                  status: "cancelled",
                  jobId: outcome.jobId,
                  message: "The generation was cancelled.",
                },
              };
            }
            return {
              result: {
                status: "cancelled",
                message:
                  "The person did not start the image generation. Do not ask again unless they do.",
              },
            };
          case "failed":
            return {
              result: {
                status: "failed",
                jobId: outcome.jobId,
                message: outcome.message,
              },
              isError: true,
            };
          case "refused":
            return errorResult(outcome.error);
        }
      },
    };
  },
};

export const BUILTIN_MEDIA_TOOL_PLUGINS: ReadonlyArray<MediaToolPluginDefinition> = [
  TRANSCRIBE_MEDIA_TOOL_PLUGIN,
  LOOK_MEDIA_TOOL_PLUGIN,
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
];

function isValidContributedDefinition(definition: ProviderToolDefinition): boolean {
  return (
    definition.name.trim().length > 0 &&
    typeof definition.description === "string" &&
    definition.description.trim().length > 0 &&
    isPlainObject(definition.inputSchema)
  );
}

const CONTRIBUTED_REFUSED: MediaToolResult = {
  result: { status: "refused" },
  isError: true,
};

/**
 * Wraps a third-party media tool plugin behind host-owned naming, activation
 * gating, live authority checks, and fail-closed outside-content tainting.
 */
export function createContributedMediaTool(input: {
  readonly packageId: string;
  readonly componentId: string;
  readonly plugin: MediaToolPluginDefinition;
  readonly facts: MediaToolActivationFacts;
  readonly port: MediaToolHostPort;
}): MediaToolSet | undefined {
  if (offerMediaToolPlugin(input.facts).status !== "offered") return undefined;
  if (input.plugin.kind !== MEDIA_TOOL_CONTRIBUTION_KIND) return undefined;
  if (!input.plugin.modes.includes(input.port.turn.mode)) return undefined;
  const inner = input.plugin.createTools(input.port);
  if (inner === undefined || inner.definitions.length === 0) return undefined;
  const seenInternal = new Set<string>();
  const routed = new Map<string, string>();
  const definitions: ProviderToolDefinition[] = [];
  for (let index = 0; index < inner.definitions.length; index += 1) {
    const definition = inner.definitions[index];
    if (
      definition === undefined ||
      !isValidContributedDefinition(definition) ||
      seenInternal.has(definition.name)
    ) {
      return undefined;
    }
    seenInternal.add(definition.name);
    const assignedName = contributedMediaToolName(
      input.packageId,
      input.componentId,
      inner.definitions.length === 1 ? undefined : index,
    );
    if (isReservedBuiltinMediaToolName(assignedName)) return undefined;
    routed.set(assignedName, definition.name);
    definitions.push({ ...definition, name: assignedName });
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    definitions,
    // Third-party media tools can never opt out of outside-content tainting.
    taintPolicy: "outside-content",
    close: () => {
      closed = true;
      closing ??= Promise.all([inner.close(), input.port.close?.()]).then(() => undefined);
      return closing;
    },
    execute: async (call) => {
      const targetName = routed.get(call.name);
      const isAborted = () => call.signal?.aborted === true;
      if (targetName === undefined || closed || isAborted() || !input.port.turn.allowed()) {
        return CONTRIBUTED_REFUSED;
      }
      const outcome = await inner.execute({ ...call, name: targetName });
      if (closed || isAborted() || !input.port.turn.allowed()) {
        return CONTRIBUTED_REFUSED;
      }
      return outcome;
    },
  };
}

export interface ContributedMediaToolRegistration {
  readonly packageId: string;
  readonly componentId: string;
  readonly plugin: MediaToolPluginDefinition;
  readonly facts: MediaToolActivationFacts;
}

/**
 * Activates non-colliding contributed media tool plugins for one turn port.
 * Duplicate `(packageId, componentId)` claims are both withheld so a turn never
 * silently routes to a different plugin.
 */
export function registerContributedMediaTools(input: {
  readonly contributions: ReadonlyArray<ContributedMediaToolRegistration>;
  readonly port: MediaToolHostPort;
}): ReadonlyArray<MediaToolSet> {
  const claims = new Map<string, number>();
  for (const contribution of input.contributions) {
    const key = `${contribution.packageId}:${contribution.componentId}`;
    claims.set(key, (claims.get(key) ?? 0) + 1);
  }
  const active: MediaToolSet[] = [];
  for (const contribution of input.contributions) {
    const key = `${contribution.packageId}:${contribution.componentId}`;
    if (claims.get(key) !== 1) continue;
    const set = createContributedMediaTool({ ...contribution, port: input.port });
    if (set !== undefined) active.push(set);
  }
  return active;
}
