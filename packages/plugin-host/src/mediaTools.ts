/**
 * Host-side bridge, validation, registration, and built-in media tool plugins
 * over the public `@octant/plugin-api/media-tools` port.
 *
 * Every built-in media tool (`octant_transcribe`, `octant_narrate`,
 * `octant_look`, `octant_create_image`) and any third-party media tool plugin
 * composes its tool definitions and execution strictly through
 * `MediaToolHostPort`. Confinement, raw media bytes, provider credentials,
 * paid offers, concurrency gates, outside-content tainting, and live admission
 * stay host-owned.
 */
import {
  decodeBrowserCaptureId,
  decodeCodeRelativePath,
  decodeImageArtifactId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeSpeechSynthesisFormat,
  decodeSpeechTranscriptionLanguage,
  decodeVideoClipId,
  MAX_IMAGE_PROMPT_CHARACTERS,
  MAX_IMAGE_REFERENCE_LABEL_LENGTH,
  MAX_IMAGE_REFERENCES,
  MAX_IMAGE_VARIANTS,
  MAX_LOOK_QUESTION_CHARACTERS,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  MAX_VIDEO_REFERENCES,
  SPEECH_SYNTHESIS_FORMATS,
  SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS,
  type CodeRelativePath,
  type ImageArtifactId,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderToolDefinition,
  type SpeechSynthesisFormat,
  type SpeechTranscriptionLanguage,
  type VideoClipId,
} from "@octant/contracts";
import {
  MEDIA_ICON_SET_TARGETS,
  MEDIA_TOOL_CONTRIBUTION_KIND,
  type MediaDescribableImageType,
  type MediaIconSetTarget,
  type MediaImageReferenceInput,
  type MediaToolHostPort,
  type MediaToolPluginDefinition,
  type MediaToolResult,
  type MediaToolSet,
  type MediaVideoGenerateRequest,
} from "@octant/plugin-api/media-tools";

export const TRANSCRIBE_TOOL_NAME = "octant_transcribe" as const;
export const NARRATE_TOOL_NAME = "octant_narrate" as const;
export const LOOK_TOOL_NAME = "octant_look" as const;
export const CREATE_IMAGE_TOOL_NAME = "octant_create_image" as const;
export const CREATE_VIDEO_TOOL_NAME = "octant_create_video" as const;

export const BUILTIN_MEDIA_TOOL_NAMES = [
  TRANSCRIBE_TOOL_NAME,
  NARRATE_TOOL_NAME,
  LOOK_TOOL_NAME,
  CREATE_IMAGE_TOOL_NAME,
  CREATE_VIDEO_TOOL_NAME,
] as const;

/** Host guide lines for the built-in media tools, 40 tokens or fewer each. */
export const TRANSCRIBE_TOOL_HOST_LINE =
  "Transcribe a recording from this thread's folder with octant_transcribe instead of installing speech models; page long transcripts with nextOffset.";

export const NARRATE_TOOL_HOST_LINE =
  "Turn text into a spoken audio file in this thread's folder with octant_narrate instead of installing speech tools.";

export const LOOK_TOOL_HOST_LINE =
  "When you cannot read an image yourself, have octant_look ask the Sees images model to describe it, with your question if you have one.";

export const CREATE_IMAGE_TOOL_HOST_LINE =
  "Call octant_create_image when the person asks for a picture instead of drawing it as SVG or HTML. To restyle photos or screenshots, use references, which always need confirmation. Keep SVG for logos, icons, and diagrams.";

export const CREATE_VIDEO_TOOL_HOST_LINE =
  "Use octant_create_video only when asked for a video clip; clips are billed.";

