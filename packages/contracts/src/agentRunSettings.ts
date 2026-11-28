import { HostResourcePolicy, KeepAwakePolicy } from "./hostResourcePolicy";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { AgentRunCreationPosture } from "./agentRun";

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
const AgentRunConcurrencyLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_RUN_CONCURRENCY }),
);
export const AgentRunConcurrency = Schema.Struct({
  /** Helpers of one thread running at once. */
  perThread: AgentRunConcurrencyLimit,
  /** Helpers running at once across the app. */
  onHost: AgentRunConcurrencyLimit,
});
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
const AgentRunWorkingTimeLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_RUN_WORKING_TIME_MINUTES }),
);

/**
 * How long a helper waits for a provider that is full before it ends
 * Interrupted. Half an hour by default: a turn holding the slot is often a
 * long one, and the earlier five minutes ended helpers that would have
 * started a few minutes later. The ceiling matches the working-time ceiling.
 */
export const DEFAULT_AGENT_RUN_PROVIDER_SLOT_WAIT_MINUTES = 30;
export const MAX_AGENT_RUN_PROVIDER_SLOT_WAIT_MINUTES = 240;
const AgentRunProviderSlotWaitLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: MAX_AGENT_RUN_PROVIDER_SLOT_WAIT_MINUTES }),
);

export const AgentRunPolicySettings = Schema.Struct({
  workingTimeLimitMinutes: Schema.optional(AgentRunWorkingTimeLimit),
  /**
   * Whether helpers of a thread at Full access work with no time limit.
   * Absent is on outside Strict: a Full access thread's own turn has no such
   * limit, so its helpers have none until the person turns this off. Under
   * Strict absent is off, and only the person's explicit choice lifts the
   * limit. It never lifts the limit for a thread below Full access.
   */
  noWorkingTimeLimitAtFullAccess: Schema.optional(Schema.Boolean),
  /** Optional so settings journaled before it existed replay as the default. */
  providerSlotWaitMinutes: Schema.optional(AgentRunProviderSlotWaitLimit),
  creationPosture: AgentRunCreationPosture,
  /** Optional so settings journaled before it existed replay as the defaults. */
  concurrency: Schema.optional(AgentRunConcurrency),
  resourcePolicy: Schema.optional(HostResourcePolicy),
  /**
   * The prior keep-awake policy when an update changed it, so the journaled
   * event carries both the old and new values with its actor and timestamp.
   */
  previousKeepAwake: Schema.optional(KeepAwakePolicy),
  version: AggregateVersion,
  updatedAt: UtcTimestamp,
});
export type AgentRunPolicySettings = typeof AgentRunPolicySettings.Type;

/**
 * The two postures a person can choose. Subagents are started only by the
 * thread's agent, so there is no "only when I start them" middle ground.
 */
export const AgentRunSelectableCreationPosture = Schema.Literals(["off", "automatic"]);
export type AgentRunSelectableCreationPosture = typeof AgentRunSelectableCreationPosture.Type;

export const DEFAULT_AGENT_RUN_CREATION_POSTURE: AgentRunSelectableCreationPosture = "automatic";

export const UpdateAgentRunPolicySettings = Schema.Struct({
  workingTimeLimitMinutes: Schema.optional(AgentRunWorkingTimeLimit),
  /** Absent keeps the current choice. */
  noWorkingTimeLimitAtFullAccess: Schema.optional(Schema.Boolean),
  /** Absent keeps the current wait. */
  providerSlotWaitMinutes: Schema.optional(AgentRunProviderSlotWaitLimit),
  creationPosture: AgentRunSelectableCreationPosture,
  /** Absent keeps the current limits. */
  concurrency: Schema.optional(AgentRunConcurrency),
  resourcePolicy: Schema.optional(HostResourcePolicy),
  expectedVersion: AggregateVersion,
});
export type UpdateAgentRunPolicySettings = typeof UpdateAgentRunPolicySettings.Type;

/** The limits in force: the stored ones, or the defaults for settings that predate them. */
export function effectiveAgentRunConcurrency(
  settings: Pick<AgentRunPolicySettings, "concurrency">,
): AgentRunConcurrency {
  return settings.concurrency ?? DEFAULT_AGENT_RUN_CONCURRENCY;
}

/**
 * The working-time limit for a helper's next attempt, in minutes, or `none`.
 * None needs a parent thread at Full access and the person not having turned
 * it off; below Full access the person's limit applies. Under Strict the
 * lift must be the person's explicit choice: with the helper's event budget
 * gone, a helper of a Strict thread whose settings say nothing would
 * otherwise have no bound at all, where it had this limit before.
 */
export function agentRunWorkingTimeLimitMinutes(
  settings: Pick<
    AgentRunPolicySettings,
    "workingTimeLimitMinutes" | "noWorkingTimeLimitAtFullAccess"
  >,
  thread: {
    readonly threadAtFullAccess: boolean;
    /** Strict as the host resolves it for the parent thread; unknown is Strict. */
    readonly strict: boolean;
  },
): number | "none" {
  const lifted = thread.strict
    ? settings.noWorkingTimeLimitAtFullAccess === true
    : settings.noWorkingTimeLimitAtFullAccess !== false;
  if (lifted && thread.threadAtFullAccess) return "none";
  return settings.workingTimeLimitMinutes ?? DEFAULT_AGENT_RUN_WORKING_TIME_MINUTES;
}

export const decodeAgentRunPolicySettings = Schema.decodeUnknownSync(
  AgentRunPolicySettings,
  STRICT_DECODE_OPTIONS,
);
export const decodeUpdateAgentRunPolicySettings = Schema.decodeUnknownSync(
  UpdateAgentRunPolicySettings,
  STRICT_DECODE_OPTIONS,
);
