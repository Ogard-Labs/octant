import { describe, expect, it } from "vitest";
import {
  decodeThreadPlan,
  decodeThreadPlanCommand,
  decodeThreadPlanUpdated,
  MAX_THREAD_PLAN_STEPS,
} from "./threadPlan";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  plan: "20000000-0000-4000-8000-000000000001",
  revision: "30000000-0000-4000-8000-000000000001",
  step: "40000000-0000-4000-8000-000000000001",
} as const;

const plan = {
  id: ids.plan,
  threadId: ids.thread,
  revisionId: ids.revision,
  title: "Land the projection replay fix",
  status: "proposed",
  steps: [
    {
      stepId: ids.step,
      position: 0,
      title: "Reproduce the replay gap",
      rationale: "The report does not say which projection.",
      status: "pending",
    },
  ],
  proposedAt: "2026-08-18T09:00:00.000Z",
  updatedAt: "2026-08-18T09:00:00.000Z",
  version: 1,
};

describe("the thread plan contract", () => {
  it("keeps a step's reason with the step it explains", () => {
    expect(decodeThreadPlan(plan).steps[0]?.rationale).toBe(
      "The report does not say which projection.",
    );
  });

  it("refuses a plan that carries more steps than one plan may hold", () => {
    expect(() =>
      decodeThreadPlan({
        ...plan,
        steps: Array.from({ length: MAX_THREAD_PLAN_STEPS + 1 }, (_unused, index) => ({
          stepId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          position: index,
          title: `Step ${String(index)}`,
          status: "pending",
        })),
      }),
    ).toThrow();
  });

  it("will not accept a proposal that claims its own steps are already done", () => {
    const proposal = {
      kind: "propose-thread-plan",
      threadId: ids.thread,
      expectedVersion: 0,
      planId: ids.plan,
      revisionId: ids.revision,
      title: "Land the fix",
      steps: [{ stepId: ids.step, title: "Reproduce the replay gap" }],
    };

    expect(decodeThreadPlanCommand(proposal).kind).toBe("propose-thread-plan");
    expect(() =>
      decodeThreadPlanCommand({
        ...proposal,
        steps: [{ stepId: ids.step, title: "Reproduce", status: "done" }],
      }),
    ).toThrow();
  });

  it("requires an approval to name the revision it approves", () => {
    const approval = {
      kind: "approve-thread-plan",
      threadId: ids.thread,
      expectedVersion: 1,
      planId: ids.plan,
      revisionId: ids.revision,
    };

    expect(decodeThreadPlanCommand(approval).kind).toBe("approve-thread-plan");
    const { revisionId: _dropped, ...withoutRevision } = approval;
    expect(() => decodeThreadPlanCommand(withoutRevision)).toThrow();
  });

  it("refuses a proposal with no steps at all", () => {
    expect(() =>
      decodeThreadPlanCommand({
        kind: "propose-thread-plan",
        threadId: ids.thread,
        expectedVersion: 0,
        planId: ids.plan,
        revisionId: ids.revision,
        title: "Empty",
        steps: [],
      }),
    ).toThrow();
  });

  it("carries the plan and its revision history as one durable update", () => {
    const updated = decodeThreadPlanUpdated({
      plan,
      history: [
        {
          revisionId: ids.revision,
          title: plan.title,
          status: "proposed",
          stepCount: 1,
          recordedAt: "2026-08-18T09:00:00.000Z",
        },
      ],
    });

    expect(updated.history[0]?.stepCount).toBe(1);
  });
});
