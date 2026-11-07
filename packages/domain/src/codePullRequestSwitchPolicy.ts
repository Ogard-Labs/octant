import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_MS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  MAX_CODE_PROJECT_PULL_REQUEST_WATCH_SIGNALS,
  type CodeProjectPullRequestAutoFixFailure,
  type CodeProjectPullRequestAutoFixPauseReason,
  type CodeProjectPullRequestAutoFixRecorded,
  type CodeProjectPullRequestAutoFixStopReason,
  type CodeProjectPullRequestAutoFixWakeResult,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestMergeWhenReadyRecorded,
  type CodeProjectPullRequestSwitchTarget,
  type CodeProjectPullRequestWatchRecorded,
  type CodeProjectPullRequestWatchSignal,
  type CodeProjectPullRequestWatchStopReason,
} from "@octant/contracts";

export type PullRequestMergeWhenReadyFold =
  | { readonly status: "off" }
  | {
      readonly status: "on";
      readonly method: CodeProjectPullRequestMergeMethod;
      readonly headSha: string;
      readonly enabledAt: string;
    }
  | { readonly status: "merged"; readonly observedAt: string }
  | { readonly status: "turned-off-by-forge"; readonly observedAt: string };

export interface PullRequestAutoFixWakeFold {
  readonly at: string;
  readonly headSha: string;
  readonly failures: ReadonlyArray<CodeProjectPullRequestAutoFixFailure>;
  readonly attempt: number;
  readonly result: CodeProjectPullRequestAutoFixWakeResult;
}

export type PullRequestAutoFixFold =
  | { readonly status: "off" }
  | {
      readonly status: "on";
      readonly threadId: string;
      readonly enabledAt: string;
      /** Started wakes per failure identity since the switch was last turned on. */
      readonly attempts: ReadonlyMap<string, number>;
      readonly lastWake?: PullRequestAutoFixWakeFold;
    }
  | {
      readonly status: "stopped";
      readonly threadId: string;
      readonly reason: CodeProjectPullRequestAutoFixStopReason;
      readonly stoppedAt: string;
    };

export interface PullRequestWatchWakeFold {
  readonly headSha: string;
  readonly signals: ReadonlyArray<CodeProjectPullRequestWatchSignal>;
  readonly result: CodeProjectPullRequestAutoFixWakeResult;
}

export type PullRequestWatchFold =
  | { readonly status: "off" }
  | {
      readonly status: "on";
      readonly threadId: string;
      readonly enabledAt: string;
      /** Signal identities that need no wake: the baseline and every started wake's. */
      readonly seen: ReadonlySet<string>;
      /** The review decision the thread last heard about, from the baseline or a wake. */
      readonly reviewDecision?: string;
      /** Wakes that started a turn since the watch was last turned on. */
      readonly wakes: number;
      readonly lastWake?: PullRequestWatchWakeFold;
    }
  | {
      readonly status: "stopped";
      readonly threadId: string;
      readonly reason: CodeProjectPullRequestWatchStopReason;
      readonly stoppedAt: string;
    };

export interface PullRequestSwitchFold {
  readonly target: CodeProjectPullRequestSwitchTarget;
  readonly mergeWhenReady: PullRequestMergeWhenReadyFold;
  readonly autoFix: PullRequestAutoFixFold;
  readonly watch: PullRequestWatchFold;
}

export type PullRequestSwitchEvent =
  | {
      readonly kind: "merge-when-ready";
      readonly occurredAt: string;
      readonly record: CodeProjectPullRequestMergeWhenReadyRecorded;
    }
  | {
      readonly kind: "auto-fix";
      readonly occurredAt: string;
      readonly record: CodeProjectPullRequestAutoFixRecorded;
    }
  | {
      readonly kind: "watch";
      readonly occurredAt: string;
      readonly record: CodeProjectPullRequestWatchRecorded;
    };

/**
 * One pull request's identity as a map key. GitHub owner and repository
 * names are case-insensitive, so two spellings are one pull request.
 */
export function pullRequestSwitchKey(target: CodeProjectPullRequestSwitchTarget): string {
  return `${String(target.projectId)}:${target.repositoryOwner.toLowerCase()}/${target.repositoryName.toLowerCase()}#${target.number}`;
}

