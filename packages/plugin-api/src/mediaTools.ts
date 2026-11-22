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
  SpeechTranscriptionLanguage,
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
  | { readonly kind: "attachment" }
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

/** Host-mediated image generation, revision, and confined folder saving. */
export interface MediaImageGenerationHostPort {
  /** Live check: at least one eligible image profile is available for this turn. */
  readonly isAvailable: () => boolean;
  /** Live turn-level refusal reason (for example Plan mode); undefined allows calls. */
  readonly refusal?: () => string | undefined;
  readonly generate: (input: MediaImageGenerateRequest) => Promise<MediaImageGenerateOutcome>;
  /** Absent when the thread has no working folder (for example Chat). */
  readonly save?: (input: MediaImageSaveRequest) => Promise<MediaImageSaveOutcome>;
}

/**
 * Capability-scoped turn port issued by the host to media tool plugins.
 * Capabilities omitted on this port are unavailable for the turn.
 */
export interface MediaToolHostPort {
  readonly turn: MediaToolTurnContext;
  readonly transcription?: MediaTranscriptionHostPort;
  readonly imageDescription?: MediaImageDescriptionHostPort;
  readonly imageGeneration?: MediaImageGenerationHostPort;
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
