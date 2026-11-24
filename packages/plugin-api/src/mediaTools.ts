/**
 * The public, provider-neutral media tool port.
 *
 * Media tool plugins (built-in or third-party) compose their tool definitions
 * and execution solely over a turn-scoped `MediaToolHostPort`. All sensitive
 * boundaries remain host-owned:
 * - thread folder confinement and protected-secret checks,
 * - raw file/attachment/capture bytes and magic-byte sniffing,
 * - provider credentials, endpoints, model/speech routing, and spend ceilings,
 * - paid-service offer lifecycle, consent UI, and kept choices,
 * - concurrency gates, outside-content tainting, and live mode/window/thread admission.
 */
import type {
  BrowserCaptureId,
  CodeRelativePath,
  ImageArtifactId,
  ImageDescribedBy,
  ImageJobId,
  OctantMode,
  ProviderInstanceId,
  ProviderModelId,
  ProviderToolDefinition,
  ProviderToolImage,
  SpeechSynthesisFormat,
  SpeechTranscriptionLanguage,
  VideoClipId,
  VideoJobId,
} from "@octant/contracts";

export const MEDIA_TOOL_CONTRIBUTION_KIND = "media-tool" as const;
export type MediaToolContributionKind = typeof MEDIA_TOOL_CONTRIBUTION_KIND;

export const MEDIA_DESCRIBABLE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;
export type MediaDescribableImageType = (typeof MEDIA_DESCRIBABLE_IMAGE_TYPES)[number];

/**
 * How the host applies outside-content tainting and Watcher checks to
 * successful results from a media tool set.
 * - `"outside-content"`: marks the thread as having read outside content and
 *   runs the host Watcher (always enforced for third-party plugins).
 * - `"watcher-only"`: runs the host Watcher without unconditionally marking
 *   the thread when the content came from the person's own attachment or folder.
 * - `"none"`: leaves tainting to any outer mode wrapper.
 */
export type MediaToolTaintPolicy = "outside-content" | "watcher-only" | "none";

export interface MediaToolResult {
  readonly result: unknown;
  readonly isError?: boolean;
  readonly images?: ReadonlyArray<ProviderToolImage>;
  /**
   * Set only by a host-owned bridge when the host itself refused the call
   * (for example, revoked authority or a closed tool) before or instead of
   * returning plugin-produced output. Contributed tool wrappers strip any
   * plugin-supplied value so plugins cannot forge a host refusal.
   */
  readonly hostRefused?: true;
}

export interface MediaToolCallInput {
  readonly name: string;
  readonly inputJson: string;
  readonly signal?: AbortSignal;
}

/**
 * Opaque, provider-neutral turn context handed to media tool plugins.
 * Exposes no window id, thread id, filesystem path, or host service handle.
 */
export interface MediaToolTurnContext {
  readonly mode: OctantMode;
  /** Whether this turn has a confined thread folder (Work/Code; false in Chat). */
  readonly hasFolder: boolean;
  /** Whether the host runs this turn unattended (routine, goal loop, resume). */
  readonly unattended: boolean;
  /** Live check for whether this turn is currently in Plan mode. */
  readonly inPlan: () => boolean;
  /** Live check for whether the turn's window/thread still holds authority. */
  readonly allowed: () => boolean;
}

export interface MediaTranscriptionRequest {
  readonly relativePath: CodeRelativePath;
  readonly language?: SpeechTranscriptionLanguage;
  /**
   * False for continuation pages (`offset > 0`): the host must serve only from
   * its thread-scoped cache and never trigger a new offer or provider call.
   */
  readonly allowFreshRequest: boolean;
  readonly signal?: AbortSignal;
}

