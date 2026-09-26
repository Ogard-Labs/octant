import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { AgentRunCreationPosture } from "./agentRun";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Server-authoritative Agents settings: whether the thread's agent may start
 * subagents on its own (Automatic, within policy) or not at all (Off).
 * Persisted through its own event-sourced aggregate so the effective posture
 * survives restart and is never trusted from a client request.
 */
export const AgentRunPolicySettings = Schema.Struct({
  creationPosture: AgentRunCreationPosture,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunPolicySettings = typeof AgentRunPolicySettings.Type;

/**
 * The two postures a person can choose. Subagents are started only by the
 * thread's agent, so there is no "only when I start them" middle ground.
 */
export const AgentRunSelectableCreationPosture = Schema.Literal("off", "automatic");
export type AgentRunSelectableCreationPosture = typeof AgentRunSelectableCreationPosture.Type;

export const DEFAULT_AGENT_RUN_CREATION_POSTURE: AgentRunSelectableCreationPosture = "automatic";

export const DEFAULT_AGENT_RUN_POLICY_SETTINGS: Omit<AgentRunPolicySettings, "updatedAt"> = {
  creationPosture: DEFAULT_AGENT_RUN_CREATION_POSTURE,
  version: 0 as AggregateVersion,
};

export const UpdateAgentRunPolicySettings = Schema.Struct({
  creationPosture: AgentRunSelectableCreationPosture,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type UpdateAgentRunPolicySettings = typeof UpdateAgentRunPolicySettings.Type;

export const decodeAgentRunPolicySettings = Schema.decodeUnknownSync(AgentRunPolicySettings);
export const decodeUpdateAgentRunPolicySettings = Schema.decodeUnknownSync(
  UpdateAgentRunPolicySettings,
);
