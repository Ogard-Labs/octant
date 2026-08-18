import { describe, expect, it } from "vitest";
import type { AggregateVersion, ThreadPlanCommand, UtcTimestamp } from "@octant/contracts";
import {
  applyThreadPlanCommand,
  ThreadPlanPolicyRejection,
  type ThreadPlanAggregate,
} from "./threadPlanPolicy";

const threadId = "10000000-0000-4000-8000-000000000001";
const planId = "20000000-0000-4000-8000-000000000001" as never;
const revisionA = "30000000-0000-4000-8000-00000000000a" as never;
const revisionB = "30000000-0000-4000-8000-00000000000b" as never;
const stepOne = "40000000-0000-4000-8000-000000000001" as never;
const stepTwo = "40000000-0000-4000-8000-000000000002" as never;
const stepThree = "40000000-0000-4000-8000-000000000003" as never;
const now = "2026-08-18T09:00:00.000Z" as UtcTimestamp;
const later = "2026-08-18T09:30:00.000Z" as UtcTimestamp;

const empty: ThreadPlanAggregate = { plan: null, history: [] };

function propose(overrides: Partial<ThreadPlanCommand> = {}): ThreadPlanCommand {
  return {
    kind: "propose-thread-plan",
    threadId,
    expectedVersion: 0 as AggregateVersion,
    planId,
    revisionId: revisionA,
    title: "Land the projection replay fix",
    steps: [
      { stepId: stepOne, title: "Reproduce the replay gap", rationale: "The report is vague." },
      { stepId: stepTwo, title: "Fix the projection" },
    ],
    ...overrides,
  } as ThreadPlanCommand;
}

function proposed(): ThreadPlanAggregate {
  return applyThreadPlanCommand(empty, propose(), now);
}

function approved(): ThreadPlanAggregate {
  const current = proposed();
  return applyThreadPlanCommand(
    current,
    {
      kind: "approve-thread-plan",
      threadId,
      expectedVersion: current.plan!.version,
      planId,
      revisionId: revisionA,
    },
    later,
  );
}

describe("proposing a plan", () => {
  it("orders the steps as they were written and claims no progress", () => {
    const aggregate = proposed();

    expect(aggregate.plan?.status).toBe("proposed");
    expect(aggregate.plan?.steps).toEqual([
      {
        stepId: stepOne,
        position: 0,
        title: "Reproduce the replay gap",
        rationale: "The report is vague.",
        status: "pending",
      },
      { stepId: stepTwo, position: 1, title: "Fix the projection", status: "pending" },
    ]);
    expect(aggregate.plan?.approvedAt).toBeUndefined();
    expect(aggregate.history).toHaveLength(1);
  });

  it("refuses a second plan while one is already live on the thread", () => {
    const current = proposed();

    expect(() =>
      applyThreadPlanCommand(
        current,
        propose({ expectedVersion: current.plan!.version, revisionId: revisionB } as never),
        later,
      ),
    ).toThrow(ThreadPlanPolicyRejection);
  });

  it("refuses two steps claiming the same identity", () => {
    expect(() =>
      applyThreadPlanCommand(
        empty,
        propose({
          steps: [
            { stepId: stepOne, title: "First" },
            { stepId: stepOne, title: "Also first" },
          ],
        } as never),
        now,
      ),
    ).toThrow(/step/i);
  });
});

