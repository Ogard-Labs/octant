import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { AggregateVersion, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE = "provider-cloud-usage";
export const PROVIDER_CLOUD_EVENT_NAMES = {
  jobChanged: "provider-cloud.job-changed@1",
  optInChanged: "provider-cloud.opt-in-changed@1",
} as const;
export const PROVIDER_CLOUD_EVENT_NAMES_V2 = {
  jobChanged: "provider-cloud.job-changed@2",
  optInChanged: "provider-cloud.opt-in-changed@2",
} as const;
export const ProviderCloudEventPrincipal = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("local-window") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("person-paired-device"),
    credentialGeneration: Schema.Int.pipe(Schema.positive()),
  }).annotations(strict),
);
export type ProviderCloudEventPrincipal = typeof ProviderCloudEventPrincipal.Type;
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

// The person reviews and consents to the exact text, and its digest covers
// every byte; trimming here would refuse ordinary pasted prompts (a trailing
// newline, leading indentation) that review already accepted.
const ProviderCloudTaskText = Schema.String.pipe(
  Schema.maxLength(MAX_PROVIDER_CLOUD_INPUT),
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Cloud task text must not be blank.",
  }),
);
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
    input: ProviderCloudTaskText,
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
      "credential-unlock-needs-this-computer",
      "busy",
      "unknown-job",
      "journal-unavailable",
    ),
  }).annotations(strict),
).annotations(strict);
export type ProviderCloudResponse = typeof ProviderCloudResponse.Type;
export const ProviderCloudJobChangedV1Payload = Schema.Struct({
  threadId: ProviderCloudJob.fields.threadId,
  job: ProviderCloudJob,
}).annotations(strict);
export type ProviderCloudJobChangedV1Payload = typeof ProviderCloudJobChangedV1Payload.Type;
export const ProviderCloudOptInChangedV1Payload = Schema.Struct({
  instanceId: ProviderCloudJob.fields.instanceId,
  enabled: Schema.Boolean,
}).annotations(strict);
export type ProviderCloudOptInChangedV1Payload = typeof ProviderCloudOptInChangedV1Payload.Type;
export const ProviderCloudJobChangedV2Payload = Schema.Struct({
  threadId: ProviderCloudJob.fields.threadId,
  job: ProviderCloudJob,
  principal: ProviderCloudEventPrincipal,
}).annotations(strict);
export type ProviderCloudJobChangedV2Payload = typeof ProviderCloudJobChangedV2Payload.Type;
export const ProviderCloudOptInChangedV2Payload = Schema.Struct({
  instanceId: ProviderCloudJob.fields.instanceId,
  enabled: Schema.Boolean,
  principal: ProviderCloudEventPrincipal,
}).annotations(strict);
export type ProviderCloudOptInChangedV2Payload = typeof ProviderCloudOptInChangedV2Payload.Type;
export const decodeProviderCloudJobChangedV1Payload = Schema.decodeUnknownSync(
  ProviderCloudJobChangedV1Payload,
);
export const decodeProviderCloudOptInChangedV1Payload = Schema.decodeUnknownSync(
  ProviderCloudOptInChangedV1Payload,
);
export const decodeProviderCloudJobChangedV2Payload = Schema.decodeUnknownSync(
  ProviderCloudJobChangedV2Payload,
);
export const decodeProviderCloudOptInChangedV2Payload = Schema.decodeUnknownSync(
  ProviderCloudOptInChangedV2Payload,
);
export const decodeProviderCloudRequest = Schema.decodeUnknownSync(ProviderCloudRequest);
export const decodeProviderCloudResponse = Schema.decodeUnknownSync(ProviderCloudResponse);
export const decodeProviderCloudJob = Schema.decodeUnknownSync(ProviderCloudJob);
export const decodeProviderCloudJobId = Schema.decodeUnknownSync(ProviderCloudJobId);
export const decodeProviderCloudRemoteId = Schema.decodeUnknownSync(ProviderCloudRemoteId);
export const decodeProviderCloudInputDigest = Schema.decodeUnknownSync(ProviderCloudInputDigest);
export const ProviderCloudCreateInput = Schema.Struct({
  jobId: ProviderCloudJobId,
  modelId: ProviderModelId,
  text: ProviderCloudTaskText,
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
