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
/**
 * How many helper agents may run at once. A helper that is only waiting — for
 * the runs it depends on, or for a free slot — holds no slot and does not
 * count. The ceiling bounds what a person may choose, so a setting can raise
 * parallelism but never remove the bound.
 */
export const MAX_AGENT_RUN_CONCURRENCY = 16;
const AgentRunConcurrencyLimit = Schema.Int.pipe(Schema.between(1, MAX_AGENT_RUN_CONCURRENCY));
export const AgentRunConcurrency = Schema.Struct({
  /** Helpers of one thread running at once. */
  perThread: AgentRunConcurrencyLimit,
  /** Helpers running at once across the app. */
  onHost: AgentRunConcurrencyLimit,
}).annotations(strict);
export type AgentRunConcurrency = typeof AgentRunConcurrency.Type;

export const DEFAULT_AGENT_RUN_CONCURRENCY: AgentRunConcurrency = { perThread: 4, onHost: 8 };

/**
 * Two working hours: a helper given a real implementation or review task
 * was being cut off at the earlier 30 minutes while still making progress.
 * The limit still exists by default because a provider that goes silent
 * holds its helper slot until the limit fires.
 */
export const DEFAULT_AGENT_RUN_WORKING_TIME_MINUTES = 120;
export const MAX_AGENT_RUN_WORKING_TIME_MINUTES = 240;
const AgentRunWorkingTimeLimit = Schema.Int.pipe(
  Schema.between(1, MAX_AGENT_RUN_WORKING_TIME_MINUTES),
);

export const AgentRunPolicySettings = Schema.Struct({
  workingTimeLimitMinutes: Schema.optional(AgentRunWorkingTimeLimit),
  /**
   * A person's choice that helpers of a thread at Full access work with no
   * time limit. Optional so settings journaled before it existed replay as
   * limited; it never lifts the limit for a thread below Full access.
   */
  noWorkingTimeLimitAtFullAccess: Schema.optional(Schema.Boolean),
  creationPosture: AgentRunCreationPosture,
  /** Optional so settings journaled before it existed replay as the defaults. */
  concurrency: Schema.optional(AgentRunConcurrency),
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
  workingTimeLimitMinutes: Schema.optional(AgentRunWorkingTimeLimit),
  /** Absent keeps the current choice. */
  noWorkingTimeLimitAtFullAccess: Schema.optional(Schema.Boolean),
  creationPosture: AgentRunSelectableCreationPosture,
  /** Absent keeps the current limits. */
  concurrency: Schema.optional(AgentRunConcurrency),
  expectedVersion: AggregateVersion,
}).annotations(strict);
export type UpdateAgentRunPolicySettings = typeof UpdateAgentRunPolicySettings.Type;

/** The limits in force: the stored ones, or the defaults for settings that predate them. */
export function effectiveAgentRunConcurrency(
  settings: Pick<AgentRunPolicySettings, "concurrency">,
): AgentRunConcurrency {
  return settings.concurrency ?? DEFAULT_AGENT_RUN_CONCURRENCY;
}

/**
 * The working-time limit for a helper's next attempt, in minutes, or `none`.
 * None needs both the person's choice and a parent thread at Full access.
 */
export function agentRunWorkingTimeLimitMinutes(
  settings: Pick<
    AgentRunPolicySettings,
    "workingTimeLimitMinutes" | "noWorkingTimeLimitAtFullAccess"
  >,
  thread: { readonly threadAtFullAccess: boolean },
): number | "none" {
  if (settings.noWorkingTimeLimitAtFullAccess === true && thread.threadAtFullAccess) return "none";
  return settings.workingTimeLimitMinutes ?? DEFAULT_AGENT_RUN_WORKING_TIME_MINUTES;
}

export const decodeAgentRunPolicySettings = Schema.decodeUnknownSync(AgentRunPolicySettings);
export const decodeUpdateAgentRunPolicySettings = Schema.decodeUnknownSync(
  UpdateAgentRunPolicySettings,
);