describe("approving a plan", () => {
  it("records the approval against the exact revision that was read", () => {
    const aggregate = approved();

    expect(aggregate.plan?.status).toBe("approved");
    expect(aggregate.plan?.approvedRevisionId).toBe(revisionA);
    expect(aggregate.plan?.approvedAt).toBe(later);
  });

  it("refuses to approve a revision the reader never saw", () => {
    const current = proposed();

    expect(() =>
      applyThreadPlanCommand(
        current,
        {
          kind: "approve-thread-plan",
          threadId,
          expectedVersion: current.plan!.version,
          planId,
          revisionId: revisionB,
        },
        later,
      ),
    ).toThrow(/revision/i);
  });

  it("loses the approval when the plan is rewritten, and keeps work already done", () => {
    const current = applyThreadPlanCommand(
      approved(),
      {
        kind: "set-thread-plan-step-status",
        threadId,
        expectedVersion: approved().plan!.version,
        planId,
        stepId: stepOne,
        status: "done",
      },
      later,
    );

    const revised = applyThreadPlanCommand(
      current,
      {
        kind: "revise-thread-plan",
        threadId,
        expectedVersion: current.plan!.version,
        planId,
        revisionId: revisionB,
        title: "Land the replay fix, with a test",
        steps: [
          { stepId: stepOne, title: "Reproduce the replay gap" },
          { stepId: stepThree, title: "Add the regression test" },
        ],
      },
      later,
    );

    expect(revised.plan?.status).toBe("proposed");
    expect(revised.plan?.approvedAt).toBeUndefined();
    expect(revised.plan?.approvedRevisionId).toBeUndefined();
    // The step that survived the rewrite keeps what was actually done to it;
    // a step that is new to this revision has not been started.
    expect(revised.plan?.steps.map((step) => [step.stepId, step.status])).toEqual([
      [stepOne, "done"],
      [stepThree, "pending"],
    ]);
  });
});

describe("working through an approved plan", () => {
  it("moves a step and keeps the rest of the plan where it was", () => {
    const current = approved();

    const next = applyThreadPlanCommand(
      current,
      {
        kind: "set-thread-plan-step-status",
        threadId,
        expectedVersion: current.plan!.version,
        planId,
        stepId: stepTwo,
        status: "in-progress",
      },
      later,
    );

    expect(next.plan?.steps.map((step) => step.status)).toEqual(["pending", "in-progress"]);
    expect(next.plan?.status).toBe("approved");
  });

  it("refuses to start work on a plan nobody has approved", () => {
    const current = proposed();

    expect(() =>
      applyThreadPlanCommand(
        current,
        {
          kind: "set-thread-plan-step-status",
          threadId,
          expectedVersion: current.plan!.version,
          planId,
          stepId: stepOne,
          status: "in-progress",
        },
        later,
      ),
    ).toThrow(/approv/i);
  });

  it("refuses a step the plan does not have", () => {
    const current = approved();

    expect(() =>
      applyThreadPlanCommand(
        current,
        {
          kind: "set-thread-plan-step-status",
          threadId,
          expectedVersion: current.plan!.version,
          planId,
          stepId: stepThree,
          status: "done",
        },
        later,
      ),
    ).toThrow(/step/i);
  });
});

describe("withdrawing a plan", () => {
  it("frees the thread to propose a different plan", () => {
    const current = approved();
    const withdrawn = applyThreadPlanCommand(
      current,
      {
        kind: "withdraw-thread-plan",
        threadId,
        expectedVersion: current.plan!.version,
        planId,
      },
      later,
    );

    expect(withdrawn.plan?.status).toBe("withdrawn");
    const replacement = applyThreadPlanCommand(
      withdrawn,
      propose({
        expectedVersion: withdrawn.plan!.version,
        planId: "20000000-0000-4000-8000-000000000002",
        revisionId: revisionB,
      } as never),
      later,
    );
    expect(replacement.plan?.status).toBe("proposed");
  });
});

describe("every plan command", () => {
  it("refuses a version the caller did not actually read", () => {
    const current = proposed();

    expect(() =>
      applyThreadPlanCommand(
        current,
        {
          kind: "approve-thread-plan",
          threadId,
          expectedVersion: 99 as AggregateVersion,
          planId,
          revisionId: revisionA,
        },
        later,
      ),
    ).toThrow(/moved under this command/i);
  });

  it("refuses a command aimed at another thread's plan", () => {
    const current = proposed();

    expect(() =>
      applyThreadPlanCommand(
        current,
        {
          kind: "approve-thread-plan",
          threadId,
          expectedVersion: current.plan!.version,
          planId: "20000000-0000-4000-8000-000000000009" as never,
          revisionId: revisionA,
        },
        later,
      ),
    ).toThrow(/plan/i);
  });
});
