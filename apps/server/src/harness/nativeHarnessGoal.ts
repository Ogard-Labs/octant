import {
  decodeThreadGoalRevisionId,
  type ThreadGoal,
  type ThreadGoalCriterionDraft,
  type ThreadGoalEvidenceRef,
} from "@octant/contracts";
import { threadGoalCriteriaMet } from "@octant/domain";
import type { GoalService } from "../goal/goalService";

/**
 * The thread's goal as the harness may touch it. Every change goes through
 * the goal service's ordinary commands, so the goal's own policy decides it;
 * the port adds only the rules the lead is held to on top.
 */
export interface NativeHarnessGoalPort {
  readonly read: () => ThreadGoal | undefined;
  readonly setCriteria: (
    criteria: ReadonlyArray<ThreadGoalCriterionDraft>,
  ) => Promise<NativeHarnessGoalChange>;
  /** Records one criterion's observed check, and completes the goal when that was the last one. */
  readonly recordCheck: (input: {
    readonly criterionId: string;
    /** The criterion exactly as it was when its check ran; a different one takes no result. */
    readonly checked: { readonly text: string; readonly check: string };
    readonly outcome: "met" | "unmet";
    readonly evidence: ThreadGoalEvidenceRef;
  }) => Promise<NativeHarnessGoalChange>;
}

export type NativeHarnessGoalChange =
  | { readonly status: "recorded"; readonly goal: ThreadGoal }
  | { readonly status: "refused"; readonly reason: string; readonly message: string };

export function createNativeHarnessGoalPort(options: {
  readonly goals: Pick<GoalService, "read" | "execute">;
  readonly threadId: string;
  readonly uuid: () => string;
}): NativeHarnessGoalPort {
  const read = () => options.goals.read(options.threadId).goal ?? undefined;
  const run = async (command: Record<string, unknown>): Promise<NativeHarnessGoalChange> => {
    try {
      const updated = await options.goals.execute({ threadId: options.threadId, ...command });
      return { status: "recorded", goal: updated.goal };
    } catch (error) {
      return {
        status: "refused",
        reason: "goal-refused",
        message: error instanceof Error ? error.message : "The goal refused the change.",
      };
    }
  };
  return {
    read,
    setCriteria: async (criteria) => {
      const goal = read();
      if (goal === undefined) return noGoal();
      if (goal.status === "complete") return completed();
      if ((goal.criteria ?? []).length > 0) {
        return {
          status: "refused",
          reason: "criteria-already-set",
          message:
            "The goal already has criteria. Only a person revises them; work toward the ones it has.",
        };
      }
      return run({
        kind: "revise-thread-goal",
        expectedVersion: goal.version,
        goalId: goal.id,
        revisionId: decodeThreadGoalRevisionId(options.uuid()),
        objective: goal.objective,
        criteria,
      });
    },
    recordCheck: async ({ criterionId, checked: ran, outcome, evidence }) => {
      const goal = read();
      if (goal === undefined) return noGoal();
      if (goal.status === "complete") return completed();
      // The goal may have moved while the command ran — spend recorded, other
      // criteria checked — and that is fine. What may not move is this
      // criterion: a result proves the statement and command that ran, never
      // a revised one that happens to keep the same id.
      const live = (goal.criteria ?? []).find((criterion) => criterion.id === criterionId);
      if (live === undefined || live.text !== ran.text || live.check !== ran.check) {
        return {
          status: "refused",
          reason: "criterion-changed",
          message: `${criterionId} changed while its check ran, so the result was not recorded. Read the goal and check it again.`,
        };
      }
      const checked = await run({
        kind: "record-thread-goal-check",
        expectedVersion: goal.version,
        goalId: goal.id,
        criterionId,
        outcome,
        evidence,
      });
      if (checked.status !== "recorded" || !threadGoalCriteriaMet(checked.goal)) return checked;
      // Every criterion now has a passing check the host observed and already
      // recorded on the goal: that is the evidence completion requires
      // (decision 0025), so the goal completes here rather than waiting for a
      // model to claim it is done.
      const completion = await run({
        kind: "complete-thread-goal",
        expectedVersion: checked.goal.version,
        goalId: checked.goal.id,
      });
      if (completion.status === "recorded") return completion;
      // The check is already recorded; only completion lost a race (a person
      // touched the goal in between). Try once more against what is there
      // now, and otherwise report the check that did happen rather than an
      // error that would send the lead to re-run it.
      const latest = read();
      if (latest !== undefined && latest.status !== "complete" && threadGoalCriteriaMet(latest)) {
        const retried = await run({
          kind: "complete-thread-goal",
          expectedVersion: latest.version,
          goalId: latest.id,
        });
        if (retried.status === "recorded") return retried;
      }
      return latest === undefined ? checked : { status: "recorded", goal: latest };
    },
  };
}

