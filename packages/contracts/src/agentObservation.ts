import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
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

export const AgentObservedChild = Schema.Struct({
  ...ProviderChildObservation.fields,
  kind: Schema.Literal("observed"),
  observationId: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  parentThreadId: AgentRunParentThreadId,
  parentRunId: Schema.optional(AgentRunId),
  mode: OctantMode,
  /**
   * `stop` only while the thread's running turn holds a connection that can
   * stop this one child without stopping the turn, and the child has not
   * finished; everything else is read-only.
   */
  control: Schema.Literals(["unavailable", "stop"]),
  /**
   * The further controls the thread's running turn offers for this running
   * child: `background` sends it to the background so the turn goes on, and
   * `message` queues a note it reads with its next tool call. Absent or
   * empty, only `control` applies.
   */
  steering: Schema.optional(Schema.Array(Schema.Literals(["background", "message"]))),
});
export type AgentObservedChild = typeof AgentObservedChild.Type;
export const decodeAgentObservedChild = Schema.decodeUnknownSync(
  AgentObservedChild,
  STRICT_DECODE_OPTIONS,
);

/** Asks the thread's running turn to stop one subagent its runtime started. */
export const AgentObservedChildStopRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
  observationId: AgentObservedChild.fields.observationId,
});
export type AgentObservedChildStopRequest = typeof AgentObservedChildStopRequest.Type;
export const decodeAgentObservedChildStopRequest = Schema.decodeUnknownSync(
  AgentObservedChildStopRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * How a stop request settled. `stop-requested` means the runtime was asked;
 * the child reads as stopped only once the runtime reports it finished.
 * `not-live` when the thread has no running turn or the child belongs to an
 * earlier one, `unsupported` when the runtime cannot stop one child alone,
 * `not-found` when no running child matches, and `unauthorized` when the
 * window does not hold the thread.
 */
export const AgentObservedChildStopResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("stop-requested") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "unsupported", "not-live", "unauthorized"]),
  }),
]);
export type AgentObservedChildStopResponse = typeof AgentObservedChildStopResponse.Type;
export const decodeAgentObservedChildStopResponse = Schema.decodeUnknownSync(
  AgentObservedChildStopResponse,
  STRICT_DECODE_OPTIONS,
);
/** Asks the thread's running turn to send one subagent its runtime started to the background. */
export const AgentObservedChildBackgroundRequest = AgentObservedChildStopRequest;
export type AgentObservedChildBackgroundRequest = AgentObservedChildStopRequest;
export const decodeAgentObservedChildBackgroundRequest = decodeAgentObservedChildStopRequest;

/** How a background request settled; the refusals read as a stop's do. */
export const AgentObservedChildBackgroundResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("backgrounded") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "unsupported", "not-live", "unauthorized"]),
  }),
]);
export type AgentObservedChildBackgroundResponse = typeof AgentObservedChildBackgroundResponse.Type;
export const decodeAgentObservedChildBackgroundResponse = Schema.decodeUnknownSync(
  AgentObservedChildBackgroundResponse,
  STRICT_DECODE_OPTIONS,
);

export const MAX_AGENT_OBSERVED_CHILD_MESSAGE_CHARACTERS = 4096;
/** A person's message for one running subagent its runtime started. */
export const AgentObservedChildMessageRequest = Schema.Struct({
  parentThreadId: AgentRunParentThreadId,
  observationId: AgentObservedChild.fields.observationId,
  message: Schema.String.check(
    Schema.makeFilter(
      (value) =>
        value.trim().length > 0 && value.length <= MAX_AGENT_OBSERVED_CHILD_MESSAGE_CHARACTERS,
    ),
  ),
});
export type AgentObservedChildMessageRequest = typeof AgentObservedChildMessageRequest.Type;
export const decodeAgentObservedChildMessageRequest = Schema.decodeUnknownSync(
  AgentObservedChildMessageRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * How a message settled. `queued` means the subagent reads it with its next
 * tool call; one that makes none before it finishes never does.
 */
export const AgentObservedChildMessageResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("queued") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "unsupported", "not-live", "unauthorized"]),
  }),
]);
export type AgentObservedChildMessageResponse = typeof AgentObservedChildMessageResponse.Type;
export const decodeAgentObservedChildMessageResponse = Schema.decodeUnknownSync(
  AgentObservedChildMessageResponse,
  STRICT_DECODE_OPTIONS,
);
export const MAX_AGENT_RESULT_PACKETS = 16;
export const MAX_AGENT_RESULT_SUMMARY_CHARACTERS = 4096;
export const AgentRunResultPacket = Schema.Struct({
  runId: AgentRunId,
  parentThreadId: AgentRunParentThreadId,
  generation: PositiveInt,
  providerInstanceId: ProviderInstanceId,
  modelId: ProviderModelId,
  executionKind: AgentRunExecutionKind,
  workspace: AgentRunWorkspaceReceipt,
  lifecycleStatus: AgentRunLifecycleStatus,
  occurredAt: UtcTimestamp,
  reportedSummary: Schema.Struct({
    status: Schema.Literals(["available", "unavailable"]),
    reference: Schema.optional(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
    text: Schema.optional(
      Schema.String.check(Schema.isMaxLength(MAX_AGENT_RESULT_SUMMARY_CHARACTERS)),
    ),
    truncated: Schema.Boolean,
  }),
  workingTime: AgentRunResultEvidence.fields.workingTime,
  files: AgentRunResultEvidence.fields.files,
  checks: AgentRunResultEvidence.fields.checks,
  review: Schema.optional(AgentRunReviewMetadata),
  blockers: Schema.Struct({
    status: Schema.Literals(["recorded", "unavailable", "truncated"]),
    items: Schema.Array(
      Schema.Struct({
        text: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
        reference: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
        source: Schema.Literal("lifecycle"),
      }),
    ).check(Schema.isMaxLength(32)),
  }),
});
export type AgentRunResultPacket = typeof AgentRunResultPacket.Type;
export const AgentRunResultsResponse = Schema.Struct({
  runId: AgentRunId,
  packets: Schema.Array(AgentRunResultPacket).check(Schema.isMaxLength(MAX_AGENT_RESULT_PACKETS)),
  truncated: Schema.Boolean,
});
export type AgentRunResultsResponse = typeof AgentRunResultsResponse.Type;
export const decodeAgentRunResultsResponse = Schema.decodeUnknownSync(
  AgentRunResultsResponse,
  STRICT_DECODE_OPTIONS,
);

const reviewIdentity = {
  runId: AgentRunId,
  parentThreadId: AgentRunParentThreadId,
  generation: PositiveInt,
};
export const AgentRunReviewResponse = Schema.Union([
  Schema.Struct({
    ...reviewIdentity,
    status: Schema.Literal("available"),
    snapshot: AgentRunReviewSnapshot,
  }),
  Schema.Struct({ ...reviewIdentity, status: Schema.Literal("unavailable") }),
]);
export type AgentRunReviewResponse = typeof AgentRunReviewResponse.Type;
export const decodeAgentRunReviewResponse = Schema.decodeUnknownSync(
  AgentRunReviewResponse,
  STRICT_DECODE_OPTIONS,
);
