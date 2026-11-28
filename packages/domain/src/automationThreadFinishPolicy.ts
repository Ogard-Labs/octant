import {
  AUTOMATION_FOLLOW_UP_MISSED_WINDOW_MS,
  AUTOMATION_THREAD_FINISH_DEFAULT_EXPIRY_MS,
  MAX_AUTOMATION_FINISH_WAITS_PER_HOST,
  MAX_AUTOMATION_FINISH_WAITS_PER_THREAD,
  MAX_AUTOMATION_THREAD_FINISH_EXPIRY_MS,
  type AutomationFinishWaitRecord,
  type AutomationFinishWaitSpec,
  type AutomationMode,
  type AutomationThreadFinishCondition,
} from "@octant/contracts/automation";
import type { UtcTimestamp } from "@octant/contracts/events";

/**
 * Host-verified state of the waited-on thread X, assembled solely from the
 * host's own records (live turns, open approvals/questions, pending decisions,
 * queued messages, board/person done evidence, and completed turns).
 */
export type ThreadFinishTargetFacts =
  | {
      readonly kind: "unavailable";
      readonly reason:
        | "missing"
        | "archived"
        | "deleted"
        | "moved"
        | "grant-removed"
        | "member-removed";
    }
  | {
      readonly kind: "offline";
    }
  | {
      readonly kind: "present";
      readonly threadId: string;
      readonly mode: AutomationMode;
      readonly projectId: string;
      /** True while a provider turn is running or starting. */
      readonly working: boolean;
      /** True while any approval or question is open on the thread. */
      readonly hasOpenRequest: boolean;
      /** True while any turn decision review is pending on the thread. */
      readonly hasPendingDecision: boolean;
      /** True while any queued user message waits to run on the thread. */
      readonly hasQueuedMessage: boolean;
      /**
       * True only when the board says `done` from unambiguous evidence or a
       * person completed/settled the thread. Ambiguous evidence stays false.
       */
      readonly done: boolean;
      readonly doneAt?: UtcTimestamp | undefined;
      /**
       * Newest turn whose outcome is strictly `completed`. Failed, stopped,
       * cancelled, and interrupted turns never appear here.
       */
      readonly latestCompletedTurn?: {
        readonly turnId: string;
        readonly completedAt: UtcTimestamp;
      };
    };

export type ThreadFinishWaitEvaluation =
  | { readonly kind: "waiting" }
  | {
      readonly kind: "fire";
      readonly attestedTurnId: string;
      readonly finishedAt: UtcTimestamp;
    }
  | {
      readonly kind: "missed";
      readonly attestedTurnId: string;
      readonly finishedAt: UtcTimestamp;
      readonly message: string;
    }
  | {
      readonly kind: "expired";
      readonly message: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: Extract<ThreadFinishTargetFacts, { readonly kind: "unavailable" }>["reason"];
      readonly message: string;
    };

export type ThreadFinishWaitArmDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "self-wait"
        | "child-run-wait"
        | "thread-wait-limit"
        | "host-wait-limit"
        | "invalid-expiry"
        | "target-unavailable"
        | "cross-host-unsupported";
      readonly message: string;
    };

/**
 * Pure arming bounds and structural checks for a wait-on-thread trigger.
 * Enforces:
 * - No self-wait (thread cannot wait on itself).
 * - No child-run wait (thread cannot wait on its own delegated child run).
 * - At most 8 active waits per thread and 32 per host.
 * - Expiry strictly after armedAt and bounded to 30 days (default 7 days).
 */
