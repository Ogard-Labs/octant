import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AggregateVersion, UtcTimestamp } from "./events";
import {
  GeminiImageAspectRatio,
  GeminiImageResolution,
  OpenAiImageQuality,
  OpenAiImageSize,
  ProviderFailure,
  ProviderInstanceId,
  ProviderModelId,
} from "./providers";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const ContentDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export const ImageJobId = brandedUuid("ImageJobId");
export type ImageJobId = typeof ImageJobId.Type;
export const ImageArtifactId = brandedUuid("ImageArtifactId");
export type ImageArtifactId = typeof ImageArtifactId.Type;
/**
 * Opaque thread identity the generated-image store scopes bytes under.
 * Chat, Work, and Code thread ids are all UUIDs; this brand keeps the
 * attachment directory from accepting a path.
 */
export const ImageGenerationScopeId = brandedUuid("ImageGenerationScopeId");
export type ImageGenerationScopeId = typeof ImageGenerationScopeId.Type;

/**
 * The one scope the Image generator surface generates into. It is not a
 * thread: every registered window of a host shares it, and its artifacts stay
 * in the host's managed attachment store like any thread's.
 */
export const IMAGE_LIBRARY_SCOPE_ID = Schema.decodeSync(
  ImageGenerationScopeId,
  STRICT_DECODE_OPTIONS,
)("00000000-0000-4000-8000-00000000f1e1");

export const IMAGE_JOB_AGGREGATE_TYPE = "image-job";
export const IMAGE_JOB_QUEUED = "image.job-queued@1";
export const IMAGE_JOB_STATUS_CHANGED = "image.job-status-changed@1";
export const IMAGE_GENERATION_REQUEST_SHAPE = "image-generation";
export const IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE = "interrupted by restart";

export const IMAGE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const ImageJobStatus = Schema.Literals(IMAGE_JOB_STATUSES);
export type ImageJobStatus = typeof ImageJobStatus.Type;

export const IMAGE_JOB_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<ImageJobStatus>;

export const IMAGE_ARTIFACT_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const ImageArtifactMediaType = Schema.Literals(IMAGE_ARTIFACT_MEDIA_TYPES);
export type ImageArtifactMediaType = typeof ImageArtifactMediaType.Type;

export const MAX_GENERATED_IMAGE_BYTES = 20_971_520;
export const THREAD_IMAGE_CHUNK_BYTES = 4 * 1_024 * 1_024;
export const MAX_IMAGE_REFERENCES = 4;
export const MAX_IMAGE_REFERENCE_LABEL_LENGTH = 200;
export const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
export const MAX_IMAGE_VARIANTS = 4;
export const IMAGE_JOB_HOST_CONCURRENCY = 2;

export const ImageArtifactRef = Schema.Struct({
  attachmentId: ImageArtifactId,
  hash: ContentDigest,
  size: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_GENERATED_IMAGE_BYTES)),
  mime: ImageArtifactMediaType,
});
export type ImageArtifactRef = typeof ImageArtifactRef.Type;

/**
 * Provenance the journal keeps for a generated image. Bytes never appear here:
 * only the attachment identity, content digest, and generation evidence.
 */
export const ImageGenerationEvidence = Schema.Struct({
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  promptHash: ContentDigest,
  jobId: ImageJobId,
  parentArtifactRef: Schema.optional(ImageArtifactRef),
});
export type ImageGenerationEvidence = typeof ImageGenerationEvidence.Type;

export const ImageArtifactRecord = Schema.Struct({
  attachmentId: ImageArtifactId,
  hash: ContentDigest,
  size: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_GENERATED_IMAGE_BYTES)),
  mime: ImageArtifactMediaType,
  evidence: ImageGenerationEvidence,
});
export type ImageArtifactRecord = typeof ImageArtifactRecord.Type;

export const ImageJobThreadKind = Schema.Literals([
  "chat-thread",
  "work-thread",
  "code-thread",
  "image-library",
]);
export type ImageJobThreadKind = typeof ImageJobThreadKind.Type;

export const ImageJob = Schema.Struct({
  id: ImageJobId,
  status: ImageJobStatus,
  threadKind: ImageJobThreadKind,
  scopeId: ImageGenerationScopeId,
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  promptHash: ContentDigest,
  parentArtifactRef: Schema.optional(ImageArtifactRef),
  artifacts: Schema.Array(ImageArtifactRecord).check(Schema.isMaxLength(MAX_IMAGE_VARIANTS)),
  safetyRefusal: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  ),
  failure: Schema.optional(ProviderFailure),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
}).check(
  Schema.makeFilter((job) => {
    if (job.updatedAt < job.createdAt) return false;
    const hasArtifacts = job.artifacts.length > 0;
    if (job.status === "completed") {
      return hasArtifacts && job.failure === undefined && job.safetyRefusal === undefined;
    }
    if (job.status === "failed") {
      return !hasArtifacts && (job.failure !== undefined || job.safetyRefusal !== undefined);
    }
    return !hasArtifacts && job.failure === undefined && job.safetyRefusal === undefined;
  }),
);
export type ImageJob = typeof ImageJob.Type;

