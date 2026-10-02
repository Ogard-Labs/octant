import { describe, expect, it } from "vitest";
import {
  applyThreadGoalCommand,
  GoalPolicyRejection,
  threadGoalCriteriaMet,
  type GoalAggregate,
} from "./goalPolicy";
import { mayCompleteGoalLoop } from "./goalLoopPolicy";
import {
  decodeThreadGoalUpdated,
  MAX_THREAD_GOAL_HISTORY_ENTRIES,
  type AggregateVersion,
  type ThreadGoalId,
  type ThreadGoalRevisionId,
  type UtcTimestamp,
} from "@octant/contracts";

const now = "2026-08-01T00:00:00.000Z" as UtcTimestamp;
const later = "2026-08-01T00:01:00.000Z" as UtcTimestamp;
const ids = {
  goal: "00000000-0000-4000-8000-000000000206" as ThreadGoalId,
  revision: "00000000-0000-4000-8000-000000000207" as ThreadGoalRevisionId,
  revision2: "00000000-0000-4000-8000-000000000209" as ThreadGoalRevisionId,
  thread: "00000000-0000-4000-8000-000000000208",
} as const;

function empty(): GoalAggregate {
  return { goal: null, history: [] };
}

describe("thread goal policy", () => {
  it("keeps a long-lived goal writable by bounding its history", () => {
    // A goal revised to the contract's history ceiling must still be
    // revisable and completable: the durable payload caps history at
    // MAX_THREAD_GOAL_HISTORY_ENTRIES, so an unbounded append would make the
    // next write undecodable and strand the goal.
    let aggregate = applyThreadGoalCommand(
      empty(),
      {
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: "Objective 0",
        budget: { turnBudget: 2 },
      },
      now,
    );
    for (let revision = 1; revision <= MAX_THREAD_GOAL_HISTORY_ENTRIES + 4; revision += 1) {
      aggregate = applyThreadGoalCommand(
        aggregate,
        {
          kind: "revise-thread-goal",
          threadId: ids.thread,
          expectedVersion: revision as AggregateVersion,
          goalId: ids.goal,
          revisionId: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}` as never,
          objective: `Objective ${revision}`,
        },
        later,
      );
      expect(aggregate.history.length).toBeLessThanOrEqual(MAX_THREAD_GOAL_HISTORY_ENTRIES);
    }
    // The oldest entries are the ones dropped, so the newest revision survives.
    expect(aggregate.history.at(-1)?.objective).toBe(
      `Objective ${MAX_THREAD_GOAL_HISTORY_ENTRIES + 4}`,
    );
    expect(
      decodeThreadGoalUpdated({ goal: aggregate.goal, history: aggregate.history }),
    ).toBeDefined();
  });

  it("creates one active goal and preserves history on revise/complete", () => {
    const created = applyThreadGoalCommand(
      empty(),
      {
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: "Land Goal contracts",
        budget: { turnBudget: 2 },
      },
      now,
    );
    expect(created.goal?.status).toBe("active");

    const revised = applyThreadGoalCommand(
      created,
      {
        kind: "revise-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision2,
        objective: "Land Goal contracts and UI card",
      },
      later,
    );
    expect(revised.history).toHaveLength(2);

    const completed = applyThreadGoalCommand(
      revised,
      {
        kind: "complete-thread-goal",
        threadId: ids.thread,
        expectedVersion: 2 as AggregateVersion,
        goalId: ids.goal,
        evidence: [
          {
            kind: "user-confirmation",
            referenceId: "qa-1",
            summary: "Accepted",
            observedAt: later,
          },
        ],
      },
      later,
    );
    expect(completed.goal?.status).toBe("complete");
    expect(completed.history.at(-1)?.status).toBe("complete");
  });

  it("marks budget exhaustion as budget-limited, never complete", () => {
    const created = applyThreadGoalCommand(
      empty(),
      {
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: "Budgeted work",
        budget: { tokenBudget: 100, turnBudget: 1 },
      },
      now,
    );
    const limited = applyThreadGoalCommand(
      created,
      {
        kind: "record-thread-goal-usage",
        threadId: ids.thread,
        expectedVersion: 1 as AggregateVersion,
        goalId: ids.goal,
        deltaTokens: 100,
        deltaElapsedMs: 10,
        deltaTurns: 1,
      },
      later,
    );
    expect(limited.goal?.status).toBe("budget-limited");
    expect(limited.goal?.status).not.toBe("complete");
  });

  it("rejects a second non-complete goal on the same thread", () => {
    const created = applyThreadGoalCommand(
      empty(),
      {
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: "First",
        budget: {},
      },
      now,
    );
    expect(() =>
      applyThreadGoalCommand(
        created,
        {
          kind: "create-thread-goal",
          threadId: ids.thread,
          expectedVersion: 1 as AggregateVersion,
          goalId: "00000000-0000-4000-8000-000000000299" as ThreadGoalId,
          revisionId: ids.revision2,
          objective: "Second",
          budget: {},
        },
        later,
      ),
    ).toThrow(GoalPolicyRejection);
  });

  it("supports pause and resume transitions", () => {
    let aggregate = applyThreadGoalCommand(
      empty(),
      {
        kind: "create-thread-goal",
        threadId: ids.thread,
        expectedVersion: 0 as AggregateVersion,
        goalId: ids.goal,
        revisionId: ids.revision,
        objective: "Pauseable",
        budget: {},
      },
      now,
    );
    aggregate = applyThreadGoalCommand(
      aggregate,
      {
        kind: "pause-thread-goal",
        threadId: ids.thread,
        expectedVersion: 1 as AggregateVersion,
        goalId: ids.goal,
      },
      later,
    );
    expect(aggregate.goal?.status).toBe("paused");
    aggregate = applyThreadGoalCommand(
      aggregate,
      {
        kind: "resume-thread-goal",
        threadId: ids.thread,
        expectedVersion: 2 as AggregateVersion,
        goalId: ids.goal,
      },
      later,
    );
    expect(aggregate.goal?.status).toBe("active");
  });

  describe("criteria", () => {
    const evidence = (summary: string) => ({
      kind: "test" as const,
      referenceId: "check-run",
      summary,
      observedAt: later,
    });
    const created = () =>
      applyThreadGoalCommand(
        empty(),
        {
          kind: "create-thread-goal",
          threadId: ids.thread,
          expectedVersion: 0 as AggregateVersion,
          goalId: ids.goal,
          revisionId: ids.revision,
          objective: "Ship the parser",
          budget: { turnBudget: 10 },
          criteria: [{ text: "Tests pass", check: "bun run test" }, { text: "Docs updated" }],
        },
        now,
      );
    const check = (aggregate: GoalAggregate, criterionId: string, outcome: "met" | "unmet") =>
      applyThreadGoalCommand(
        aggregate,
        {
          kind: "record-thread-goal-check",
          threadId: ids.thread,
          expectedVersion: (aggregate.goal?.version ?? 0) as AggregateVersion,
          goalId: ids.goal,
          criterionId,
          outcome,
          evidence: evidence(`${criterionId} ${outcome}`),
        },
        later,
      );

    it("numbers new criteria and starts every one unmet", () => {
      const goal = created().goal;
      expect(goal?.criteria?.map((criterion) => [criterion.id, criterion.status])).toEqual([
        ["c1", "unmet"],
        ["c2", "unmet"],
      ]);
      expect(goal === null ? true : threadGoalCriteriaMet(goal)).toBe(false);
    });

    it("records a failed check without completing the goal", () => {
      const goal = check(created(), "c1", "unmet").goal;
      expect(goal?.status).toBe("active");
      expect(goal?.criteria?.[0]?.evidence?.summary).toBe("c1 unmet");
      expect(goal?.evidence.at(-1)?.summary).toBe("c1 unmet");
    });

    it("counts the criteria met only when every check has passed", () => {
      const once = check(created(), "c1", "met");
      expect(once.goal === null ? true : threadGoalCriteriaMet(once.goal)).toBe(false);
      const both = check(once, "c2", "met");
      expect(both.goal === null ? false : threadGoalCriteriaMet(both.goal)).toBe(true);
      // Meeting the criteria is a fact about the goal, not a transition: only
      // a completion command moves it to complete.
      expect(both.goal?.status).toBe("active");
    });

    it("keeps a passed check when a revision only adds a criterion", () => {
      const passed = check(created(), "c1", "met");
      const revised = applyThreadGoalCommand(
        passed,
        {
          kind: "revise-thread-goal",
          threadId: ids.thread,
          expectedVersion: (passed.goal?.version ?? 0) as AggregateVersion,
          goalId: ids.goal,
          revisionId: ids.revision2,
          objective: "Ship the parser",
          criteria: [
            { text: "Tests pass", check: "bun run test" },
            { text: "Docs updated" },
            { text: "Lint is clean", check: "bun run lint" },
          ],
        },
        later,
      );
      expect(revised.goal?.criteria?.map((criterion) => criterion.status)).toEqual([
        "met",
        "unmet",
        "unmet",
      ]);
      expect(() => decodeThreadGoalUpdated(revised)).not.toThrow();
    });

    it("lends one passed check to only one of two identical revised criteria", () => {
      const passed = check(created(), "c1", "met");
      const revised = applyThreadGoalCommand(
        passed,
        {
          kind: "revise-thread-goal",
          threadId: ids.thread,
          expectedVersion: (passed.goal?.version ?? 0) as AggregateVersion,
          goalId: ids.goal,
          revisionId: ids.revision2,
          objective: "Ship the parser",
          criteria: [
            { text: "Tests pass", check: "bun run test" },
            { text: "Tests pass", check: "bun run test" },
          ],
        },
        later,
      );
      expect(revised.goal?.criteria?.map((criterion) => criterion.status)).toEqual([
        "met",
        "unmet",
      ]);
    });

    it("refuses a check for a criterion the goal does not have", () => {
      expect(() => check(created(), "c9", "met")).toThrow(GoalPolicyRejection);
    });

    it("lets a loop complete a goal with criteria only when every criterion is met", () => {
      const partly = check(created(), "c1", "met").goal;
      expect(
        mayCompleteGoalLoop({
          evidence: partly?.evidence ?? [],
          providerReportsComplete: true,
          criteria: partly?.criteria,
        }),
      ).toBe(false);
      const fully = check(check(created(), "c1", "met"), "c2", "met").goal;
      expect(
        mayCompleteGoalLoop({
          evidence: fully?.evidence ?? [],
          providerReportsComplete: true,
          criteria: fully?.criteria,
        }),
      ).toBe(true);
    });
  });
});
