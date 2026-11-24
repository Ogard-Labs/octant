import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ImageGenerationScopeId } from "./imageGeneration";
import { ProviderFailure, ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const ContentDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
/** A provider's own label for an option, such as "720p" or "16:9". */
const OptionLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32));

/**
 * The bundled video drivers. Each is a provider plugin on the video seam in
 * `@octant/provider-sdk/video-generation`, admitted by the same activation
 * ladder as image drivers (maintainer decision, 2026-11-22).
 */
export const VIDEO_DRIVER_KINDS = ["gemini-video"] as const;
export const VideoDriverKind = Schema.Literal(...VIDEO_DRIVER_KINDS);
export type VideoDriverKind = typeof VideoDriverKind.Type;

/** The whole seconds a model accepts: a range, or the exact values for models that take only some. */
export const VideoDurations = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("range"), min: PositiveInt, max: PositiveInt })
    .pipe(Schema.filter((range) => range.min <= range.max))
    .annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("values"),
    values: Schema.NonEmptyArray(PositiveInt),
  }).annotations(strict),
);
export type VideoDurations = typeof VideoDurations.Type;

export const VideoAspectRatio = Schema.Struct({
  ratio: OptionLabel,
  /** The model takes this ratio only from a first frame, so the card offers it once an image is chosen. */
  needsImage: Schema.optional(Schema.Boolean),
}).annotations(strict);
export type VideoAspectRatio = typeof VideoAspectRatio.Type;

/**
 * How a model is priced. Amounts are integer US micro-dollars, as every other
 * spend estimate in Octant.
 */
export const VideoPrice = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("per-second"),
    rates: Schema.NonEmptyArray(
      Schema.Struct({
        resolution: OptionLabel,
        /** Absent means the rate applies whether audio is on or off. */
        audio: Schema.optional(Schema.Boolean),
        usdMicrosPerSecond: NonNegativeInt,
      }).annotations(strict),
    ),
    inputUsdMicrosPerImage: Schema.optional(NonNegativeInt),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("per-token"),
    outputTokensPerSecond: Schema.NonEmptyArray(
      Schema.Struct({ resolution: OptionLabel, tokens: PositiveInt }).annotations(strict),
    ),
    outputUsdMicrosPerMillionTokens: NonNegativeInt,
    inputUsdMicrosPerMillionTokens: Schema.optional(NonNegativeInt),
    /** Input tokens one reference image costs, where the provider publishes it. */
    inputTokensPerImage: Schema.optional(NonNegativeInt),
    /**
     * Extra output tokens a job may bill beyond the resolution's video
     * tokens — Gemini's billed thinking tokens, for example — reserved at
     * the output price so billed usage still fits the ceiling it was
     * approved under.
     */
    reservedOutputTokenAllowance: Schema.optional(NonNegativeInt),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("per-clip"),
    rates: Schema.NonEmptyArray(
      Schema.Struct({
        durationSeconds: PositiveInt,
        resolution: OptionLabel,
        audio: Schema.optional(Schema.Boolean),
        usdMicros: NonNegativeInt,
      }).annotations(strict),
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unpublished") }).annotations(strict),
);
export type VideoPrice = typeof VideoPrice.Type;

export const VideoJobControl = Schema.Struct({
  /** Whether a running job can be stopped at the provider, or only a queued one, or neither. */
  cancel: Schema.Literal("running", "queued", "none"),
  /** Whether the provider's stored copy can be removed, or else how long the provider keeps it. */
  removal: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("delete") }).annotations(strict),
    Schema.Struct({ kind: Schema.Literal("expires"), afterHours: PositiveInt }).annotations(strict),
  ),
  /** How long after starting a job its id can still be polled, for restart recovery. */
  resumeWindowHours: PositiveInt,
}).annotations(strict);
export type VideoJobControl = typeof VideoJobControl.Type;

/**
 * What one video model declares about itself. The host builds the card, the
 * price, the limits, spend, storage, recovery and viewing from these facts,
 * the same way for every provider.
 */
export const VideoModelCapabilities = Schema.Struct({
  modelId: ProviderModelId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  durations: VideoDurations,
  defaultDuration: Schema.optional(PositiveInt),
  /** Lowest first; "lowest" in the default ranking means the first entry. */
  resolutions: Schema.NonEmptyArray(OptionLabel),
  defaultResolution: Schema.optional(OptionLabel),
  aspectRatios: Schema.NonEmptyArray(VideoAspectRatio),
  defaultAspectRatio: Schema.optional(OptionLabel),
  audio: Schema.Literal("none", "always", "optional"),
  /** For `optional` audio, whether it is on by default; off when absent. */
  defaultAudio: Schema.optional(Schema.Boolean),
  inputs: Schema.Struct({
    firstFrame: Schema.Boolean,
    lastFrame: Schema.Boolean,
    /** A lower duration ceiling when both frames are supplied. */
    maxDurationSecondsWithBothFrames: Schema.optional(PositiveInt),
    /** 0 when the model takes no reference images. */
    maxReferenceImages: NonNegativeInt,
  }).annotations(strict),
  price: VideoPrice,
  job: VideoJobControl,
}).annotations(strict);
export type VideoModelCapabilities = typeof VideoModelCapabilities.Type;

/** One clip's options as the person or the agent chose them. */
export const VideoClipOptions = Schema.Struct({
  durationSeconds: PositiveInt,
  resolution: OptionLabel,
  aspectRatio: OptionLabel,
  audio: Schema.Boolean,
}).annotations(strict);
export type VideoClipOptions = typeof VideoClipOptions.Type;

