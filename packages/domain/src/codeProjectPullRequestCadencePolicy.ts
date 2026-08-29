import { cacheBackoffHolds, extendCacheBackoff, type CacheBackoff } from "./cacheBackoffPolicy";

/**
 * Pacing for the opt-in background refresh of the Project pull-request
 * snapshot.
 *
 * The cadence exists so board cards stop reading stale after a restart, but it
 * must never turn one host into a polling storm: observations are floored, a
 * failure backs off instead of retrying hot, and a `gh` that is missing or
 * unauthenticated stops the cadence entirely rather than looping on a refusal.
 * The journal is out of scope by construction — nothing here produces an event.
 */

/**
 * Hard floor between observations of one Project. Below this a cadence is a
 * request storm on the very rate limit the snapshot depends on.
 */
export const CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS = 30_000;

/**
 * Conservative default interval. Board facts (checks, review, mergeability)
 * settle over minutes, not seconds; two minutes keeps cards honest without
 * competing with the user's own explicit refreshes for rate limit.
 */
export const CODE_PROJECT_PULL_REQUEST_CADENCE_INTERVAL_MS = 120_000;

export type PullRequestCadenceStopReason = "gh-unavailable" | "unauthorized";

/**
 * Per-Project cadence state. `lastFreshAtMs` is the sync position: it moves
 * only on a successful observation, so a failure can never make the cadence
 * believe it is caught up.
 */
export interface PullRequestCadenceProjectState {
  readonly lastFreshAtMs?: number;
  readonly backoff?: CacheBackoff;
  readonly stopped?: PullRequestCadenceStopReason;
}

export type PullRequestCadenceDecision =
  | { readonly kind: "observe" }
  | { readonly kind: "wait"; readonly untilMs: number }
  | { readonly kind: "idle"; readonly reason: "disabled" | "no-identities" }
  | { readonly kind: "stopped"; readonly reason: PullRequestCadenceStopReason };

/**
 * What one observation attempt reported. An authoritative empty list is a
 * successful observation — the Project genuinely has nothing to show — while
 * `failed` and `unauthorized` are refusals that must not advance the position.
 */
export type PullRequestCadenceOutcome =
  | { readonly status: "fresh" }
  | { readonly status: "empty" }
  | { readonly status: "failed"; readonly retryAtMs?: number }
  | { readonly status: "unauthorized" };

export function decidePullRequestCadenceObservation(input: {
  readonly enabled: boolean;
  readonly hasBoardRelevantIdentities: boolean;
  readonly ghAvailable: boolean;
  readonly state: PullRequestCadenceProjectState;
  readonly nowMs: number;
  readonly intervalMs?: number;
}): PullRequestCadenceDecision {
  if (!input.ghAvailable) return { kind: "stopped", reason: "gh-unavailable" };
  if (input.state.stopped !== undefined) {
    return { kind: "stopped", reason: input.state.stopped };
  }
  if (!input.enabled) return { kind: "idle", reason: "disabled" };
  if (!input.hasBoardRelevantIdentities) return { kind: "idle", reason: "no-identities" };
  const backoff = input.state.backoff;
  if (backoff !== undefined && cacheBackoffHolds(backoff, input.nowMs)) {
    return { kind: "wait", untilMs: backoff.retryAt };
  }
  const intervalMs = Math.max(
    input.intervalMs ?? CODE_PROJECT_PULL_REQUEST_CADENCE_INTERVAL_MS,
    CODE_PROJECT_PULL_REQUEST_CADENCE_FLOOR_MS,
  );
  if (input.state.lastFreshAtMs === undefined) return { kind: "observe" };
  const dueAtMs = input.state.lastFreshAtMs + intervalMs;
  return input.nowMs >= dueAtMs ? { kind: "observe" } : { kind: "wait", untilMs: dueAtMs };
}

export function settlePullRequestCadenceObservation(
  state: PullRequestCadenceProjectState,
  outcome: PullRequestCadenceOutcome,
  nowMs: number,
): PullRequestCadenceProjectState {
  if (outcome.status === "fresh" || outcome.status === "empty") {
    return { lastFreshAtMs: nowMs };
  }
  if (outcome.status === "unauthorized") {
    return {
      ...(state.lastFreshAtMs === undefined ? {} : { lastFreshAtMs: state.lastFreshAtMs }),
      stopped: "unauthorized",
    };
  }
  const backoff = extendCacheBackoff(state.backoff, nowMs);
  // A rate limit's own retry-after outranks the streak when it is later: the
  // service told us exactly when asking again could succeed.
  const retryAt =
    outcome.retryAtMs !== undefined && outcome.retryAtMs > backoff.retryAt
      ? outcome.retryAtMs
      : backoff.retryAt;
  return {
    ...(state.lastFreshAtMs === undefined ? {} : { lastFreshAtMs: state.lastFreshAtMs }),
    backoff: { failureStreak: backoff.failureStreak, retryAt },
  };
}

/**
 * A stopped cadence restarts only through an explicit signal — the user
 * re-enabled the Project or an explicit refresh proved the connection works —
 * never by the cadence deciding on its own that a refusal expired.
 */
export function restartPullRequestCadence(
  state: PullRequestCadenceProjectState,
): PullRequestCadenceProjectState {
  return state.lastFreshAtMs === undefined ? {} : { lastFreshAtMs: state.lastFreshAtMs };
}
