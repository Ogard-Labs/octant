import { Schema } from "effect";
import {
  AgentRunResultEvidence,
  AgentRunReviewMetadata,
  AgentRunReviewSnapshot,
  AgentRunId,
  AgentRunParentThreadId,
  AgentRunExecutionKind,
  AgentRunLifecycleStatus,
  AgentRunWorkspaceReceipt,
} from "./agentRun";
import { OctantMode } from "./modes";
import { UtcTimestamp } from "./events";
import { ProviderChildObservation, ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const AgentObservedChild = Schema.Struct({
  ...ProviderChildObservation.fields,
  kind: Schema.Literal("observed"),
  observationId: Schema.NonEmptyString.pipe(Schema.maxLength(2048)),
  parentThreadId: AgentRunParentThreadId,
  parentRunId: Schema.optional(AgentRunId),
  mode: OctantMode,
  /**
   * `stop` only while the thread's running turn holds a connection that can
   * stop this one child without stopping the turn, and the child has not
   * finished; everything else is read-only.
   */
  control: Schema.Literal("unavailable", "stop"),
}).annotations(strict);
export type AgentObservedChild = typeof AgentObservedChild.Type;
export const decodeAgentObservedChild = Schema.decodeUnknownSync(AgentObservedChild);

/** Asks the thread's running turn to stop one subagent its runtime started. */
export const AgentObservedChildStopRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
  observationId: AgentObservedChild.fields.observationId,
}).annotations(strict);
export type AgentObservedChildStopRequest = typeof AgentObservedChildStopRequest.Type;
export const decodeAgentObservedChildStopRequest = Schema.decodeUnknownSync(
  AgentObservedChildStopRequest,
);

/**
 * How a stop request settled. `stop-requested` means the runtime was asked;
 * the child reads as stopped only once the runtime reports it finished.
 * `not-live` when the thread has no running turn or the child belongs to an
 * earlier one, `unsupported` when the runtime cannot stop one child alone,
 * `not-found` when no running child matches, and `unauthorized` when the
 * window does not hold the thread.
 */
export const AgentObservedChildStopResponse = Schema.Union(
  Schema.Struct({ status: Schema.Literal("stop-requested") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literal("not-found", "unsupported", "not-live", "unauthorized"),
  }).annotations(strict),
);
export type AgentObservedChildStopResponse = typeof AgentObservedChildStopResponse.Type;
export const decodeAgentObservedChildStopResponse = Schema.decodeUnknownSync(
  AgentObservedChildStopResponse,
);
export const MAX_AGENT_RESULT_PACKETS = 16;
export const MAX_AGENT_RESULT_SUMMARY_CHARACTERS = 4096;
export const AgentRunResultPacket = Schema.Struct({
  runId: AgentRunId,
  parentThreadId: AgentRunParentThreadId,
  generation: Schema.Int.pipe(Schema.positive()),
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executionKind: AgentRunExecutionKind,
  workspace: AgentRunWorkspaceReceipt,
  lifecycleStatus: AgentRunLifecycleStatus,
  occurredAt: UtcTimestamp,
  reportedSummary: Schema.Struct({
    status: Schema.Literal("available", "unavailable"),
    reference: Schema.optional(Schema.NonEmptyString.pipe(Schema.maxLength(2048))),
    text: Schema.optional(
      Schema.String.pipe(Schema.maxLength(MAX_AGENT_RESULT_SUMMARY_CHARACTERS)),
    ),
    truncated: Schema.Boolean,
  }).annotations(strict),
  workingTime: AgentRunResultEvidence.fields.workingTime,
  files: AgentRunResultEvidence.fields.files,
  checks: AgentRunResultEvidence.fields.checks,
  review: Schema.optional(AgentRunReviewMetadata),
  blockers: Schema.Struct({
    status: Schema.Literal("recorded", "unavailable", "truncated"),
    items: Schema.Array(
      Schema.Struct({
        text: Schema.NonEmptyString.pipe(Schema.maxLength(1024)),
        reference: Schema.NonEmptyString.pipe(Schema.maxLength(2048)),
        source: Schema.Literal("lifecycle"),
      }).annotations(strict),
    ).pipe(Schema.maxItems(32)),
  }).annotations(strict),
}).annotations(strict);
export type AgentRunResultPacket = typeof AgentRunResultPacket.Type;
export const AgentRunResultsResponse = Schema.Struct({
  runId: AgentRunId,
  packets: Schema.Array(AgentRunResultPacket).pipe(Schema.maxItems(MAX_AGENT_RESULT_PACKETS)),
  truncated: Schema.Boolean,
}).annotations(strict);
export type AgentRunResultsResponse = typeof AgentRunResultsResponse.Type;
export const decodeAgentRunResultsResponse = Schema.decodeUnknownSync(AgentRunResultsResponse);

const reviewIdentity = {
  runId: AgentRunId,
  parentThreadId: AgentRunParentThreadId,
  generation: Schema.Int.pipe(Schema.positive()),
};
export const AgentRunReviewResponse = Schema.Union(
  Schema.Struct({
    ...reviewIdentity,
    status: Schema.Literal("available"),
    snapshot: AgentRunReviewSnapshot,
  }).annotations(strict),
  Schema.Struct({ ...reviewIdentity, status: Schema.Literal("unavailable") }).annotations(strict),
);
export type AgentRunReviewResponse = typeof AgentRunReviewResponse.Type;
export const decodeAgentRunReviewResponse = Schema.decodeUnknownSync(AgentRunReviewResponse);
