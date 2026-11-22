import { Schema } from "effect";
import { ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const PositiveInt = Schema.Int.pipe(Schema.positive());
const NonNegativeInt = Schema.Int.pipe(Schema.nonNegative());
/** A provider's own label for an option, such as "720p" or "16:9". */
const OptionLabel = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(32));

/**
 * The bundled video drivers. Each is a provider plugin on the video seam in
 * `@octant/provider-sdk/video-generation`, admitted by the same activation
 * ladder as image drivers (maintainer decision, 2026-11-22).
 */
export const VIDEO_DRIVER_KINDS = ["gemini-video", "runway-video", "fal-video"] as const;
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

export const decodeVideoModelCapabilities = Schema.decodeUnknownSync(VideoModelCapabilities);
