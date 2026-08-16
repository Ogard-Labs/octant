import type {
  AggregateVersion,
  ThreadGoal,
  ThreadGoalBudget,
  ThreadGoalCommand,
  ThreadGoalEvidenceRef,
  ThreadGoalHistoryEntry,
  ThreadGoalUsage,
  UtcTimestamp,
} from "@octant/contracts";
import { MAX_THREAD_GOAL_HISTORY_ENTRIES } from "@octant/contracts";

/**
 * Record a revision, keeping the history within the durable ceiling.
 *
 * The oldest entries are dropped rather than the newest refused: a goal that
 * has been revised to the ceiling must stay revisable and completable, and an
 * unbounded append would make the very next write fail its durable decode and
 * strand the goal permanently.
 */
function appendBoundedHistory(
  history: ReadonlyArray<ThreadGoalHistoryEntry>,
  entry: ThreadGoalHistoryEntry,
): ReadonlyArray<ThreadGoalHistoryEntry> {
  const appended = [...history, entry];
  return appended.length <= MAX_THREAD_GOAL_HISTORY_ENTRIES
    ? appended
    : appended.slice(appended.length - MAX_THREAD_GOAL_HISTORY_ENTRIES);
}

export type GoalPolicyRejectionCode =
  | "goal-already-active"
  | "goal-not-found"
  | "goal-not-active"
  | "goal-not-paused"
  | "goal-already-complete"
  | "invalid-budget"
  | "version-conflict";

export class GoalPolicyRejection extends Error {
  readonly code: GoalPolicyRejectionCode;

  constructor(code: GoalPolicyRejectionCode, message: string) {
    super(message);
    this.name = "GoalPolicyRejection";
    this.code = code;
  }
}

export interface GoalAggregate {
  readonly goal: ThreadGoal | null;
  readonly history: ReadonlyArray<ThreadGoalHistoryEntry>;
}

function reject(code: GoalPolicyRejectionCode, message: string): never {
  throw new GoalPolicyRejection(code, message);
}

function nextVersion(version: AggregateVersion): AggregateVersion {
  return (version + 1) as AggregateVersion;
}

function emptyUsage(): ThreadGoalUsage {
  return { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 };
}

function normalizeBudget(budget: ThreadGoalBudget): ThreadGoalBudget {
  const tokenBudget = budget.tokenBudget;
  const timeBudgetMs = budget.timeBudgetMs;
  const turnBudget = budget.turnBudget;
  if (tokenBudget === undefined && timeBudgetMs === undefined && turnBudget === undefined) {
    return {};
  }
  if (
    (tokenBudget !== undefined && tokenBudget <= 0) ||
    (timeBudgetMs !== undefined && timeBudgetMs <= 0) ||
    (turnBudget !== undefined && turnBudget <= 0)
  ) {
    reject("invalid-budget", "Goal budgets must be positive when provided.");
  }
  return {
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(timeBudgetMs === undefined ? {} : { timeBudgetMs }),
    ...(turnBudget === undefined ? {} : { turnBudget }),
  };
}

function isBudgetExhausted(budget: ThreadGoalBudget, usage: ThreadGoalUsage): boolean {
  if (budget.tokenBudget !== undefined && usage.tokensUsed >= budget.tokenBudget) return true;
  if (budget.timeBudgetMs !== undefined && usage.elapsedMs >= budget.timeBudgetMs) return true;
  if (budget.turnBudget !== undefined && usage.turnsUsed >= budget.turnBudget) return true;
  return false;
}

function assertVersion(goal: ThreadGoal | null, expectedVersion: number): void {
  const current = goal?.version ?? 0;
  if (current !== expectedVersion) {
    reject("version-conflict", "Goal version conflict; reload and retry.");
  }
}