export function failureIdentity(failure: CodeProjectPullRequestAutoFixFailure): string {
  return `${failure.kind}:${failure.key}`;
}

function failureSignature(failures: ReadonlyArray<CodeProjectPullRequestAutoFixFailure>): string {
  return failures.map(failureIdentity).toSorted().join("\n");
}

export function emptyPullRequestSwitchFold(
  target: CodeProjectPullRequestSwitchTarget,
): PullRequestSwitchFold {
  return {
    target,
    mergeWhenReady: { status: "off" },
    autoFix: { status: "off" },
    watch: { status: "off" },
  };
}

/** Applies one journaled switch event. Replaying every event in order rebuilds the state. */
export function applyPullRequestSwitchEvent(
  fold: PullRequestSwitchFold,
  event: PullRequestSwitchEvent,
): PullRequestSwitchFold {
  if (event.kind === "merge-when-ready") {
    const change = event.record.change;
    const mergeWhenReady: PullRequestMergeWhenReadyFold =
      change.kind === "enabled"
        ? {
            status: "on",
            method: change.method,
            headSha: change.headSha,
            enabledAt: event.occurredAt,
          }
        : change.kind === "disabled"
          ? { status: "off" }
          : change.kind === "merged"
            ? { status: "merged", observedAt: event.occurredAt }
            : { status: "turned-off-by-forge", observedAt: event.occurredAt };
    return { ...fold, mergeWhenReady };
  }
  if (event.kind === "watch") {
    return { ...fold, watch: applyPullRequestWatchRecord(fold.watch, event) };
  }
  const { change, threadId } = event.record;
  if (change.kind === "enabled") {
    // A fresh switch gets a fresh budget: the person chose to try again.
    return {
      ...fold,
      autoFix: {
        status: "on",
        threadId: String(threadId),
        enabledAt: event.occurredAt,
        attempts: new Map(),
      },
    };
  }
  if (change.kind === "disabled") return { ...fold, autoFix: { status: "off" } };
  if (change.kind === "stopped") {
    return {
      ...fold,
      autoFix: {
        status: "stopped",
        threadId: String(threadId),
        reason: change.reason,
        stoppedAt: event.occurredAt,
      },
    };
  }
  if (fold.autoFix.status !== "on") return fold;
  const attempts = new Map(fold.autoFix.attempts);
  // Only a wake that started a turn spent an attempt; a refused one never
  // reached the agent.
  if (change.result === "started") {
    for (const failure of change.failures) {
      const identity = failureIdentity(failure);
      attempts.set(identity, (attempts.get(identity) ?? 0) + 1);
    }
  }
  return {
    ...fold,
    autoFix: {
      ...fold.autoFix,
      attempts,
      lastWake: {
        at: event.occurredAt,
        headSha: change.headSha,
        failures: change.failures,
        attempt: change.attempt,
        result: change.result,
      },
    },
  };
}

export interface PullRequestAutoFixObservation {
  readonly state: "open" | "merged" | "closed";
  readonly headSha: string;
  readonly failures: ReadonlyArray<CodeProjectPullRequestAutoFixFailure>;
}

export type PullRequestAutoFixDecision =
  | { readonly kind: "idle" }
  | { readonly kind: "paused"; readonly reason: CodeProjectPullRequestAutoFixPauseReason }
  | { readonly kind: "stop"; readonly reason: CodeProjectPullRequestAutoFixStopReason }
  | {
      readonly kind: "wake";
      readonly attempt: number;
      readonly failures: ReadonlyArray<CodeProjectPullRequestAutoFixFailure>;
    };

/**
 * What Auto-fix does with one observation of its pull request.
 *
 * - A merged or closed pull request stops it.
 * - No failure, or the same failures on the same head it already woke a turn
 *   for, is idle: the agent is on it, or nothing changed since. A wake that
 *   never started a turn (refused, or never sent) is tried again, because
 *   the reason is usually transient.
 * - A failure that already spent the attempt limit stops it, so a fix that
 *   keeps failing goes back to the person instead of looping.
 * - Otherwise it wakes, unless the person is typing in the thread or a turn
 *   is running there; then it holds the wake for a later observation.
 */
