import type { ThreadGoal, ThreadGoalEvidenceRef } from "@octant/contracts";
import type { GoalService } from "./goalService";

/**
 * Charges one goal-loop round to its goal, at most once per round id.
 *
 * The charge and the loop's round record are two journal writes, so a host
 * that stops between them restarts with the round still open and settles it
 * again. The round id travels with the charge and the goal keeps it, so the
 * second settlement finds the round already paid for and adds nothing.
 */
export async function chargeGoalForRound(
  goals: Pick<GoalService, "read" | "execute">,
  input: {
    readonly threadId: string;
    readonly roundId: string;
    readonly goal: ThreadGoal;
    readonly tokensSpent: number;
    readonly elapsedMs: number;
    readonly evidence: ReadonlyArray<ThreadGoalEvidenceRef>;
    readonly complete: boolean;
  },
): Promise<void> {
  // The round's own turn may have moved the goal — a harness lead runs goal
  // checks, and the last passing one completes it. Charge the round against
  // the goal as it is now; a goal its own checks completed is finished and
  // takes no further spend.
  const current = goals.read(input.threadId).goal ?? input.goal;
  if (current.status === "complete") return;
  if (current.recentChargeIds?.includes(input.roundId) === true) return;
  const recorded = await goals.execute({
    kind: "record-thread-goal-usage",
    threadId: input.threadId,
    expectedVersion: current.version,
    goalId: input.goal.id,
    deltaTokens: input.tokensSpent,
    deltaElapsedMs: input.elapsedMs,
    deltaTurns: 1,
    chargeId: input.roundId,
  });
  if (!input.complete) return;
  await goals.execute({
    kind: "complete-thread-goal",
    threadId: input.threadId,
    expectedVersion: recorded.goal.version,
    goalId: input.goal.id,
    evidence: input.evidence.slice(0, 16),
  });
}