export function decideThreadFinishWaitArming(input: {
  readonly originThreadId?: string | undefined;
  readonly targetThreadId: string;
  readonly targetMemberId?: string | undefined;
  readonly isTargetChildOfOrigin: boolean;
  readonly targetAvailable: boolean;
  readonly activeWaitsForOriginThread: number;
  readonly activeWaitsForHost: number;
  readonly armedAt: UtcTimestamp;
  readonly expiresAt: UtcTimestamp;
}): ThreadFinishWaitArmDecision {
  if (input.targetMemberId !== undefined) {
    return {
      kind: "refused",
      reason: "cross-host-unsupported",
      message: "Waiting on a thread on another computer requires peer thread-state support.",
    };
  }
  if (!input.targetAvailable) {
    return {
      kind: "refused",
      reason: "target-unavailable",
      message: "The waited-on thread is unavailable on this host.",
    };
  }
  if (input.originThreadId !== undefined && input.originThreadId === input.targetThreadId) {
    return {
      kind: "refused",
      reason: "self-wait",
      message: "A thread cannot wait on itself.",
    };
  }
  if (input.isTargetChildOfOrigin) {
    return {
      kind: "refused",
      reason: "child-run-wait",
      message: "A thread cannot wait on one of its own child runs.",
    };
  }
  if (input.activeWaitsForOriginThread >= MAX_AUTOMATION_FINISH_WAITS_PER_THREAD) {
    return {
      kind: "refused",
      reason: "thread-wait-limit",
      message: `A thread can have at most ${String(MAX_AUTOMATION_FINISH_WAITS_PER_THREAD)} active finish waits.`,
    };
  }
  if (input.activeWaitsForHost >= MAX_AUTOMATION_FINISH_WAITS_PER_HOST) {
    return {
      kind: "refused",
      reason: "host-wait-limit",
      message: `This host can have at most ${String(MAX_AUTOMATION_FINISH_WAITS_PER_HOST)} active finish waits.`,
    };
  }
  const armedMs = Date.parse(input.armedAt);
  const expiresMs = Date.parse(input.expiresAt);
  if (
    !Number.isFinite(armedMs) ||
    !Number.isFinite(expiresMs) ||
    expiresMs <= armedMs ||
    expiresMs - armedMs > MAX_AUTOMATION_THREAD_FINISH_EXPIRY_MS
  ) {
    return {
      kind: "refused",
      reason: "invalid-expiry",
      message: "The wait expiry must be after now and within 30 days.",
    };
  }
  return { kind: "allowed" };
}

/** Default 7-day expiry from `armedAt`. */
export function defaultThreadFinishWaitExpiry(armedAt: UtcTimestamp): UtcTimestamp {
  return new Date(
    Date.parse(armedAt) + AUTOMATION_THREAD_FINISH_DEFAULT_EXPIRY_MS,
  ).toISOString() as UtcTimestamp;
}

/**
 * Whether X already satisfies `condition` right now, used when presenting the
 * arm sheet so it can offer "Run now" immediately.
 */
export function isThreadFinishConditionMetNow(
  target: ThreadFinishTargetFacts,
  condition: AutomationThreadFinishCondition,
): boolean {
  if (target.kind !== "present") return false;
  if (condition === "done") return target.done;
  return (
    !target.working &&
    !target.hasOpenRequest &&
    !target.hasPendingDecision &&
    !target.hasQueuedMessage &&
    target.latestCompletedTurn !== undefined
  );
}

/**
 * Evaluate one armed finish wait against host-verified target facts.
 *
 * Rules:
 * - Only an `armed` wait evaluates; all other states stay untouched (`waiting`).
 * - Unavailable target (deleted, archived, moved, missing, grant/member removed)
 *   transitions to `unavailable` ("cannot be checked") and never starts work.
 * - Offline remote host stays armed (`waiting`) unless the wait expired.
 * - `turn-finished`: requires not working, no open request, no pending decision,
 *   no queued message, and a completed turn distinct from `baselineTurnId` whose
 *   completion time is at or after `armedAt`. Failed/stopped/interrupted turns
 *   are excluded from `latestCompletedTurn`.
 * - `done`: requires unambiguous `done === true`.
 * - Expiry: a wait past `expiresAt` with no timely finish transitions to `expired`.
 * - Lateness: a finish noticed past the lateness limit (default 24h) transitions
 *   to `missed` and holds for the person (Run now / Cancel).
 */