export function decidePullRequestAutoFix(input: {
  readonly fold: PullRequestAutoFixFold;
  readonly observation: PullRequestAutoFixObservation;
  readonly turnActive: boolean;
  readonly personTyping: boolean;
}): PullRequestAutoFixDecision {
  const { fold, observation } = input;
  if (fold.status !== "on") return { kind: "idle" };
  if (observation.state === "merged") return { kind: "stop", reason: "merged" };
  if (observation.state === "closed") return { kind: "stop", reason: "closed" };
  if (observation.failures.length === 0) return { kind: "idle" };
  if (
    fold.lastWake !== undefined &&
    fold.lastWake.result === "started" &&
    fold.lastWake.headSha === observation.headSha &&
    failureSignature(fold.lastWake.failures) === failureSignature(observation.failures)
  ) {
    return { kind: "idle" };
  }
  const spent = Math.max(
    ...observation.failures.map((failure) => fold.attempts.get(failureIdentity(failure)) ?? 0),
  );
  if (spent >= CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS) {
    return { kind: "stop", reason: "attempt-limit" };
  }
  if (input.turnActive) return { kind: "paused", reason: "turn-active" };
  if (input.personTyping) return { kind: "paused", reason: "person-typing" };
  return { kind: "wake", attempt: spent + 1, failures: observation.failures };
}

export function watchSignalIdentity(signal: CodeProjectPullRequestWatchSignal): string {
  return `${signal.kind}:${signal.key}`;
}

function applyPullRequestWatchRecord(
  fold: PullRequestWatchFold,
  event: Extract<PullRequestSwitchEvent, { kind: "watch" }>,
): PullRequestWatchFold {
  const { change, threadId } = event.record;
  if (change.kind === "enabled") {
    // A fresh watch gets a fresh budget and starts from what was true when the
    // person allowed it, so it never wakes for that.
    const decision = change.baseline.find((signal) => signal.kind === "review-decision");
    return {
      status: "on",
      threadId: String(threadId),
      enabledAt: event.occurredAt,
      seen: new Set(
        change.baseline
          .filter((signal) => signal.kind !== "review-decision")
          .map(watchSignalIdentity),
      ),
      ...(decision === undefined ? {} : { reviewDecision: decision.key }),
      wakes: 0,
    };
  }
  if (change.kind === "disabled") return { status: "off" };
  if (change.kind === "stopped") {
    return {
      status: "stopped",
      threadId: String(threadId),
      reason: change.reason,
      stoppedAt: event.occurredAt,
    };
  }
  if (fold.status !== "on") return fold;
  const lastWake = { headSha: change.headSha, signals: change.signals, result: change.result };
  // Only a wake that started a turn told the thread anything; a refused one
  // is tried again on the next pass.
  if (change.result !== "started") return { ...fold, lastWake };
  const seen = new Set(fold.seen);
  let reviewDecision = fold.reviewDecision;
  for (const signal of change.signals) {
    if (signal.kind === "review-decision") reviewDecision = signal.key;
    else seen.add(watchSignalIdentity(signal));
  }
  return {
    ...fold,
    seen,
    ...(reviewDecision === undefined ? {} : { reviewDecision }),
    wakes: fold.wakes + 1,
    lastWake,
  };
}

/** What a watch reads of its pull request on one pass. Forge text stays out. */
export interface PullRequestWatchObservation {
  readonly state: "open" | "merged" | "closed";
  readonly headSha: string;
  /** Every check on the head: `passed` and `failed` only once none is still running. */
  readonly checks: "none" | "pending" | "passed" | "failed";
  readonly reviewDecision?: "approved" | "changes-requested" | "review-required";
  readonly conflicting: boolean;
  readonly reviews: ReadonlyArray<{ readonly id: string; readonly at: string }>;
  readonly comments: ReadonlyArray<{ readonly id: string; readonly at: string }>;
}