export const ImageJobQueued = Schema.Struct({ job: ImageJob });
export type ImageJobQueued = typeof ImageJobQueued.Type;

export const ImageJobStatusChanged = Schema.Struct({
  jobId: ImageJobId,
  fromStatus: ImageJobStatus,
  toStatus: ImageJobStatus,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
  recoveryReason: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024)),
  ),
  safetyRefusal: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  ),
  failure: Schema.optional(ProviderFailure),
  artifacts: Schema.optional(
    Schema.Array(ImageArtifactRecord).check(Schema.isMaxLength(MAX_IMAGE_VARIANTS)),
  ),
});
export type ImageJobStatusChanged = typeof ImageJobStatusChanged.Type;

export const decodeImageJobId = Schema.decodeUnknownSync(ImageJobId, STRICT_DECODE_OPTIONS);
export const decodeImageArtifactId = Schema.decodeUnknownSync(
  ImageArtifactId,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationScopeId = Schema.decodeUnknownSync(
  ImageGenerationScopeId,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageJobStatus = Schema.decodeUnknownSync(ImageJobStatus, STRICT_DECODE_OPTIONS);
export const decodeImageArtifactMediaType = Schema.decodeUnknownSync(
  ImageArtifactMediaType,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageArtifactRef = Schema.decodeUnknownSync(
  ImageArtifactRef,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationEvidence = Schema.decodeUnknownSync(
  ImageGenerationEvidence,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageArtifactRecord = Schema.decodeUnknownSync(
  ImageArtifactRecord,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageJob = Schema.decodeUnknownSync(ImageJob, STRICT_DECODE_OPTIONS);
export const decodeImageJobQueued = Schema.decodeUnknownSync(ImageJobQueued, STRICT_DECODE_OPTIONS);
export const decodeImageJobStatusChanged = Schema.decodeUnknownSync(
  ImageJobStatusChanged,
  STRICT_DECODE_OPTIONS,
);

export const IMAGE_USAGE_UNITS_MAX_SIZE_LENGTH = 32;
export const IMAGE_USAGE_UNITS_MAX_QUALITY_LENGTH = 32;

export const ImageUsageUnits = Schema.Struct({
  count: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_IMAGE_VARIANTS)),
  quality: Schema.Literals(["exact", "estimated", "unavailable"]),
  size: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(IMAGE_USAGE_UNITS_MAX_SIZE_LENGTH),
    ),
  ),
  outputQuality: Schema.optional(
    Schema.Trimmed.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(IMAGE_USAGE_UNITS_MAX_QUALITY_LENGTH),
    ),
  ),
});
export type ImageUsageUnits = typeof ImageUsageUnits.Type;
export const decodeImageUsageUnits = Schema.decodeUnknownSync(
  ImageUsageUnits,
  STRICT_DECODE_OPTIONS,
);

export const IMAGE_GENERATION_MAX_CUSTOM_SOURCES = 20;

/**
 * A user-named (providerInstanceId, modelId) pair on an enabled
 * `openai-compatible-http` instance that may also generate images. The instance's own base URL and credential are
 * reused unchanged; nothing here can point at an arbitrary URL.
 */
export const ImageGenerationCustomSource = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
});
export type ImageGenerationCustomSource = typeof ImageGenerationCustomSource.Type;

/**
 * Image generation settings section. Unlike Voice's two fixed slots, a custom
 * image source has no fixed cardinality, so this is a bounded list rather than
 * named settings.
 */
export const ImageGenerationSettings = Schema.Struct({
  customSources: Schema.Array(ImageGenerationCustomSource).check(
    Schema.isMaxLength(IMAGE_GENERATION_MAX_CUSTOM_SOURCES),
  ),
  /**
   * The image profile a thread at Full access generates on when several are
   * ready and its Project keeps no choice. Absent, or naming a profile that is
   * not ready, means the first ready profile.
   */
  defaultProfileInstanceId: Schema.optional(ProviderInstanceId),
});
export type ImageGenerationSettings = typeof ImageGenerationSettings.Type;

export const decodeImageGenerationCustomSource = Schema.decodeUnknownSync(
  ImageGenerationCustomSource,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationSettings = Schema.decodeUnknownSync(
  ImageGenerationSettings,
  STRICT_DECODE_OPTIONS,
);

/**
 * An enabled image profile the renderer may name. Credentials never appear:
 * only the identity, allowlist, and generation defaults the sheet can honor.
 */
export const ImageGenerationProfileView = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
  driverKind: Schema.Literals([
    "openai-image",
    "gemini-native-image",
    "openai-compatible-image",
    "bfl-image",
    "ideogram-image",
    "outside-image",
  ]),
  modelAllowlist: Schema.Array(ProviderModelId).check(Schema.isMinLength(1)),
  defaultModel: ProviderModelId,
  /**
   * Custom image sources only: the label Settings gave the source behind each
   * model, so a surface can name the source a job ran on instead of the whole
   * provider.
   */
  sourceLabels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        modelId: ProviderModelId,
        label: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(120)),
      }),
    ),
  ),
  quality: Schema.optional(OpenAiImageQuality),
  size: Schema.optional(OpenAiImageSize),
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
});
export type ImageGenerationProfileView = typeof ImageGenerationProfileView.Type;

