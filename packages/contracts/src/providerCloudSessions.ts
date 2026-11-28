import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CodeThreadId } from "./code";
import { ProjectId } from "./projects";
import { ProviderInstanceId, ProviderModelId } from "./providers";
import { AggregateVersion, UtcTimestamp } from "./events";

export const PROVIDER_CLOUD_USAGE_AGGREGATE_TYPE = "provider-cloud-usage";
export const PROVIDER_CLOUD_EVENT_NAMES = {
  jobChanged: "provider-cloud.job-changed@1",
  optInChanged: "provider-cloud.opt-in-changed@1",
} as const;
export const PROVIDER_CLOUD_EVENT_NAMES_V2 = {
  jobChanged: "provider-cloud.job-changed@2",
  optInChanged: "provider-cloud.opt-in-changed@2",
} as const;
export const ProviderCloudEventPrincipal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local-window") }),
  Schema.Struct({
    kind: Schema.Literal("person-paired-device"),
    credentialGeneration: PositiveInt,
  }),
]);
export type ProviderCloudEventPrincipal = typeof ProviderCloudEventPrincipal.Type;
export const ProviderCloudJobId = Schema.String.pipe(
  Schema.check(Schema.isGUID()),
  Schema.brand("ProviderCloudJobId"),
);
export type ProviderCloudJobId = typeof ProviderCloudJobId.Type;
export const ProviderCloudRemoteId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  Schema.brand("ProviderCloudRemoteId"),
);
export type ProviderCloudRemoteId = typeof ProviderCloudRemoteId.Type;
export const ProviderCloudInputDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  Schema.brand("ProviderCloudInputDigest"),
);
export type ProviderCloudInputDigest = typeof ProviderCloudInputDigest.Type;
export const MAX_PROVIDER_CLOUD_INPUT = 16_000;
export const MAX_PROVIDER_CLOUD_OUTPUT = 32_000;
export const ProviderCloudJobState = Schema.Literals([
  "submitting",
  "submission-uncertain",
  "running",
  "completed",
  "failed",
  "cancel-requested",
  "cancelled",
  "unavailable",
]);
export type ProviderCloudJobState = typeof ProviderCloudJobState.Type;
export const ProviderCloudJob = Schema.Struct({
  id: ProviderCloudJobId,
  version: AggregateVersion,
  threadId: CodeThreadId,
  projectId: ProjectId,
  instanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  inputDigest: ProviderCloudInputDigest,
  input: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_CLOUD_INPUT)),
  state: ProviderCloudJobState,
  remoteId: Schema.optional(ProviderCloudRemoteId),
  output: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_CLOUD_OUTPUT)),
  truncated: Schema.Boolean,
  createdAt: UtcTimestamp,
  updatedAt: UtcTimestamp,
  uncertaintyAcknowledgedAt: Schema.optional(UtcTimestamp),
});
export type ProviderCloudJob = typeof ProviderCloudJob.Type;

// The person reviews and consents to the exact text, and its digest covers
// every byte; trimming here would refuse ordinary pasted prompts (a trailing
// newline, leading indentation) that review already accepted.
const ProviderCloudTaskText = Schema.String.check(
  Schema.isMaxLength(MAX_PROVIDER_CLOUD_INPUT),
  Schema.makeFilter((value) => value.trim().length > 0, {
    message: "Cloud task text must not be blank.",
  }),
);
export const ProviderCloudRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("profiles") }),
  Schema.Struct({ kind: Schema.Literal("list"), threadId: CodeThreadId }),
  Schema.Struct({
    kind: Schema.Literal("opt-in"),
    instanceId: ProviderInstanceId,
    enabled: Schema.Boolean,
  }),
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
        Schema.Struct({ jobId: ProviderCloudJobId, expectedVersion: AggregateVersion }),
      ).check(Schema.isMaxLength(16)),
    ),
  }),
  Schema.Struct({ kind: Schema.Literals(["read", "cancel"]), jobId: ProviderCloudJobId }),
]);
export type ProviderCloudRequest = typeof ProviderCloudRequest.Type;
export const ProviderCloudProfile = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String.check(Schema.isMaxLength(200)),
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  models: Schema.Array(ProviderModelId).check(Schema.isMaxLength(256)),
});
export const ProviderCloudResponse = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    profiles: Schema.Array(ProviderCloudProfile).check(Schema.isMaxLength(128)),
    jobs: Schema.Array(ProviderCloudJob).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals([
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
    ]),
  }),
]);
export type ProviderCloudResponse = typeof ProviderCloudResponse.Type;
export const ProviderCloudJobChangedV1Payload = Schema.Struct({
  threadId: ProviderCloudJob.fields.threadId,
  job: ProviderCloudJob,
});
export type ProviderCloudJobChangedV1Payload = typeof ProviderCloudJobChangedV1Payload.Type;
export const ProviderCloudOptInChangedV1Payload = Schema.Struct({
  instanceId: ProviderCloudJob.fields.instanceId,
  enabled: Schema.Boolean,
});
export type ProviderCloudOptInChangedV1Payload = typeof ProviderCloudOptInChangedV1Payload.Type;
export const ProviderCloudJobChangedV2Payload = Schema.Struct({
  threadId: ProviderCloudJob.fields.threadId,
  job: ProviderCloudJob,
  principal: ProviderCloudEventPrincipal,
});
export type ProviderCloudJobChangedV2Payload = typeof ProviderCloudJobChangedV2Payload.Type;
export const ProviderCloudOptInChangedV2Payload = Schema.Struct({
  instanceId: ProviderCloudJob.fields.instanceId,
  enabled: Schema.Boolean,
  principal: ProviderCloudEventPrincipal,
});
export type ProviderCloudOptInChangedV2Payload = typeof ProviderCloudOptInChangedV2Payload.Type;
export const decodeProviderCloudJobChangedV1Payload = Schema.decodeUnknownSync(
  ProviderCloudJobChangedV1Payload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudOptInChangedV1Payload = Schema.decodeUnknownSync(
  ProviderCloudOptInChangedV1Payload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudJobChangedV2Payload = Schema.decodeUnknownSync(
  ProviderCloudJobChangedV2Payload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudOptInChangedV2Payload = Schema.decodeUnknownSync(
  ProviderCloudOptInChangedV2Payload,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudRequest = Schema.decodeUnknownSync(
  ProviderCloudRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudResponse = Schema.decodeUnknownSync(
  ProviderCloudResponse,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudJob = Schema.decodeUnknownSync(
  ProviderCloudJob,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudJobId = Schema.decodeUnknownSync(
  ProviderCloudJobId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudRemoteId = Schema.decodeUnknownSync(
  ProviderCloudRemoteId,
  STRICT_DECODE_OPTIONS,
);
export const decodeProviderCloudInputDigest = Schema.decodeUnknownSync(
  ProviderCloudInputDigest,
  STRICT_DECODE_OPTIONS,
);
export const ProviderCloudCreateInput = Schema.Struct({
  jobId: ProviderCloudJobId,
  modelId: ProviderModelId,
  text: ProviderCloudTaskText,
});
export const ProviderCloudObservation = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("observed"),
    remoteId: ProviderCloudRemoteId,
    state: Schema.Literals(["running", "completed", "failed", "cancelled"]),
    output: Schema.String.check(Schema.isMaxLength(MAX_PROVIDER_CLOUD_OUTPUT)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({ status: Schema.Literals(["unavailable", "uncertain", "unsupported"]) }),
]);
export const ProviderCloudCancelResult = Schema.Struct({
  status: Schema.Literals(["requested", "uncertain", "unavailable"]),
});
