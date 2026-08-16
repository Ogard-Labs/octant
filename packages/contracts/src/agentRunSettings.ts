import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { AgentRunCreationPosture } from "./agentRun";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Server-authoritative Agents settings: the single global creation posture
 * (Off / Ask / Automatic within policy) from
 * `docs/superpowers/specs/2026-07-13-mixed-provider-subagents-design.md`
 * section 6.1. Persisted through its own event-sourced aggregate so the
 * effective posture survives restart and is never trusted from a client
 * request.
 */
export const AgentRunPolicySettings = Schema.Struct({
  creationPosture: AgentRunCreationPosture,
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type AgentRunPolicySettings = typeof AgentRunPolicySettings.Type;

export const DEFAULT_AGENT_RUN_CREATION_POSTURE: AgentRunCreationPosture = "ask";

export const DEFAULT_AGENT_RUN_POLICY_SETTINGS: Omit<AgentRunPolicySettings, "updatedAt"> = {
  creationPosture: DEFAULT_AGENT_RUN_CREATION_POSTURE,
  version: 0 as AggregateVersion,
};

export const UpdateAgentRunPolicySettings = Schema.Struct({
  creationPosture: AgentRunCreationPosture,
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type UpdateAgentRunPolicySettings = typeof UpdateAgentRunPolicySettings.Type;

export const decodeAgentRunPolicySettings = Schema.decodeUnknownSync(AgentRunPolicySettings);
export const decodeUpdateAgentRunPolicySettings = Schema.decodeUnknownSync(
  UpdateAgentRunPolicySettings,
);