/** The goal as the lead reads it: what to achieve, what is left, and what it may still spend. */
export function nativeHarnessGoalSummary(goal: ThreadGoal) {
  const criteria = goal.criteria ?? [];
  return {
    objective: goal.objective,
    status: goal.status,
    criteria: criteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      ...(criterion.check === undefined ? { confirmedBy: "a person" } : { check: criterion.check }),
      status: criterion.status,
      ...(criterion.evidence === undefined ? {} : { lastCheck: criterion.evidence.summary }),
    })),
    allCriteriaMet: threadGoalCriteriaMet(goal),
    budget: budgetLeft(goal),
  };
}

/**
 * The goal in front of every harness turn. It is per-turn content, not part
 * of the stable instructions, because its statuses change as checks pass.
 */
export function nativeHarnessGoalContext(goal: ThreadGoal): string | undefined {
  if (goal.status === "complete") return undefined;
  const criteria = goal.criteria ?? [];
  const budget = budgetLeft(goal);
  return [
    `Thread goal (${goal.status}): ${goal.objective}`,
    ...(criteria.length === 0
      ? [
          "It has no acceptance criteria yet. Write them first with goal set-criteria: concrete statements, each with a check command where one can prove it.",
        ]
      : [
          "Criteria:",
          ...criteria.map(
            (criterion) =>
              `- [${criterion.status}] ${criterion.id}: ${criterion.text}${
                criterion.check === undefined
                  ? " (a person confirms this one)"
                  : ` (check: ${criterion.check})`
              }`,
          ),
          "Run goal-check on a criterion when you believe it holds. The goal completes only when every check passes; then stop.",
        ]),
    ...(budget.length === 0 ? [] : [`Budget left: ${budget.join(", ")}.`]),
    ...(goal.status === "budget-limited"
      ? ["The budget is spent. Summarize where the work stands and stop."]
      : []),
  ].join("\n");
}

function budgetLeft(goal: ThreadGoal): ReadonlyArray<string> {
  const { budget, usage } = goal;
  return [
    ...(budget.turnBudget === undefined
      ? []
      : [`${Math.max(0, budget.turnBudget - usage.turnsUsed)} of ${budget.turnBudget} turns`]),
    ...(budget.tokenBudget === undefined
      ? []
      : [`${Math.max(0, budget.tokenBudget - usage.tokensUsed)} of ${budget.tokenBudget} tokens`]),
    ...(budget.timeBudgetMs === undefined
      ? []
      : [
          `${Math.max(0, Math.round((budget.timeBudgetMs - usage.elapsedMs) / 60_000))} of ${Math.round(budget.timeBudgetMs / 60_000)} minutes`,
        ]),
  ];
}

function noGoal(): NativeHarnessGoalChange {
  return {
    status: "refused",
    reason: "no-goal",
    message: "This thread has no goal. Ask the person to set one if the work needs it.",
  };
}

function completed(): NativeHarnessGoalChange {
  return { status: "refused", reason: "goal-complete", message: "The goal is already complete." };
}