export function evaluateThreadFinishWait(input: {
  readonly wait: Pick<
    AutomationFinishWaitRecord,
    | "condition"
    | "armedAt"
    | "expiresAt"
    | "baselineTurnId"
    | "targetThreadId"
    | "targetMode"
    | "targetProjectId"
  > & { readonly state?: AutomationFinishWaitRecord["state"] };
  readonly target: ThreadFinishTargetFacts;
  readonly now: UtcTimestamp;
  /** Settings' `followUpLatenessLimitHours`; absent defaults to 24 hours. */
  readonly latenessLimitHours?: number | undefined;
}): ThreadFinishWaitEvaluation {
  const { wait, target, now } = input;
  if (wait.state !== undefined && wait.state !== "armed") {
    return { kind: "waiting" };
  }
  if (target.kind === "unavailable") {
    return {
      kind: "unavailable",
      reason: target.reason,
      message: "The waited-on thread cannot be checked.",
    };
  }
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(wait.expiresAt);
  if (target.kind === "offline") {
    if (nowMs >= expiresMs) {
      return {
        kind: "expired",
        message: "The wait expired before the target thread finished.",
      };
    }
    return { kind: "waiting" };
  }
  if (
    target.threadId !== String(wait.targetThreadId) ||
    target.mode !== wait.targetMode ||
    target.projectId !== String(wait.targetProjectId)
  ) {
    return {
      kind: "unavailable",
      reason: "moved",
      message: "The waited-on thread moved to another Project and cannot be checked.",
    };
  }

  const matched = matchFinishCondition(wait, target);
  if (matched === undefined) {
    if (nowMs >= expiresMs) {
      return {
        kind: "expired",
        message: "The wait expired before the target thread finished.",
      };
    }
    return { kind: "waiting" };
  }

  const finishedMs = Date.parse(matched.finishedAt);
  if (finishedMs > expiresMs) {
    return {
      kind: "expired",
      message: "The wait expired before the target thread finished.",
    };
  }

  const latenessLimitMs =
    input.latenessLimitHours === undefined
      ? AUTOMATION_FOLLOW_UP_MISSED_WINDOW_MS
      : input.latenessLimitHours * 3_600_000;
  if (nowMs - finishedMs > latenessLimitMs) {
    const label =
      input.latenessLimitHours === undefined
        ? "a day"
        : `${String(input.latenessLimitHours)} hours`;
    return {
      kind: "missed",
      attestedTurnId: matched.attestedTurnId,
      finishedAt: matched.finishedAt,
      message: `The waited-on thread finished more than ${label} ago, so the follow-up was held as missed.`,
    };
  }

  return {
    kind: "fire",
    attestedTurnId: matched.attestedTurnId,
    finishedAt: matched.finishedAt,
  };
}

function matchFinishCondition(
  wait: Pick<AutomationFinishWaitSpec, "condition" | "armedAt" | "baselineTurnId">,
  target: Extract<ThreadFinishTargetFacts, { readonly kind: "present" }>,
): { readonly attestedTurnId: string; readonly finishedAt: UtcTimestamp } | undefined {
  if (wait.condition === "done") {
    if (!target.done) return undefined;
    const finishedAt = target.doneAt ?? target.latestCompletedTurn?.completedAt;
    if (finishedAt === undefined) return undefined;
    if (Date.parse(finishedAt) < Date.parse(wait.armedAt)) return undefined;
    if (
      target.doneAt === undefined &&
      wait.baselineTurnId !== undefined &&
      target.latestCompletedTurn?.turnId === String(wait.baselineTurnId)
    ) {
      return undefined;
    }
    const attestedTurnId = target.latestCompletedTurn?.turnId ?? `done:${finishedAt}`;
    return { attestedTurnId, finishedAt };
  }
  if (
    target.working ||
    target.hasOpenRequest ||
    target.hasPendingDecision ||
    target.hasQueuedMessage
  ) {
    return undefined;
  }
  const latest = target.latestCompletedTurn;
  if (latest === undefined) return undefined;
  if (wait.baselineTurnId !== undefined && latest.turnId === String(wait.baselineTurnId)) {
    return undefined;
  }
  if (Date.parse(latest.completedAt) < Date.parse(wait.armedAt)) {
    return undefined;
  }
  return { attestedTurnId: latest.turnId, finishedAt: latest.completedAt };
}
