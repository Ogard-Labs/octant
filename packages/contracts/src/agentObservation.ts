import { Schema } from "effect";
import {
  AgentRunResultEvidence,
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
  control: Schema.Literal("unavailable"),
}).annotations(strict);
export type AgentObservedChild = typeof AgentObservedChild.Type;
export const decodeAgentObservedChild = Schema.decodeUnknownSync(AgentObservedChild);
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
  ...AgentRunResultEvidence.fields,
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