export type MediaTranscriptionOutcome =
  | { readonly status: "transcribed"; readonly text: string }
  | { readonly status: "cache-miss" }
  | { readonly status: "busy"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/** Host-mediated audio transcription over confined turn files. */
export interface MediaTranscriptionHostPort {
  /** Live check: transcription endpoint is ready and allowed for this turn. */
  readonly isAvailable: () => boolean;
  readonly transcribe: (input: MediaTranscriptionRequest) => Promise<MediaTranscriptionOutcome>;
}

export interface MediaNarrationRequest {
  readonly text: string;
  readonly relativePath: CodeRelativePath;
  readonly format: SpeechSynthesisFormat;
  readonly signal?: AbortSignal;
}

export type MediaNarrationOutcome =
  | { readonly status: "saved"; readonly relativePath: string; readonly bytes: number }
  | { readonly status: "busy"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "refused"; readonly reason: string };

/** Host-mediated text-to-speech synthesis saved as a new confined file. */
export interface MediaNarrationHostPort {
  /** Live check: synthesis endpoint and voice are ready and allowed for this turn. */
  readonly isAvailable: () => boolean;
  readonly narrate: (input: MediaNarrationRequest) => Promise<MediaNarrationOutcome>;
}

export type MediaImageDescriptionOutcome =
  | {
      readonly status: "described";
      readonly imageName: string;
      readonly describedBy: ImageDescribedBy;
      readonly description: string;
    }
  | { readonly status: "refused"; readonly reason: string };

/** Host-mediated image description over thread attachments or confined turn files. */
export interface MediaImageDescriptionHostPort {
  /** Live check: thread model cannot read images and Sees images has an eligible model. */
  readonly isAvailable: () => boolean;
  readonly describeAttachment: (input: {
    readonly attachmentId: string;
    readonly question?: string;
    readonly signal?: AbortSignal;
  }) => Promise<MediaImageDescriptionOutcome | { readonly status: "not-found" }>;
  readonly describeFolderImage: (input: {
    readonly relativePath: CodeRelativePath;
    readonly mediaType: MediaDescribableImageType;
    readonly question?: string;
    readonly signal?: AbortSignal;
  }) => Promise<MediaImageDescriptionOutcome>;
}

export type MediaImageReferenceInput =
  | {
      readonly kind: "attachment";
      /** One named attachment of the latest message; absent names the whole set. */
      readonly name?: string;
    }
  | { readonly kind: "browser-capture"; readonly captureId: BrowserCaptureId }
  | { readonly kind: "file"; readonly relativePath: string }
  | { readonly kind: "generated-image"; readonly attachmentId: ImageArtifactId };

export interface MediaImageGenerateRequest {
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  readonly variantCount?: number;
  readonly parentAttachmentId?: ImageArtifactId;
  readonly references: ReadonlyArray<MediaImageReferenceInput>;
  readonly signal?: AbortSignal;
}

export interface MediaGeneratedImageArtifact {
  readonly attachmentId: ImageArtifactId;
  readonly mime: string;
  readonly size: number;
}

export type MediaImageGenerateOutcome =
  | {
      readonly status: "completed";
      readonly jobId: ImageJobId;
      readonly modelId: ProviderModelId;
      readonly profileInstanceId: ProviderInstanceId;
      readonly artifacts: ReadonlyArray<MediaGeneratedImageArtifact>;
      readonly images?: ReadonlyArray<ProviderToolImage>;
      readonly withheldCount: number;
    }
  | {
      readonly status: "generating";
      readonly jobId: ImageJobId;
      readonly modelId: ProviderModelId;
      readonly profileInstanceId: ProviderInstanceId;
    }
  | { readonly status: "agent-draws" }
  | {
      readonly status: "cancelled";
      readonly jobId?: ImageJobId;
      readonly reason?: "aborted" | "declined" | "job-cancelled";
    }
  | { readonly status: "failed"; readonly jobId: ImageJobId; readonly message: string }
  | { readonly status: "refused"; readonly error: string };

export interface MediaImageSaveRequest {
  readonly attachmentId: ImageArtifactId;
  readonly relativePath: string;
  readonly signal?: AbortSignal;
}

export type MediaImageSaveOutcome =
  | { readonly status: "saved"; readonly relativePath: string }
  | { readonly status: "not-saved" }
  | { readonly status: "refused"; readonly error: string; readonly saveStatus?: string };

/** What an icon set is for: an Xcode app icon set, Android launcher icons, or web favicons. */
export const MEDIA_ICON_SET_TARGETS = ["apple-ios", "apple-macos", "android", "web"] as const;
export type MediaIconSetTarget = (typeof MEDIA_ICON_SET_TARGETS)[number];

export interface MediaImageIconSetRequest {
  readonly attachmentId: ImageArtifactId;
  readonly target: MediaIconSetTarget;
  /** A directory relative to the turn's folder; the host confines it again. */
  readonly directory: string;
  readonly signal?: AbortSignal;
}

export type MediaImageIconSetOutcome =
  | {
      readonly status: "saved";
      readonly directory: string;
      /** Paths relative to the turn's folder, in the order they were written. */
      readonly files: ReadonlyArray<string>;
      /** For `web`: the `<link>` tags and the manifest `icons` JSON for the agent to place. */
      readonly snippets?: { readonly html: string; readonly manifestIcons: string };
    }
  | { readonly status: "not-saved" }
  /** Nothing was written: a check refused, or the set stopped before its first file. */
  | { readonly status: "refused"; readonly error: string }
  /**
   * The set stopped part way (Stop, a lowered level, or a failed write).
   * The files already written are complete and kept, and are named.
   */
  | { readonly status: "failed"; readonly error: string; readonly written: ReadonlyArray<string> };

/** Host-mediated image generation, revision, and confined folder saving. */
export interface MediaImageGenerationHostPort {
  /** Live check: at least one eligible image profile is available for this turn. */
  readonly isAvailable: () => boolean;
  /** Live turn-level refusal reason (for example Plan mode); undefined allows calls. */
  readonly refusal?: () => string | undefined;
  readonly generate: (input: MediaImageGenerateRequest) => Promise<MediaImageGenerateOutcome>;
  /** Absent when the thread has no working folder (for example Chat). */
  readonly save?: (input: MediaImageSaveRequest) => Promise<MediaImageSaveOutcome>;
  /**
   * Resizes a finished image into an icon set under the turn's folder. Absent
   * where the host cannot resize images itself or the thread has no folder,
   * and then the operation is not offered at all.
   */
  readonly iconSet?: (input: MediaImageIconSetRequest) => Promise<MediaImageIconSetOutcome>;
}

export interface MediaVideoGenerateRequest {
  readonly prompt: string;
  readonly profileInstanceId?: ProviderInstanceId;
  readonly modelId?: ProviderModelId;
  /** Absent options take the model's own defaults; the host checks every option against what the model declares. */
  readonly durationSeconds?: number;
  readonly resolution?: string;
  readonly aspectRatio?: string;
  readonly audio?: boolean;
  readonly firstFrame?: MediaImageReferenceInput;
  readonly lastFrame?: MediaImageReferenceInput;
  readonly references: ReadonlyArray<MediaImageReferenceInput>;
  readonly signal?: AbortSignal;
}

export type MediaVideoGenerateOutcome =
  | {
      readonly status: "completed";
      readonly jobId: VideoJobId;
      readonly clipId: VideoClipId;
      readonly modelId: ProviderModelId;
      readonly profileInstanceId: ProviderInstanceId;
      readonly durationSeconds: number;
      readonly resolution: string;
      readonly sizeBytes: number;
    }
  | {
      /** Still running after the call's wait; the clip appears in the thread when done. */
      readonly status: "generating";
      readonly jobId: VideoJobId;
      readonly modelId: ProviderModelId;
      readonly profileInstanceId: ProviderInstanceId;
    }
  | {
      readonly status: "cancelled";
      readonly jobId?: VideoJobId;
      readonly reason?: "aborted" | "declined" | "job-cancelled";
    }
  | { readonly status: "failed"; readonly jobId: VideoJobId; readonly message: string }
  | { readonly status: "refused"; readonly error: string };

export type MediaVideoSaveRequest = {
  readonly relativePath: string;
  readonly signal?: AbortSignal;
} & ({ readonly clipId: VideoClipId } | { readonly jobId: VideoJobId });

export type MediaVideoSaveOutcome =
  | { readonly status: "saved"; readonly relativePath: string }
  | { readonly status: "not-saved" }
  | { readonly status: "refused"; readonly error: string };

/** Host-mediated video generation and confined folder saving, provider-neutral. */
export interface MediaVideoGenerationHostPort {
  /** Live check: at least one ready video profile is available for this turn. */
  readonly isAvailable: () => boolean;
  /** Live turn-level refusal reason (for example Plan mode); undefined allows calls. */
  readonly refusal?: () => string | undefined;
  /**
   * The ready models and the options each declares, in plain words, so the
   * tool can tell the agent what it may ask for. The host still checks every call.
   */
  readonly describeModels: () => string;
  readonly generate: (input: MediaVideoGenerateRequest) => Promise<MediaVideoGenerateOutcome>;
  /** Absent when the thread has no working folder (for example Chat). */
  readonly save?: (input: MediaVideoSaveRequest) => Promise<MediaVideoSaveOutcome>;
}

/**
 * Capability-scoped turn port issued by the host to media tool plugins.
 * Capabilities omitted on this port are unavailable for the turn.
 */
export interface MediaToolHostPort {
  readonly turn: MediaToolTurnContext;
  readonly transcription?: MediaTranscriptionHostPort;
  readonly narration?: MediaNarrationHostPort;
  readonly imageDescription?: MediaImageDescriptionHostPort;
  readonly imageGeneration?: MediaImageGenerationHostPort;
  readonly videoGeneration?: MediaVideoGenerationHostPort;
  /** Host-owned teardown for a shared turn port; individual `MediaToolSet.close()` calls do not invoke it. */
  readonly close?: () => Promise<void>;
}

/** A composed media tool set ready to be bridged onto the provider turn. */
export interface MediaToolSet {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly taintPolicy: MediaToolTaintPolicy;
  /**
   * When true alongside `taintPolicy: "outside-content"`, plugin-generated
   * `isError: true` results (everything without `hostRefused: true`) are also
   * watched and recorded as outside content so a plugin cannot opt out of
   * tainting by setting `isError: true`.
   */
  readonly taintErrorResults?: boolean;
  readonly execute: (input: MediaToolCallInput) => Promise<MediaToolResult>;
  /** Tears down only this tool set's own resources; the host caller retains ownership of closing any shared `MediaToolHostPort`. */
  readonly close: () => Promise<void>;
}

/**
 * A media tool plugin that composes its tools solely over `MediaToolHostPort`.
 */
export interface MediaToolPluginDefinition {
  readonly kind: MediaToolContributionKind;
  readonly id: string;
  readonly modes: ReadonlyArray<OctantMode>;
  readonly createTools: (port: MediaToolHostPort) => MediaToolSet | undefined;
}
