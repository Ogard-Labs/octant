import { describe, expect, it } from "vitest";
import { decodeThreadGoal, decodeThreadGoalCommand, decodeThreadGoalStatus } from "./goal";

const occurredAt = "2026-08-01T00:00:00.000Z";
const ids = {
  goal: "00000000-0000-4000-8000-000000000206",
  revision: "00000000-0000-4000-8000-000000000207",
  thread: "00000000-0000-4000-8000-000000000208",
} as const;

describe("thread goal contracts", () => {
  it("decodes active/paused/budget-limited/complete statuses", () => {
    for (const status of ["active", "paused", "budget-limited", "complete"] as const) {
      expect(decodeThreadGoalStatus(status)).toBe(status);
    }
  });

  it("decodes a strict non-secret goal and create command", () => {
    const goal = {
      id: ids.goal,
      threadId: ids.thread,
      revisionId: ids.revision,
      objective: "Ship Goal mode contracts",
      status: "active",
      budget: { tokenBudget: 10_000, turnBudget: 8 },
      usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
      evidence: [],
      createdAt: occurredAt,
      updatedAt: occurredAt,
      version: 1,
    } as const;
    expect(decodeThreadGoal(goal)).toEqual(goal);
    expect(
      decodeThreadGoalCommand({
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: goal.objective,
        budget: goal.budget,
      }),
    ).toMatchObject({ kind: "create-thread-goal" });
    expect(() => decodeThreadGoal({ ...goal, providerSecret: "nope" })).toThrow();
  });

  it("rejects budget exhaustion being encoded as complete without explicit complete command shape", () => {
    expect(
      decodeThreadGoalCommand({
        kind: "record-thread-goal-usage",
        threadId: ids.thread,
        expectedVersion: 1,
        goalId: ids.goal,
        deltaTokens: 100,
        deltaElapsedMs: 1_000,
        deltaTurns: 1,
      }),
    ).toMatchObject({ kind: "record-thread-goal-usage" });
    expect(() =>
      decodeThreadGoalCommand({
        kind: "complete-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1,
        goalId: ids.goal,
        autoCompletedByBudget: true,
      }),
    ).toThrow();
  });
});