export function applyThreadGoalCommand(
  aggregate: GoalAggregate,
  command: ThreadGoalCommand,
  now: UtcTimestamp,
): GoalAggregate {
  switch (command.kind) {
    case "create-thread-goal": {
      if (aggregate.goal !== null && aggregate.goal.status !== "complete") {
        reject("goal-already-active", "A thread may have at most one non-complete Goal.");
      }
      assertVersion(aggregate.goal, command.expectedVersion);
      const budget = normalizeBudget(command.budget);
      const goal: ThreadGoal = {
        id: command.goalId,
        threadId: command.threadId,
        revisionId: command.revisionId,
        objective: command.objective.trim(),
        status: "active",
        budget,
        usage: emptyUsage(),
        evidence: [],
        createdAt: now,
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return {
        goal,
        history: appendBoundedHistory(aggregate.history, {
          revisionId: goal.revisionId,
          objective: goal.objective,
          status: goal.status,
          recordedAt: now,
        }),
      };
    }
    case "pause-thread-goal": {
      const current = aggregate.goal;
      if (current === null || current.id !== command.goalId) {
        reject("goal-not-found", "Goal was not found for this thread.");
      }
      assertVersion(current, command.expectedVersion);
      if (current.status === "complete")
        reject("goal-already-complete", "Goal is already complete.");
      if (current.status !== "active" && current.status !== "budget-limited") {
        reject("goal-not-active", "Only an active or budget-limited Goal can be paused.");
      }
      const goal: ThreadGoal = {
        ...current,
        status: "paused",
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return { goal, history: aggregate.history };
    }
    case "resume-thread-goal": {
      const current = aggregate.goal;
      if (current === null || current.id !== command.goalId) {
        reject("goal-not-found", "Goal was not found for this thread.");
      }
      assertVersion(current, command.expectedVersion);
      if (current.status === "complete")
        reject("goal-already-complete", "Goal is already complete.");
      if (current.status !== "paused" && current.status !== "budget-limited") {
        reject("goal-not-paused", "Only a paused or budget-limited Goal can be resumed.");
      }
      const status = isBudgetExhausted(current.budget, current.usage)
        ? ("budget-limited" as const)
        : ("active" as const);
      const goal: ThreadGoal = {
        ...current,
        status,
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return { goal, history: aggregate.history };
    }
    case "revise-thread-goal": {
      const current = aggregate.goal;
      if (current === null || current.id !== command.goalId) {
        reject("goal-not-found", "Goal was not found for this thread.");
      }
      assertVersion(current, command.expectedVersion);
      if (current.status === "complete")
        reject("goal-already-complete", "Goal is already complete.");
      const budget = normalizeBudget(command.budget ?? current.budget);
      const status = isBudgetExhausted(budget, current.usage)
        ? ("budget-limited" as const)
        : current.status === "paused"
          ? ("paused" as const)
          : ("active" as const);
      const goal: ThreadGoal = {
        ...current,
        revisionId: command.revisionId,
        objective: command.objective.trim(),
        budget,
        status,
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return {
        goal,
        history: appendBoundedHistory(aggregate.history, {
          revisionId: goal.revisionId,
          objective: goal.objective,
          status: goal.status,
          recordedAt: now,
        }),
      };
    }
    case "complete-thread-goal": {
      const current = aggregate.goal;
      if (current === null || current.id !== command.goalId) {
        reject("goal-not-found", "Goal was not found for this thread.");
      }
      assertVersion(current, command.expectedVersion);
      if (current.status === "complete")
        reject("goal-already-complete", "Goal is already complete.");
      const evidence: ReadonlyArray<ThreadGoalEvidenceRef> = [
        ...current.evidence,
        ...(command.evidence ?? []),
      ].slice(-64);
      const goal: ThreadGoal = {
        ...current,
        status: "complete",
        evidence,
        completedAt: now,
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return {
        goal,
        history: appendBoundedHistory(aggregate.history, {
          revisionId: goal.revisionId,
          objective: goal.objective,
          status: goal.status,
          recordedAt: now,
        }),
      };
    }
    case "record-thread-goal-usage": {
      const current = aggregate.goal;
      if (current === null || current.id !== command.goalId) {
        reject("goal-not-found", "Goal was not found for this thread.");
      }
      assertVersion(current, command.expectedVersion);
      if (current.status === "complete")
        reject("goal-already-complete", "Goal is already complete.");
      if (current.status === "paused") {
        reject("goal-not-active", "Paused Goals do not accumulate usage.");
      }
      const usage: ThreadGoalUsage = {
        tokensUsed: current.usage.tokensUsed + command.deltaTokens,
        elapsedMs: current.usage.elapsedMs + command.deltaElapsedMs,
        turnsUsed: current.usage.turnsUsed + command.deltaTurns,
      };
      const exhausted = isBudgetExhausted(current.budget, usage);
      const goal: ThreadGoal = {
        ...current,
        usage,
        // Budget exhaustion becomes budget-limited, never inferred complete.
        status: exhausted
          ? "budget-limited"
          : current.status === "budget-limited"
            ? "budget-limited"
            : "active",
        updatedAt: now,
        version: nextVersion(command.expectedVersion),
      };
      return { goal, history: aggregate.history };
    }
  }
}
