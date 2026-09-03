import { Schema } from "effect";
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

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());
const ContentDigest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/));

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
export const IMAGE_LIBRARY_SCOPE_ID = Schema.decodeSync(ImageGenerationScopeId)(
  "00000000-0000-4000-8000-00000000f1e1",
);

export const IMAGE_JOB_AGGREGATE_TYPE = "image-job";
export const IMAGE_JOB_QUEUED = "image.job-queued@1";
export const IMAGE_JOB_STATUS_CHANGED = "image.job-status-changed@1";
export const IMAGE_JOB_EVENT_NAMES = [IMAGE_JOB_QUEUED, IMAGE_JOB_STATUS_CHANGED] as const;
export const IMAGE_GENERATION_REQUEST_SHAPE = "image-generation";
export const IMAGE_JOB_RESTART_INTERRUPTION_MESSAGE = "interrupted by restart";

export const IMAGE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export const ImageJobStatus = Schema.Literal(...IMAGE_JOB_STATUSES);
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
export const ImageArtifactMediaType = Schema.Literal(...IMAGE_ARTIFACT_MEDIA_TYPES);
export type ImageArtifactMediaType = typeof ImageArtifactMediaType.Type;

export const MAX_GENERATED_IMAGE_BYTES = 20_971_520;
export const MAX_IMAGE_PROMPT_CHARACTERS = 32_000;
export const MAX_IMAGE_VARIANTS = 4;
export const IMAGE_JOB_HOST_CONCURRENCY = 2;

export const ImageArtifactRef = Schema.Struct({
  attachmentId: ImageArtifactId,
  hash: ContentDigest,
  size: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_GENERATED_IMAGE_BYTES)),
  mime: ImageArtifactMediaType,
}).annotations(strict);
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
}).annotations(strict);
export type ImageGenerationEvidence = typeof ImageGenerationEvidence.Type;

export const ImageArtifactRecord = Schema.Struct({
  attachmentId: ImageArtifactId,
  hash: ContentDigest,
  size: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_GENERATED_IMAGE_BYTES)),
  mime: ImageArtifactMediaType,
  evidence: ImageGenerationEvidence,
}).annotations(strict);
export type ImageArtifactRecord = typeof ImageArtifactRecord.Type;

export const ImageJobThreadKind = Schema.Literal(
  "chat-thread",
  "work-thread",
  "code-thread",
  "image-library",
);
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
  artifacts: Schema.Array(ImageArtifactRecord).pipe(Schema.maxItems(MAX_IMAGE_VARIANTS)),
  safetyRefusal: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
  failure: Schema.optional(ProviderFailure),
  version: AggregateVersion,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
})
  .annotations(strict)
  .pipe(
    Schema.filter((job) => {
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

export const ImageJobQueued = Schema.Struct({ job: ImageJob }).annotations(strict);
export type ImageJobQueued = typeof ImageJobQueued.Type;

export const ImageJobStatusChanged = Schema.Struct({
  jobId: ImageJobId,
  fromStatus: ImageJobStatus,
  toStatus: ImageJobStatus,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
  recoveryReason: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1_024))),
  safetyRefusal: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000))),
  failure: Schema.optional(ProviderFailure),
  artifacts: Schema.optional(
    Schema.Array(ImageArtifactRecord).pipe(Schema.maxItems(MAX_IMAGE_VARIANTS)),
  ),
}).annotations(strict);
export type ImageJobStatusChanged = typeof ImageJobStatusChanged.Type;

export const decodeImageJobId = Schema.decodeUnknownSync(ImageJobId);
export const decodeImageArtifactId = Schema.decodeUnknownSync(ImageArtifactId);
export const decodeImageGenerationScopeId = Schema.decodeUnknownSync(ImageGenerationScopeId);
export const decodeImageJobStatus = Schema.decodeUnknownSync(ImageJobStatus);
export const decodeImageArtifactMediaType = Schema.decodeUnknownSync(ImageArtifactMediaType);
export const decodeImageArtifactRef = Schema.decodeUnknownSync(ImageArtifactRef);
export const decodeImageGenerationEvidence = Schema.decodeUnknownSync(ImageGenerationEvidence);
export const decodeImageArtifactRecord = Schema.decodeUnknownSync(ImageArtifactRecord);
export const decodeImageJob = Schema.decodeUnknownSync(ImageJob);
export const decodeImageJobQueued = Schema.decodeUnknownSync(ImageJobQueued);
export const decodeImageJobStatusChanged = Schema.decodeUnknownSync(ImageJobStatusChanged);

export const IMAGE_USAGE_UNITS_MAX_SIZE_LENGTH = 32;
export const IMAGE_USAGE_UNITS_MAX_QUALITY_LENGTH = 32;

