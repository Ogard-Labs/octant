import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type CodeProjectPullRequestAutoFixFailure,
  type CodeProjectPullRequestAutoFixPauseReason,
  type CodeProjectPullRequestAutoFixRecorded,
  type CodeProjectPullRequestAutoFixStopReason,
  type CodeProjectPullRequestAutoFixWakeResult,
  type CodeProjectPullRequestMergeMethod,
  type CodeProjectPullRequestMergeWhenReadyRecorded,
  type CodeProjectPullRequestSwitchTarget,
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

export interface PullRequestSwitchFold {
  readonly target: CodeProjectPullRequestSwitchTarget;
  readonly mergeWhenReady: PullRequestMergeWhenReadyFold;
  readonly autoFix: PullRequestAutoFixFold;
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
  return { target, mergeWhenReady: { status: "off" }, autoFix: { status: "off" } };
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
 * - No failure, or the same failures on the same head it already woke for,
 *   is idle: the agent is on it, or nothing changed since.
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