export const MEDIA_TOOL_HOST_LINES: Readonly<Record<string, string>> = {
  [CREATE_IMAGE_TOOL_NAME]: CREATE_IMAGE_TOOL_HOST_LINE,
  [CREATE_VIDEO_TOOL_NAME]: CREATE_VIDEO_TOOL_HOST_LINE,
  [LOOK_TOOL_NAME]: LOOK_TOOL_HOST_LINE,
  [NARRATE_TOOL_NAME]: NARRATE_TOOL_HOST_LINE,
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
const MAX_ICON_SET_DIRECTORY_CHARACTERS = 400;
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

/**
 * Said only where the host offers icon sets, so a model is never told about
 * an operation its host cannot run.
 */
const ICON_SET_DESCRIPTION =
  " Operation icon-set with an attachmentId from this thread, a target (apple-ios, apple-macos, android, or web), and a directory relative to the folder you work in (for example App/Assets.xcassets, app/src/main/res, public, or . for the folder itself) resizes that image into every size the target needs, with the Xcode Contents.json where it applies; use it for an app icon or favicons instead of resizing by hand. The image must be square and at least 1024 pixels, and must show no transparency for apple-ios. It writes only new files: if any of them already exists nothing is written. Plan refuses it, and at Ask first the person confirms the directory. For web the result includes the <link> tags and manifest icons to place yourself.";

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
          name: { type: "string" },
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

const IMAGE_WITH_ICON_SET_INPUT_SCHEMA = {
  ...IMAGE_INPUT_SCHEMA,
  properties: {
    ...IMAGE_INPUT_SCHEMA.properties,
    operation: { type: "string", enum: ["generate", "save", "icon-set"] },
    target: { type: "string", enum: MEDIA_ICON_SET_TARGETS },
    directory: { type: "string" },
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

function isIconSetTarget(value: unknown): value is MediaIconSetTarget {
  return MEDIA_ICON_SET_TARGETS.some((target) => target === value);
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
      close: async () => {
        stopped.abort();
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

const NARRATION_FORMAT_EXTENSIONS: Readonly<Record<SpeechSynthesisFormat, string>> = {
  mp3: ".mp3",
  wav: ".wav",
  opus: ".ogg",
};

const NARRATION_TOO_LONG_REASON =
  "Split the text into parts of at most 4,096 characters and narrate each to its own file.";

type ParsedNarrationInput =
  | {
      readonly ok: true;
      readonly text: string;
      readonly relativePath: CodeRelativePath;
      readonly format: SpeechSynthesisFormat;
    }
  | { readonly ok: false; readonly reason: string };

function parseNarrationInput(json: string): ParsedNarrationInput {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Provide text and a relativePath inside this thread's folder." };
  }
  if (
    !isPlainObject(raw) ||
    !("text" in raw) ||
    !("relativePath" in raw) ||
    Object.keys(raw).some((key) => !["text", "relativePath", "format"].includes(key))
  ) {
    return {
      ok: false,
      reason: "Provide text, a relativePath inside this thread's folder, and an optional format.",
    };
  }
  if (typeof raw["text"] !== "string") return { ok: false, reason: "Provide text to narrate." };
  if (raw["text"].length > SPEECH_SYNTHESIS_MAX_TEXT_CHARACTERS) {
    return { ok: false, reason: NARRATION_TOO_LONG_REASON };
  }
  const text = raw["text"].trim();
  if (text.length === 0) return { ok: false, reason: "Provide text to narrate." };

  let format: SpeechSynthesisFormat = "mp3";
  if ("format" in raw && raw["format"] !== undefined) {
    try {
      format = decodeSpeechSynthesisFormat(raw["format"]);
    } catch {
      return { ok: false, reason: "Format must be mp3, wav, or opus." };
    }
  }

  const rawPath = raw["relativePath"];
  if (typeof rawPath !== "string" || /^[a-z][a-z0-9+.-]*:/i.test(rawPath)) {
    return { ok: false, reason: "The save path is outside the folder." };
  }
  const canonical = canonicalizeRelativeReferencePath(rawPath);
  if (canonical === undefined) {
    return { ok: false, reason: "The save path is outside the folder." };
  }
  let relativePath: CodeRelativePath;
  try {
    relativePath = decodeCodeRelativePath(canonical);
  } catch {
    return { ok: false, reason: "The save path is outside the folder." };
  }
  if (relativePath.length > MAX_SAVE_PATH_CHARACTERS) {
    return { ok: false, reason: "The save path is too long." };
  }

  const expectedExtension = NARRATION_FORMAT_EXTENSIONS[format];
  if (!relativePath.toLowerCase().endsWith(expectedExtension)) {
    return {
      ok: false,
      reason: `Format ${format} requires a ${expectedExtension} file extension.`,
    };
  }
  return { ok: true, text, relativePath, format };
}

/**
 * Built-in text-to-speech narration media tool plugin (`octant_narrate`),
 * composed strictly over `MediaToolHostPort.narration`.
 */
export const NARRATE_MEDIA_TOOL_PLUGIN: MediaToolPluginDefinition = {
  kind: MEDIA_TOOL_CONTRIBUTION_KIND,
  id: "narrate",
  modes: ["work", "code"],
  createTools: (port) => {
    const narration = port.narration;
    if (
      narration === undefined ||
      !NARRATE_MEDIA_TOOL_PLUGIN.modes.includes(port.turn.mode) ||
      port.turn.unattended ||
      port.turn.inPlan() ||
      !narration.isAvailable()
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    return {
      definitions: [
        {
          name: NARRATE_TOOL_NAME,
          description:
            "Turn text into a spoken audio file in this thread's folder using the person's Voice synthesis endpoint and voice. Never overwrites an existing file.",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              relativePath: { type: "string" },
              format: { type: "string", enum: [...SPEECH_SYNTHESIS_FORMATS] },
            },
            required: ["text", "relativePath"],
          },
        },
      ],
      taintPolicy: "none",
      close: async () => {
        stopped.abort();
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        if (call.name !== NARRATE_TOOL_NAME) {
          return transcriptionRefused("Narration is unavailable for this turn.");
        }
        if (port.turn.inPlan()) {
          return transcriptionRefused("Plan mode cannot create audio files.");
        }
        if (signal.aborted || !port.turn.allowed()) {
          return transcriptionRefused("Narration is unavailable for this turn.");
        }
        const args = parseNarrationInput(call.inputJson);
        if (!args.ok) return transcriptionRefused(args.reason);
        const outcome = await narration.narrate({
          text: args.text,
          relativePath: args.relativePath,
          format: args.format,
          signal,
        });
        switch (outcome.status) {
          case "refused":
            return transcriptionRefused(outcome.reason);
          case "busy":
            return { isError: true, result: { status: "busy", reason: outcome.reason } };
          case "failed":
            return { isError: true, result: { status: "failed", reason: outcome.reason } };
          case "saved":
            return {
              result: {
                status: "saved",
                relativePath: outcome.relativePath,
                bytes: outcome.bytes,
              },
            };
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
    return {
      definitions: [
        { name: LOOK_TOOL_NAME, description: LOOK_DESCRIPTION, inputSchema: LOOK_INPUT_SCHEMA },
      ],
      taintPolicy: "watcher-only",
      close: async () => {
        stopped.abort();
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

interface ParsedIconSetInput {
  readonly operation: "icon-set";
  readonly attachmentId: ImageArtifactId;
  readonly target: MediaIconSetTarget;
  readonly directory: string;
}

/**
 * Pre-flight POSIX relative-path check mirroring `canonicalizeWorkRelativePath`
 * in `@octant/domain`. `@octant/plugin-host` intentionally does not depend on
 * `@octant/domain`; the server adapter re-validates every file reference
 * authoritatively through `parseImageSourceRequests` before any filesystem read.
 */
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
  max: number = MAX_IMAGE_REFERENCES,
): ReadonlyArray<MediaImageReferenceInput> | { readonly error: string } {
  if (!Array.isArray(value) || value.length > max) {
    return { error: `Use at most ${String(max)} image references.` };
  }
  const requests: MediaImageReferenceInput[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) return { error: "An image reference is invalid." };
    const { kind, ...fields } = item;
    try {
      if (kind === "attachment" && Object.keys(fields).length === 0) {
        requests.push({ kind });
      } else if (
        kind === "attachment" &&
        Object.keys(fields).length === 1 &&
        typeof fields["name"] === "string" &&
        fields["name"].trim().length > 0 &&
        fields["name"].length <= MAX_IMAGE_REFERENCE_LABEL_LENGTH
      ) {
        requests.push({ kind, name: fields["name"].trim() });
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
  offersIconSets: boolean,
):
  | ParsedImageGenerateInput
  | ParsedImageSaveInput
  | ParsedIconSetInput
  | { readonly error: string } {
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
  if (operation === "icon-set" && offersIconSets) {
    const target = raw["target"];
    const directory = raw["directory"];
    if (!isIconSetTarget(target)) {
      return { error: "An icon set needs a target: apple-ios, apple-macos, android, or web." };
    }
    if (typeof directory !== "string" || directory.trim().length === 0) {
      return { error: "An icon set needs directory, a folder inside this thread's folder." };
    }
    if (directory.length > MAX_ICON_SET_DIRECTORY_CHARACTERS) {
      return { error: "The icon set directory is too long." };
    }
    const destination = directory.trim().replace(/\/+$/u, "");
    // "." names the folder itself, for a site whose root page lives there.
    const canonical = destination === "." ? "." : canonicalizeRelativeReferencePath(destination);
    if (canonical === undefined) {
      return { error: "The icon set directory must be inside this thread's folder." };
    }
    try {
      return {
        operation: "icon-set",
        attachmentId: decodeImageArtifactId(raw["attachmentId"]),
        target,
        directory: canonical,
      };
    } catch {
      return { error: "An icon set needs the attachmentId of a finished image on this thread." };
    }
  }
  if (operation !== "generate") {
    return {
      error: offersIconSets
        ? "The operation is generate, save, or icon-set."
        : "The operation is generate or save.",
    };
  }
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
    const iconSet = imageGeneration.iconSet;
    return {
      definitions: [
        {
          name: CREATE_IMAGE_TOOL_NAME,
          description:
            iconSet === undefined ? IMAGE_DESCRIPTION : IMAGE_DESCRIPTION + ICON_SET_DESCRIPTION,
          inputSchema:
            iconSet === undefined ? IMAGE_INPUT_SCHEMA : IMAGE_WITH_ICON_SET_INPUT_SCHEMA,
        },
      ],
      taintPolicy: "none",
      close: async () => {
        stopped.abort();
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        if (call.name !== CREATE_IMAGE_TOOL_NAME || !port.turn.allowed()) {
          return errorResult("tool-unavailable");
        }
        const refusal = imageGeneration.refusal?.();
        if (refusal !== undefined) return errorResult(refusal);
        const parsed = parseImageToolInput(call.inputJson, iconSet !== undefined);
        if ("error" in parsed) return errorResult(parsed.error);
        if (parsed.operation === "icon-set") {
          if (iconSet === undefined) return errorResult("tool-unavailable");
          const made = await iconSet({
            attachmentId: parsed.attachmentId,
            target: parsed.target,
            directory: parsed.directory,
            signal,
          });
          switch (made.status) {
            case "saved":
              return {
                result: {
                  status: "saved",
                  directory: made.directory,
                  files: made.files,
                  ...(made.snippets === undefined
                    ? {}
                    : {
                        html: made.snippets.html,
                        manifestIcons: made.snippets.manifestIcons,
                        message:
                          "Octant did not edit any HTML or manifest file. Place the link tags and manifest icons yourself.",
                      }),
                },
              };
            case "not-saved":
              return {
                result: {
                  status: "not-saved",
                  message: "The person did not save the icon set. Do not ask again unless they do.",
                },
              };
            case "refused":
              return errorResult(made.error);
            case "failed":
              return {
                result: { status: "failed", error: made.error, written: made.written },
                isError: true,
              };
          }
        }
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

const VIDEO_DESCRIPTION =
  "Generate a short video clip with a video model the person set up in Octant. Call it only when the person asks for a video, instead of writing an animation by hand. Octant shows the person a card in this thread with the price, where they confirm, because each clip is billed to their video provider; nothing runs until they answer, unless they already said not to ask again or the thread runs at Full access. Describe the clip in prompt. durationSeconds, resolution, aspectRatio and audio are optional and must be ones the model declares; absent ones take the model's defaults. Use firstFrame, lastFrame and references (the same reference forms as octant_create_image; an attachment may also carry name to pick one upload, which a frame requires) where the model takes them; images always require confirmation. The result says what happened: completed with a clipId (the clip is shown in this thread), generating with a jobId when it takes longer than the call waits (it appears when done; do not start another), failed with the reason, or cancelled (do not ask again unless they do). In a Work or Code thread, operation save with a clipId from this thread and a relativePath ending in .mp4 stores the clip as a new file in the folder you work in: it never overwrites a file, Plan refuses it, and at Ask first the person confirms the path. Never invent a video URL.";

const VIDEO_REFERENCE_SCHEMA = {
  type: "object",
  properties: {
    kind: { enum: ["attachment", "browser-capture", "file", "generated-image"] },
    name: { type: "string" },
    captureId: { type: "string" },
    relativePath: { type: "string" },
    attachmentId: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const VIDEO_INPUT_SCHEMA = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["generate", "save"] },
    prompt: { type: "string" },
    profileInstanceId: { type: "string" },
    modelId: { type: "string" },
    durationSeconds: { type: "number" },
    resolution: { type: "string" },
    aspectRatio: { type: "string" },
    audio: { type: "boolean" },
    firstFrame: VIDEO_REFERENCE_SCHEMA,
    lastFrame: VIDEO_REFERENCE_SCHEMA,
    references: { type: "array", maxItems: MAX_VIDEO_REFERENCES, items: VIDEO_REFERENCE_SCHEMA },
    clipId: { type: "string" },
    relativePath: { type: "string" },
  },
} as const;

type ParsedVideoInput =
  | ({ readonly operation: "generate" } & Omit<MediaVideoGenerateRequest, "signal">)
  | { readonly operation: "save"; readonly clipId: VideoClipId; readonly relativePath: string }
  | { readonly error: string };

function parseOneVideoReference(
  value: unknown,
): MediaImageReferenceInput | undefined | { readonly error: string } {
  if (value === undefined) return undefined;
  const parsed = parseImageReferenceInputs([value]);
  if ("error" in parsed) return parsed;
  return parsed[0];
}

function parseVideoToolInput(inputJson: string): ParsedVideoInput {
  let raw: unknown;
  try {
    raw = JSON.parse(inputJson);
  } catch {
    return { error: "The tool input is not valid JSON." };
  }
  if (!isPlainObject(raw)) return { error: "The tool input must be an object." };
  for (const key of FORBIDDEN_IMAGE_INPUT_KEYS) {
    if (key in raw)
      return { error: "Do not pass credentials, endpoints, or paths outside the folder." };
  }
  const operation = raw["operation"] ?? "generate";
  if (operation === "save") {
    const relativePath = raw["relativePath"];
    if (
      typeof relativePath !== "string" ||
      relativePath.length > MAX_SAVE_PATH_CHARACTERS ||
      !relativePath.toLowerCase().endsWith(".mp4")
    ) {
      return { error: "Name a relativePath ending in .mp4 inside the folder you work in." };
    }
    const canonical = canonicalizeRelativeReferencePath(relativePath);
    if (canonical === undefined)
      return { error: "The path must be inside the folder you work in." };
    try {
      return {
        operation: "save",
        clipId: decodeVideoClipId(raw["clipId"]),
        relativePath: canonical,
      };
    } catch {
      return { error: "Pass the clipId of a clip from this thread." };
    }
  }
  if (operation !== "generate") return { error: "The operation must be generate or save." };
  const prompt = raw["prompt"];
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return { error: "Describe the clip in prompt." };
  }
  const references =
    raw["references"] === undefined
      ? []
      : parseImageReferenceInputs(raw["references"], MAX_VIDEO_REFERENCES);
  if ("error" in references) return references;
  const firstFrame = parseOneVideoReference(raw["firstFrame"]);
  if (firstFrame !== undefined && "error" in firstFrame) return firstFrame;
  const lastFrame = parseOneVideoReference(raw["lastFrame"]);
  if (lastFrame !== undefined && "error" in lastFrame) return lastFrame;
  const durationSeconds = raw["durationSeconds"];
  if (
    durationSeconds !== undefined &&
    (typeof durationSeconds !== "number" ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds <= 0)
  ) {
    return { error: "durationSeconds must be a whole number of seconds." };
  }
  for (const key of ["resolution", "aspectRatio", "profileInstanceId", "modelId"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "string" || value.length > 128)) {
      return { error: `${key} must be a short string.` };
    }
  }
  const audio = raw["audio"];
  if (audio !== undefined && typeof audio !== "boolean")
    return { error: "audio must be true or false." };
  const profileInstanceId = raw["profileInstanceId"];
  const modelId = raw["modelId"];
  const resolution = raw["resolution"];
  const aspectRatio = raw["aspectRatio"];
  try {
    return {
      operation: "generate",
      prompt,
      references,
      ...(firstFrame === undefined ? {} : { firstFrame }),
      ...(lastFrame === undefined ? {} : { lastFrame }),
      ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
      ...(typeof resolution === "string" ? { resolution } : {}),
      ...(typeof aspectRatio === "string" ? { aspectRatio } : {}),
      ...(typeof audio === "boolean" ? { audio } : {}),
      ...(typeof profileInstanceId === "string"
        ? { profileInstanceId: decodeProviderInstanceId(profileInstanceId) }
        : {}),
      ...(typeof modelId === "string" ? { modelId: decodeProviderModelId(modelId) } : {}),
    };
  } catch {
    return { error: "One of the video generation identifiers is invalid." };
  }
}

/**
 * Built-in video generation media tool plugin (`octant_create_video`),
 * composed strictly over `MediaToolHostPort.videoGeneration`. The host owns
 * the card, the price, spend, credentials, storage and the access level.
 */
export const CREATE_VIDEO_MEDIA_TOOL_PLUGIN: MediaToolPluginDefinition = {
  kind: MEDIA_TOOL_CONTRIBUTION_KIND,
  id: "create-video",
  modes: ["chat", "work", "code"],
  createTools: (port) => {
    const videoGeneration = port.videoGeneration;
    if (
      videoGeneration === undefined ||
      !CREATE_VIDEO_MEDIA_TOOL_PLUGIN.modes.includes(port.turn.mode) ||
      !videoGeneration.isAvailable()
    ) {
      return undefined;
    }
    const stopped = new AbortController();
    return {
      definitions: [
        {
          name: CREATE_VIDEO_TOOL_NAME,
          description: `${VIDEO_DESCRIPTION} Ready models: ${videoGeneration.describeModels()}`,
          inputSchema: VIDEO_INPUT_SCHEMA,
        },
      ],
      taintPolicy: "none",
      close: async () => {
        stopped.abort();
      },
      execute: async (call) => {
        const signal = combineSignals(stopped.signal, call.signal);
        if (call.name !== CREATE_VIDEO_TOOL_NAME || !port.turn.allowed()) {
          return errorResult("tool-unavailable");
        }
        const refusal = videoGeneration.refusal?.();
        if (refusal !== undefined) return errorResult(refusal);
        const parsed = parseVideoToolInput(call.inputJson);
        if ("error" in parsed) return errorResult(parsed.error);
        if (parsed.operation === "save") {
          if (videoGeneration.save === undefined) {
            return errorResult(
              "This thread has no folder to save into. Chat clips stay in the thread.",
            );
          }
          const saved = await videoGeneration.save({
            clipId: parsed.clipId,
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
                  message: "The person did not save the clip. Do not ask again unless they do.",
                },
              };
            case "refused":
              return errorResult(saved.error);
          }
        }
        const { operation: _operation, ...request } = parsed;
        const outcome = await videoGeneration.generate({ ...request, signal });
        switch (outcome.status) {
          case "completed":
            return {
              result: {
                status: "completed",
                jobId: outcome.jobId,
                clipId: outcome.clipId,
                modelId: outcome.modelId,
                profileInstanceId: outcome.profileInstanceId,
                durationSeconds: outcome.durationSeconds,
                resolution: outcome.resolution,
                sizeBytes: outcome.sizeBytes,
                message: "The clip is shown in this thread.",
              },
            };
          case "generating":
            return {
              result: {
                status: "generating",
                jobId: outcome.jobId,
                message:
                  "The clip is still being made and appears in this thread when done. Do not start another.",
              },
            };
          case "cancelled":
            return {
              result: {
                status: "cancelled",
                ...(outcome.jobId === undefined ? {} : { jobId: outcome.jobId }),
                message: "No clip was made. Do not ask again unless the person does.",
              },
            };
          case "failed":
            return {
              result: { status: "failed", jobId: outcome.jobId, error: outcome.message },
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
  NARRATE_MEDIA_TOOL_PLUGIN,
  LOOK_MEDIA_TOOL_PLUGIN,
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
  CREATE_VIDEO_MEDIA_TOOL_PLUGIN,
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
  hostRefused: true,
};

/**
 * Wraps a third-party media tool plugin behind host-owned naming, activation
 * gating, live authority checks, and fail-closed outside-content tainting.
 *
 * Closing the returned set closes only the plugin's own resources; the host
 * retains ownership of the shared turn `port` lifecycle.
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
  if (inner === undefined) return undefined;
  if (inner.definitions.length === 0) {
    closeWithheldMediaTool(inner);
    return undefined;
  }
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
      closeWithheldMediaTool(inner);
      return undefined;
    }
    seenInternal.add(definition.name);
    const assignedName = contributedMediaToolName(
      input.packageId,
      input.componentId,
      inner.definitions.length === 1 ? undefined : index,
    );
    if (isReservedBuiltinMediaToolName(assignedName)) {
      closeWithheldMediaTool(inner);
      return undefined;
    }
    routed.set(assignedName, definition.name);
    definitions.push({ ...definition, name: assignedName });
  }
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    definitions,
    // Third-party media tools can never opt out of outside-content tainting,
    // including when they return `isError: true`.
    taintPolicy: "outside-content",
    taintErrorResults: true,
    close: () => {
      closed = true;
      closing ??= Promise.resolve(inner.close());
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
      // Rebuild the result without `hostRefused` so a plugin cannot forge a host refusal.
      return {
        result: outcome.result,
        ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        ...(outcome.images === undefined ? {} : { images: outcome.images }),
      };
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
 * Duplicate `(packageId, componentId)` claims and any registrations whose final
 * assigned provider tool names collide (for example a multi-tool `media` and a
 * single-tool `media-0`) are all withheld so a turn never silently routes to a
 * different plugin.
 */
export function registerContributedMediaTools(input: {
  readonly contributions: ReadonlyArray<ContributedMediaToolRegistration>;
  readonly port: MediaToolHostPort;
}): ReadonlyArray<MediaToolSet> {
  const componentClaims = new Map<string, number>();
  for (const contribution of input.contributions) {
    const key = `${contribution.packageId}:${contribution.componentId}`;
    componentClaims.set(key, (componentClaims.get(key) ?? 0) + 1);
  }
  const candidates: MediaToolSet[] = [];
  for (const contribution of input.contributions) {
    const key = `${contribution.packageId}:${contribution.componentId}`;
    if (componentClaims.get(key) !== 1) continue;
    const set = createContributedMediaTool({ ...contribution, port: input.port });
    if (set !== undefined) candidates.push(set);
  }
  const assignedNameCounts = new Map<string, number>();
  for (const set of candidates) {
    for (const definition of set.definitions) {
      assignedNameCounts.set(definition.name, (assignedNameCounts.get(definition.name) ?? 0) + 1);
    }
  }
  const active: MediaToolSet[] = [];
  for (const set of candidates) {
    const collides = set.definitions.some(
      (definition) => (assignedNameCounts.get(definition.name) ?? 0) > 1,
    );
    if (collides) {
      closeWithheldMediaTool(set);
      continue;
    }
    active.push(set);
  }
  return active;
}

function closeWithheldMediaTool(set: MediaToolSet): void {
  try {
    void Promise.resolve(set.close()).catch(() => undefined);
  } catch {
    // A failing close on a withheld plugin must not abort sibling registration.
  }
}
