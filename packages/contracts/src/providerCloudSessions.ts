import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE = "provider-cloud-usage";
export const ProviderCloudJobId = Schema.UUID.pipe(Schema.brand("ProviderCloudJobId"));
export type ProviderCloudJobId = typeof ProviderCloudJobId.Type;
export const ProviderCloudRemoteId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{1,128}$/),
  Schema.brand("ProviderCloudRemoteId"),
);
export type ProviderCloudRemoteId = typeof ProviderCloudRemoteId.Type;
export const ProviderCloudInputDigest = Schema.String.pipe(
  Schema.pattern(/^[a-f0-9]{64}$/),
  Schema.brand("ProviderCloudInputDigest"),
);
export type ProviderCloudInputDigest = typeof ProviderCloudInputDigest.Type;
export const MAX_PROVIDER_CLOUD_INPUT = 16_000;
export const MAX_PROVIDER_CLOUD_OUTPUT = 32_000;
export const ProviderCloudJobState = Schema.Literal(
  "submitting",
  "submission-uncertain",
  "running",
  "completed",
  "failed",
  "cancel-requested",
  "cancelled",
  "unavailable",
);
export type ProviderCloudJobState = typeof ProviderCloudJobState.Type;
export const ProviderCloudJob = Schema.Struct({
  id: ProviderCloudJobId,
  version: AggregateVersion,
  threadId: CodeThreadId,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  inputDigest: ProviderCloudInputDigest,
  input: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_CLOUD_INPUT)),
  state: ProviderCloudJobState,
  remoteId: Schema.optional(ProviderCloudRemoteId),
  output: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_CLOUD_OUTPUT)),
  truncated: Schema.Boolean,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  uncertaintyAcknowledgedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ProviderCloudJob = typeof ProviderCloudJob.Type;

export const ProviderCloudRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("profiles") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("list"), threadId: CodeThreadId }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("opt-in"),
    instanceId: ProviderInstanceId,
    enabled: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("start"),
    jobId: ProviderCloudJobId,
    threadId: CodeThreadId,
    instanceId: ProviderInstanceId,
    modelId: ProviderModelId,
    input: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_PROVIDER_CLOUD_INPUT)),
    reviewedInputDigest: ProviderCloudInputDigest,
    cloudExecutionConsent: Schema.Literal(true),
    acknowledgedUnknownJobs: Schema.optional(
      Schema.Array(
        Schema.Struct({ jobId: ProviderCloudJobId, expectedVersion: AggregateVersion }).annotations(
          strict,
        ),
      ).pipe(Schema.maxItems(16)),
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("read", "cancel"), jobId: ProviderCloudJobId }).annotations(
    strict,
  ),
).annotations(strict);
export type ProviderCloudRequest = typeof ProviderCloudRequest.Type;
export const ProviderCloudProfile = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String.pipe(Schema.maxLength(200)),
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  models: Schema.Array(ProviderModelId).pipe(Schema.maxItems(256)),
}).annotations(strict);
export const ProviderCloudResponse = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("ready"),
    profiles: Schema.Array(ProviderCloudProfile).pipe(Schema.maxItems(128)),
    jobs: Schema.Array(ProviderCloudJob).pipe(Schema.maxItems(100)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal(
      "unavailable",
      "unauthorized",
      "plan",
      "opt-in-required",
      "review-required",
      "unsupported-budget",
      "busy",
      "unknown-job",
      "journal-unavailable",
    ),
  }).annotations(strict),
).annotations(strict);
export type ProviderCloudResponse = typeof ProviderCloudResponse.Type;
export const decodeProviderCloudRequest = Schema.decodeUnknownSync(ProviderCloudRequest);
export const decodeProviderCloudResponse = Schema.decodeUnknownSync(ProviderCloudResponse);
export const decodeProviderCloudJob = Schema.decodeUnknownSync(ProviderCloudJob);
export const decodeProviderCloudJobId = Schema.decodeUnknownSync(ProviderCloudJobId);
export const decodeProviderCloudRemoteId = Schema.decodeUnknownSync(ProviderCloudRemoteId);
export const decodeProviderCloudInputDigest = Schema.decodeUnknownSync(ProviderCloudInputDigest);
export const ProviderCloudCreateInput = Schema.Struct({
  jobId: ProviderCloudJobId,
  modelId: ProviderModelId,
  text: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(MAX_PROVIDER_CLOUD_INPUT)),
}).annotations(strict);
export const ProviderCloudObservation = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("observed"),
    remoteId: ProviderCloudRemoteId,
    state: Schema.Literal("running", "completed", "failed", "cancelled"),
    output: Schema.String.pipe(Schema.maxLength(MAX_PROVIDER_CLOUD_OUTPUT)),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("unavailable", "uncertain", "unsupported") }).annotations(
    strict,
  ),
).annotations(strict);
export const ProviderCloudCancelResult = Schema.Struct({
  status: Schema.Literal("requested", "uncertain", "unavailable"),
}).annotations(strict);