export type PullRequestWatchDecision =
  | { readonly kind: "idle" }
  | { readonly kind: "paused"; readonly reason: CodeProjectPullRequestAutoFixPauseReason }
  | { readonly kind: "stop"; readonly reason: CodeProjectPullRequestWatchStopReason }
  | {
      readonly kind: "wake";
      readonly wake: number;
      readonly signals: ReadonlyArray<CodeProjectPullRequestWatchSignal>;
    };

/**
 * What is already settled, decided, or conflicting when a watch begins. It is
 * journaled with the watch so neither the first pass nor a replay after a
 * restart wakes the thread for it. Reviews and comments need no baseline:
 * only those posted after the watch began wake it.
 */
export function pullRequestWatchBaseline(
  observation: PullRequestWatchObservation,
): ReadonlyArray<CodeProjectPullRequestWatchSignal> {
  const baseline: CodeProjectPullRequestWatchSignal[] = [];
  if (observation.checks === "passed" || observation.checks === "failed") {
    baseline.push({ kind: `checks-${observation.checks}`, key: observation.headSha });
  }
  if (observation.reviewDecision !== undefined) {
    baseline.push({ kind: "review-decision", key: observation.reviewDecision });
  }
  if (observation.conflicting) baseline.push({ kind: "conflict", key: observation.headSha });
  return baseline;
}

/** Whether a watch has outlived its lifetime; checked even while it cannot observe. */
export function pullRequestWatchExpired(fold: PullRequestWatchFold, now: string): boolean {
  return (
    fold.status === "on" &&
    Date.parse(now) - Date.parse(fold.enabledAt) >= CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_MS
  );
}

/**
 * What a thread's watch on its pull request does with one observation.
 *
 * - A merged or closed pull request ends it, and so does its lifetime or its
 *   wake budget running out.
 * - Settled checks wake once per head and outcome, a conflict once per head,
 *   a review or comment once per id (and only if posted after the watch
 *   began), and the review decision whenever it differs from the one the
 *   thread last heard. Everything new on one pass goes into one wake.
 * - A wake that never started a turn is tried again and spends nothing.
 * - Otherwise it wakes, unless a turn runs in the thread or the person is
 *   typing there; then it holds the wake for a later pass.
 */
export function decidePullRequestWatch(input: {
  readonly fold: PullRequestWatchFold;
  readonly observation: PullRequestWatchObservation;
  readonly now: string;
  readonly turnActive: boolean;
  readonly personTyping: boolean;
}): PullRequestWatchDecision {
  const { fold, observation } = input;
  if (fold.status !== "on") return { kind: "idle" };
  if (observation.state === "merged") return { kind: "stop", reason: "merged" };
  if (observation.state === "closed") return { kind: "stop", reason: "closed" };
  if (pullRequestWatchExpired(fold, input.now)) return { kind: "stop", reason: "expired" };
  if (fold.wakes >= CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES) {
    return { kind: "stop", reason: "wake-limit" };
  }
  const since = Date.parse(fold.enabledAt);
  const current: CodeProjectPullRequestWatchSignal[] = [];
  if (observation.checks === "passed" || observation.checks === "failed") {
    current.push({ kind: `checks-${observation.checks}`, key: observation.headSha });
  }
  if (
    observation.reviewDecision !== undefined &&
    observation.reviewDecision !== fold.reviewDecision
  ) {
    current.push({ kind: "review-decision", key: observation.reviewDecision });
  }
  if (observation.conflicting) current.push({ kind: "conflict", key: observation.headSha });
  for (const review of observation.reviews) {
    if (Date.parse(review.at) > since) current.push({ kind: "review", key: review.id });
  }
  for (const comment of observation.comments) {
    if (Date.parse(comment.at) > since) current.push({ kind: "comment", key: comment.id });
  }
  const signals = current
    .filter((signal) => !fold.seen.has(watchSignalIdentity(signal)))
    .slice(0, MAX_CODE_PROJECT_PULL_REQUEST_WATCH_SIGNALS);
  if (signals.length === 0) return { kind: "idle" };
  if (input.turnActive) return { kind: "paused", reason: "turn-active" };
  if (input.personTyping) return { kind: "paused", reason: "person-typing" };
  return { kind: "wake", wake: fold.wakes + 1, signals };
}
