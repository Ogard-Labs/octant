import {
  MAX_THREAD_PLAN_HISTORY_ENTRIES,
  type AggregateVersion,
  type ThreadPlan,
  type ThreadPlanCommand,
  type ThreadPlanHistoryEntry,
  type ThreadPlanStep,
  type ThreadPlanStepDraft,
  type ThreadPlanStepStatus,
  type UtcTimestamp,
} from "@octant/contracts";

export type ThreadPlanPolicyRejectionCode =
  | "plan-already-live"
  | "plan-not-found"
  | "plan-mismatch"
  | "plan-withdrawn"
  | "plan-not-proposed"
  | "plan-not-approved"
  | "stale-revision"
  | "duplicate-step"
  | "unknown-step"
  | "step-status-unchanged"
  | "version-conflict";

export class ThreadPlanPolicyRejection extends Error {
  override readonly name = "ThreadPlanPolicyRejection";

  constructor(
    readonly code: ThreadPlanPolicyRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ThreadPlanAggregate {
  readonly plan: ThreadPlan | null;
  readonly history: ReadonlyArray<ThreadPlanHistoryEntry>;
}

function reject(code: ThreadPlanPolicyRejectionCode, message: string): never {
  throw new ThreadPlanPolicyRejection(code, message);
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

/**
 * Keep the revision history within its durable ceiling.
 *
 * The oldest entries go rather than the newest being refused: a plan revised
 * to the ceiling has to stay revisable, and an unbounded append would fail its
 * own decode on the next write and strand the plan.
 */
function appendBoundedHistory(
  history: ReadonlyArray<ThreadPlanHistoryEntry>,
  entry: ThreadPlanHistoryEntry,
): ReadonlyArray<ThreadPlanHistoryEntry> {
  const appended = [...history, entry];
  return appended.length <= MAX_THREAD_PLAN_HISTORY_ENTRIES
    ? appended
    : appended.slice(appended.length - MAX_THREAD_PLAN_HISTORY_ENTRIES);
}

function historyOf(plan: ThreadPlan, recordedAt: UtcTimestamp): ThreadPlanHistoryEntry {
  return {
    revisionId: plan.revisionId,
    title: plan.title,
    status: plan.status,
    stepCount: plan.steps.length,
    recordedAt,
  };
}

/**
 * Lay proposed steps out in the order they were written.
 *
 * Status is never taken from the proposal — a plan cannot arrive claiming its
 * own work is finished. A step that survives a rewrite keeps the status it had,
 * because it is the same step and the work done to it really happened.
 */
function layOutSteps(
  drafts: ReadonlyArray<ThreadPlanStepDraft>,
  carried: ReadonlyMap<string, ThreadPlanStepStatus>,
): ReadonlyArray<ThreadPlanStep> {
  const seen = new Set<string>();
  return drafts.map((draft, position) => {
    const key = String(draft.stepId);
    if (seen.has(key)) reject("duplicate-step", "Two plan steps claim the same step identity.");
    seen.add(key);
    return {
      stepId: draft.stepId,
      position,
      title: draft.title,
      ...(draft.rationale === undefined ? {} : { rationale: draft.rationale }),
      status: carried.get(key) ?? ("pending" as const),
    };
  });
}

function requirePlan(aggregate: ThreadPlanAggregate, command: ThreadPlanCommand): ThreadPlan {
  const plan = aggregate.plan;
  if (plan === null) reject("plan-not-found", "This thread has no plan.");
  if (String(plan.id) !== String(command.planId)) {
    reject("plan-mismatch", "The command names a plan this thread does not have.");
  }
  return plan;
}

function requireVersion(current: AggregateVersion, expected: AggregateVersion): void {
  if (current !== expected) {
    reject("version-conflict", "The plan moved under this command; reload and retry.");
  }
}

/**
 * Apply one command to a thread's plan.
 *
 * The plan is the durable, ordered account of what the thread intends to do:
 * proposed as a whole, approved as a whole against the exact wording that was
 * read, and worked through one step at a time. Approval lives here and nowhere
 * else — a thread's access posture says what it may do, never that its plan was
 * agreed.
 */
export function applyThreadPlanCommand(
  aggregate: ThreadPlanAggregate,
  command: ThreadPlanCommand,
  now: UtcTimestamp,
): ThreadPlanAggregate {
  switch (command.kind) {
    case "propose-thread-plan": {
      const live = aggregate.plan;
      requireVersion((live?.version ?? 0) as AggregateVersion, command.expectedVersion);
      if (live !== null && live.status !== "withdrawn") {
        reject(
          "plan-already-live",
          "This thread already has a plan. Revise or withdraw it before proposing another.",
        );
      }
      const plan: ThreadPlan = {
        id: command.planId,
        threadId: command.threadId,
        revisionId: command.revisionId,
        title: command.title,
        status: "proposed",
        steps: layOutSteps(command.steps, new Map()),
        proposedAt: now,
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return { plan, history: appendBoundedHistory(aggregate.history, historyOf(plan, now)) };
    }
    case "revise-thread-plan": {
      const plan = requirePlan(aggregate, command);
      requireVersion(plan.version, command.expectedVersion);
      if (plan.status === "withdrawn") {
        reject("plan-withdrawn", "A withdrawn plan cannot be revised; propose a new one.");
      }
      if (String(plan.revisionId) === String(command.revisionId)) {
        reject("stale-revision", "A revision must be new wording, not the wording already stored.");
      }
      const carried = new Map(plan.steps.map((step) => [String(step.stepId), step.status]));
      const revised: ThreadPlan = {
        id: plan.id,
        threadId: plan.threadId,
        revisionId: command.revisionId,
        title: command.title,
        // Rewriting the steps is rewriting what was agreed, so the plan goes
        // back to proposed and has to be approved again on its new wording.
        status: "proposed",
        steps: layOutSteps(command.steps, carried),
        proposedAt: plan.proposedAt,
        updatedAt: now,
        version: nextVersion(plan.version),
      };
      return {
        plan: revised,
        history: appendBoundedHistory(aggregate.history, historyOf(revised, now)),
      };
    }
    case "approve-thread-plan": {
      const plan = requirePlan(aggregate, command);
      requireVersion(plan.version, command.expectedVersion);
      if (plan.status !== "proposed") {
        reject("plan-not-proposed", "Only a proposed plan can be approved.");
      }
      if (String(plan.revisionId) !== String(command.revisionId)) {
        reject(
          "stale-revision",
          "That revision is no longer the plan; re-read it before approving.",
        );
      }
      const approved: ThreadPlan = {
        ...plan,
        status: "approved",
        approvedRevisionId: command.revisionId,
        approvedAt: now,
        updatedAt: now,
        version: nextVersion(plan.version),
      };
      return {
        plan: approved,
        history: appendBoundedHistory(aggregate.history, historyOf(approved, now)),
      };
    }
    case "withdraw-thread-plan": {
      const plan = requirePlan(aggregate, command);
      requireVersion(plan.version, command.expectedVersion);
      if (plan.status === "withdrawn") {
        reject("plan-withdrawn", "This plan is already withdrawn.");
      }
      const withdrawn: ThreadPlan = {
        ...plan,
        status: "withdrawn",
        updatedAt: now,
        version: nextVersion(plan.version),
      };
      return {
        plan: withdrawn,
        history: appendBoundedHistory(aggregate.history, historyOf(withdrawn, now)),
      };
    }
    case "set-thread-plan-step-status": {
      const plan = requirePlan(aggregate, command);
      requireVersion(plan.version, command.expectedVersion);
      if (plan.status !== "approved") {
        reject(
          "plan-not-approved",
          "Steps become work only once the plan they belong to has been approved.",
        );
      }
      const target = plan.steps.find((step) => String(step.stepId) === String(command.stepId));
      if (target === undefined) reject("unknown-step", "This plan has no such step.");
      if (target.status === command.status) {
        reject("step-status-unchanged", "That step is already in this state.");
      }
      const stepped: ThreadPlan = {
        ...plan,
        steps: plan.steps.map((step) =>
          String(step.stepId) === String(command.stepId)
            ? { ...step, status: command.status }
            : step,
        ),
        updatedAt: now,
        version: nextVersion(plan.version),
      };
      return { plan: stepped, history: aggregate.history };
    }
  }
}