export const ImageUsageUnits = Schema.Struct({
  count: PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_IMAGE_VARIANTS)),
  quality: Schema.Literal("exact", "estimated", "unavailable"),
  size: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(IMAGE_USAGE_UNITS_MAX_SIZE_LENGTH)),
  ),
  outputQuality: Schema.optional(
    Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(IMAGE_USAGE_UNITS_MAX_QUALITY_LENGTH)),
  ),
}).annotations(strict);
export type ImageUsageUnits = typeof ImageUsageUnits.Type;
export const decodeImageUsageUnits = Schema.decodeUnknownSync(ImageUsageUnits);

/**
 * An enabled image profile the renderer may name. Credentials never appear:
 * only the identity, allowlist, and generation defaults the sheet can honor.
 */
export const ImageGenerationProfileView = Schema.Struct({
  instanceId: ProviderInstanceId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120)),
  driverKind: Schema.Literal("openai-image", "gemini-native-image"),
  modelAllowlist: Schema.Array(ProviderModelId).pipe(Schema.minItems(1)),
  defaultModel: ProviderModelId,
  quality: Schema.optional(OpenAiImageQuality),
  size: Schema.optional(OpenAiImageSize),
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
}).annotations(strict);
export type ImageGenerationProfileView = typeof ImageGenerationProfileView.Type;

export const ImageGenerationProfilesResponse = Schema.Struct({
  profiles: Schema.Array(ImageGenerationProfileView),
}).annotations(strict);
export type ImageGenerationProfilesResponse = typeof ImageGenerationProfilesResponse.Type;

/**
 * Reference images ride the HTTP request, never the journal. Base64 is the
 * renderer-facing form; the route decodes to bytes before enqueue.
 */
export const ImageGenerationReferenceInput = Schema.Struct({
  mediaType: ImageArtifactMediaType,
  base64: Schema.NonEmptyString.pipe(
    Schema.maxLength(Math.ceil((MAX_GENERATED_IMAGE_BYTES * 4) / 3) + 8),
  ),
}).annotations(strict);
export type ImageGenerationReferenceInput = typeof ImageGenerationReferenceInput.Type;

export const ImageGenerationEnqueueRequest = Schema.Struct({
  threadKind: ImageJobThreadKind,
  scopeId: ImageGenerationScopeId,
  profileInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  prompt: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_IMAGE_PROMPT_CHARACTERS)),
  variantCount: Schema.optional(PositiveInt.pipe(Schema.lessThanOrEqualTo(MAX_IMAGE_VARIANTS))),
  quality: Schema.optional(OpenAiImageQuality),
  size: Schema.optional(OpenAiImageSize),
  aspectRatio: Schema.optional(GeminiImageAspectRatio),
  resolution: Schema.optional(GeminiImageResolution),
  parentArtifactRef: Schema.optional(ImageArtifactRef),
  references: Schema.optional(Schema.Array(ImageGenerationReferenceInput).pipe(Schema.maxItems(4))),
}).annotations(strict);
export type ImageGenerationEnqueueRequest = typeof ImageGenerationEnqueueRequest.Type;

export const ImageGenerationJobsResponse = Schema.Struct({
  jobs: Schema.Array(ImageJob),
}).annotations(strict);
export type ImageGenerationJobsResponse = typeof ImageGenerationJobsResponse.Type;

export const ImageGenerationSaveRequest = Schema.Struct({
  relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
}).annotations(strict);
export type ImageGenerationSaveRequest = typeof ImageGenerationSaveRequest.Type;

export const ImageGenerationSaveResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("saved"),
    relativePath: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)),
  }).annotations(strict),
);
export type ImageGenerationSaveResult = typeof ImageGenerationSaveResult.Type;

export const decodeImageGenerationProfileView = Schema.decodeUnknownSync(
  ImageGenerationProfileView,
);
export const decodeImageGenerationProfilesResponse = Schema.decodeUnknownSync(
  ImageGenerationProfilesResponse,
);
export const decodeImageGenerationReferenceInput = Schema.decodeUnknownSync(
  ImageGenerationReferenceInput,
);
export const decodeImageGenerationEnqueueRequest = Schema.decodeUnknownSync(
  ImageGenerationEnqueueRequest,
);
export const decodeImageGenerationJobsResponse = Schema.decodeUnknownSync(
  ImageGenerationJobsResponse,
);
export const decodeImageGenerationSaveRequest = Schema.decodeUnknownSync(
  ImageGenerationSaveRequest,
);
export const decodeImageGenerationSaveResult = Schema.decodeUnknownSync(ImageGenerationSaveResult);