export const ImageGenerationProfilesResponse = Schema.Struct({
  profiles: Schema.Array(ImageGenerationProfileView),
});
export type ImageGenerationProfilesResponse = typeof ImageGenerationProfilesResponse.Type;

/**
 * Reference images ride the HTTP request, never the journal. Base64 is the
 * renderer-facing form; the route decodes to bytes before enqueue.
 */
export const ImageGenerationReferenceInput = Schema.Struct({
  mediaType: ImageArtifactMediaType,
  base64: Schema.NonEmptyString.check(
    Schema.isMaxLength(Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 8),
  ),
});
export type ImageGenerationReferenceInput = typeof ImageGenerationReferenceInput.Type;

export const ImageGenerationEnqueueRequest = Schema.Struct({
  threadKind: ImageJobThreadKind,
  scopeId: ImageGenerationScopeId,
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  prompt: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(MAX_IMAGE_PROMPT_CHARACTERS),
  ),
  variantCount: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_IMAGE_VARIANTS))),
  quality: Schema.optional(OpenAiImageQuality),
  size: Schema.optional(OpenAiImageSize),
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
  parentArtifactRef: Schema.optional(ImageArtifactRef),
  references: Schema.optional(
    Schema.Array(ImageGenerationReferenceInput).check(Schema.isMaxLength(MAX_IMAGE_REFERENCES)),
  ),
});
export type ImageGenerationEnqueueRequest = typeof ImageGenerationEnqueueRequest.Type;

export const ImageGenerationJobsResponse = Schema.Struct({
  jobs: Schema.Array(ImageJob),
});
export type ImageGenerationJobsResponse = typeof ImageGenerationJobsResponse.Type;

export const ImageGenerationSaveRequest = Schema.Struct({
  relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
});
export type ImageGenerationSaveRequest = typeof ImageGenerationSaveRequest.Type;

export const ImageGenerationSaveResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    relativePath: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  }),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  }),
]);
export type ImageGenerationSaveResult = typeof ImageGenerationSaveResult.Type;

export const ImageGenerationOfferId = brandedUuid("ImageGenerationOfferId");
export type ImageGenerationOfferId = typeof ImageGenerationOfferId.Type;

export const MAX_PENDING_IMAGE_GENERATION_OFFERS = 32;

/**
 * The person's answer. `generate` names the profile and model they chose and
 * whether to keep generating with that choice without asking: for the
 * thread's Project, journaled, or for the thread itself when it stands outside
 * a Project (`rememberForThread` keeps its name for clients already built); `agent-draws` lets the agent make the visual with its own output;
 * `save` writes the image a save offer names; `cancel` does nothing.
 */
export const ImageGenerationOfferDecision = Schema.Union([
  Schema.Struct({
    offerId: ImageGenerationOfferId,
    decision: Schema.Literal("generate"),
    profileInstanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    rememberForThread: Schema.Boolean,
    referenceImagesConfirmed: Schema.optional(Schema.Literal(true)),
  }),
  Schema.Struct({
    offerId: ImageGenerationOfferId,
    /** `save` answers a save offer; `agent-draws` a generate offer; `cancel` either. */
    decision: Schema.Literals(["agent-draws", "save", "cancel"]),
  }),
]);
export type ImageGenerationOfferDecision = typeof ImageGenerationOfferDecision.Type;

export const ImageGenerationOfferDecisionResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("image-offer-answered") }),
  Schema.Struct({ kind: Schema.Literal("image-offer-gone") }),
  Schema.Struct({
    kind: Schema.Literal("image-offer-refused"),
    reason: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  }),
]);
export type ImageGenerationOfferDecisionResult = typeof ImageGenerationOfferDecisionResult.Type;

export const decodeImageGenerationOfferId = Schema.decodeUnknownSync(
  ImageGenerationOfferId,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationOfferDecision = Schema.decodeUnknownSync(
  ImageGenerationOfferDecision,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationOfferDecisionResult = Schema.decodeUnknownSync(
  ImageGenerationOfferDecisionResult,
  STRICT_DECODE_OPTIONS,
);

export const decodeImageGenerationProfileView = Schema.decodeUnknownSync(
  ImageGenerationProfileView,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationProfilesResponse = Schema.decodeUnknownSync(
  ImageGenerationProfilesResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationReferenceInput = Schema.decodeUnknownSync(
  ImageGenerationReferenceInput,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationEnqueueRequest = Schema.decodeUnknownSync(
  ImageGenerationEnqueueRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationJobsResponse = Schema.decodeUnknownSync(
  ImageGenerationJobsResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationSaveRequest = Schema.decodeUnknownSync(
  ImageGenerationSaveRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeImageGenerationSaveResult = Schema.decodeUnknownSync(
  ImageGenerationSaveResult,
  STRICT_DECODE_OPTIONS,
);