/** The largest clip the host keeps; a larger response is refused, never truncated. */
export const MAX_VIDEO_CLIP_BYTES = 1024 * 1024 * 1024;
/** How long a job may run before it fails as a timeout. */
export const VIDEO_JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** Video jobs waiting to start, per host; image jobs in the shared queue do not count. */
export const MAX_QUEUED_VIDEO_JOBS = 16;
/** The clip length the default leans toward when a model declares none. */
export const VIDEO_PREFERRED_DURATION_SECONDS = 8;

export const VideoJobId = brandedUuid("VideoJobId");
export type VideoJobId = typeof VideoJobId.Type;
export const VideoClipId = brandedUuid("VideoClipId");
export type VideoClipId = typeof VideoClipId.Type;

export const VIDEO_JOB_AGGREGATE_TYPE = "video-job";
export const VIDEO_JOB_QUEUED = "video.job-queued@1";
export const VIDEO_JOB_STATUS_CHANGED = "video.job-status-changed@1";
export const VIDEO_JOB_PROVIDER_COPY_CHANGED = "video.job-provider-copy-changed@1";
/** Running jobs at once per host, as for image jobs. */
export const VIDEO_JOB_HOST_CONCURRENCY = 2;
export const MAX_VIDEO_PROMPT_CHARACTERS = 32_000;
/** Bounds a provider job id before it reaches the journal; drivers check their own shape. */
const RemoteJobId = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));

export const VIDEO_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const VideoJobStatus = Schema.Literal(...VIDEO_JOB_STATUSES);
export type VideoJobStatus = typeof VideoJobStatus.Type;

export const VideoJobThreadKind = Schema.Literal("chat-thread", "work-thread", "code-thread");
export type VideoJobThreadKind = typeof VideoJobThreadKind.Type;

/**
 * Whether the provider still holds its own copy of the job (prompt, images
 * and clip). `held` is a cleanup the host still owes; it survives a restart
 * and a thread delete, so the retry reaches the profile's key either way.
 */
export const VideoProviderCopy = Schema.Literal("none", "held", "removed", "expires");
export type VideoProviderCopy = typeof VideoProviderCopy.Type;

export const VideoClipRecord = Schema.Struct({
  clipId: VideoClipId,
  hash: ContentDigest,
  size: Schema.Int.pipe(Schema.positive(), Schema.lessThanOrEqualTo(MAX_VIDEO_CLIP_BYTES)),
  durationSeconds: PositiveInt,
  resolution: OptionLabel,
  aspectRatio: OptionLabel,
}).annotations(strict);
export type VideoClipRecord = typeof VideoClipRecord.Type;

/** An estimate in micro-dollars, or `unknown` for a model that publishes no price. */
export const VideoCostEstimateUsdMicros = Schema.Union(NonNegativeInt, Schema.Literal("unknown"));
export type VideoCostEstimateUsdMicros = typeof VideoCostEstimateUsdMicros.Type;

/**
 * One video job as the journal records it. It never holds prompt text, image
 * bytes, clip bytes or a provider download URL: only a prompt hash, the
 * provider's opaque job id, and the stored clip's reference.
 */
export const VideoJob = Schema.Struct({
  id: VideoJobId,
  status: VideoJobStatus,
  threadKind: VideoJobThreadKind,
  scopeId: ImageGenerationScopeId,
  profileInstanceId: ProviderInstanceId,
  driverKind: VideoDriverKind,
  modelId: ProviderModelId,
  promptHash: ContentDigest,
  options: VideoClipOptions,
  imageCount: NonNegativeInt,
  estimatedCostUsdMicros: VideoCostEstimateUsdMicros,
  remoteId: Schema.optional(RemoteJobId),
  startedAt: Schema.optional(UtcTimestamp),
  clip: Schema.optional(VideoClipRecord),
  safetyRefusal: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
  failure: Schema.optional(ProviderFailure),
  providerCopy: VideoProviderCopy,
  settledCostUsdMicros: Schema.optional(NonNegativeInt),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type VideoJob = typeof VideoJob.Type;

export const VideoJobQueued = Schema.Struct({ job: VideoJob }).annotations(strict);
export type VideoJobQueued = typeof VideoJobQueued.Type;

export const VideoJobStatusChanged = Schema.Struct({
  jobId: VideoJobId,
  fromStatus: VideoJobStatus,
  toStatus: VideoJobStatus,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
  remoteId: Schema.optional(RemoteJobId),
  startedAt: Schema.optional(UtcTimestamp),
  clip: Schema.optional(VideoClipRecord),
  safetyRefusal: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
  failure: Schema.optional(ProviderFailure),
  providerCopy: Schema.optional(VideoProviderCopy),
  settledCostUsdMicros: Schema.optional(NonNegativeInt),
}).annotations(strict);
export type VideoJobStatusChanged = typeof VideoJobStatusChanged.Type;

export const VideoJobProviderCopyChanged = Schema.Struct({
  jobId: VideoJobId,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
  providerCopy: VideoProviderCopy,
}).annotations(strict);
export type VideoJobProviderCopyChanged = typeof VideoJobProviderCopyChanged.Type;

export const decodeVideoModelCapabilities = Schema.decodeUnknownSync(VideoModelCapabilities);
export const decodeVideoJobId = Schema.decodeUnknownSync(VideoJobId);
export const decodeVideoClipId = Schema.decodeUnknownSync(VideoClipId);
export const decodeVideoJob = Schema.decodeUnknownSync(VideoJob);
export const decodeVideoJobQueued = Schema.decodeUnknownSync(VideoJobQueued);
export const decodeVideoJobStatusChanged = Schema.decodeUnknownSync(VideoJobStatusChanged);
export const decodeVideoJobProviderCopyChanged = Schema.decodeUnknownSync(
  VideoJobProviderCopyChanged,
);
export const decodeVideoClipOptions = Schema.decodeUnknownSync(VideoClipOptions);
