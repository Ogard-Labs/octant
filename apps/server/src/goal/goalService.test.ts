import { describe, expect, it } from "vitest";
import { GoalService, GoalServiceError, InMemoryGoalStore } from "./goalService";

const ids = {
  goal: "00000000-0000-4000-8000-000000000206",
  revision: "00000000-0000-4000-8000-000000000207",
  thread: "00000000-0000-4000-8000-000000000208",
} as const;

describe("GoalService", () => {
  it("creates, budget-limits, and completes a goal without inferred completion", async () => {
    const service = new GoalService({
      store: new InMemoryGoalStore(),
      clock: () => "2026-08-01T00:00:00.000Z",
    });
    const created = await service.execute({
      kind: "create-thread-goal",
      threadId: ids.thread,
      expectedVersion: 0,
      goalId: ids.goal,
      revisionId: ids.revision,
      objective: "Finish Goal mode",
      budget: { turnBudget: 1 },
    });
    expect(created.goal.status).toBe("active");
    const limited = await service.execute({
      kind: "record-thread-goal-usage",
      threadId: ids.thread,
      expectedVersion: 1,
      goalId: ids.goal,
      deltaTokens: 0,
      deltaElapsedMs: 0,
      deltaTurns: 1,
    });
    expect(limited.goal.status).toBe("budget-limited");
    const completed = await service.execute({
      kind: "complete-thread-goal",
      threadId: ids.thread,
      expectedVersion: 2,
      goalId: ids.goal,
      evidence: [
        {
          kind: "user-confirmation",
          referenceId: "accept-1",
          summary: "User completed goal",
          observedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    expect(completed.goal.status).toBe("complete");
  });

  it("rejects stale versions", async () => {
    const service = new GoalService({ store: new InMemoryGoalStore() });
    await service.execute({
      kind: "create-thread-goal",
      threadId: ids.thread,
      expectedVersion: 0,
      goalId: ids.goal,
      revisionId: ids.revision,
      objective: "Stale check",
      budget: {},
    });
    await expect(
      service.execute({
        kind: "pause-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0,
        goalId: ids.goal,
      }),
    ).rejects.toBeInstanceOf(GoalServiceError);
  });
});
