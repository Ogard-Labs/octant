import type { ThreadPlan } from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanCard } from "./PlanCard";
import { ThreadPlanPanel, parseSteps } from "./ThreadPlanPanel";
import type { PlanController } from "./usePlanController";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  plan: "20000000-0000-4000-8000-000000000001",
  revision: "30000000-0000-4000-8000-000000000001",
  stepOne: "40000000-0000-4000-8000-000000000001",
  stepTwo: "40000000-0000-4000-8000-000000000002",
} as const;

function plan(overrides: Partial<ThreadPlan> = {}): ThreadPlan {
  return {
    id: ids.plan,
    threadId: ids.thread,
    revisionId: ids.revision,
    title: "Land the replay fix",
    status: "proposed",
    steps: [
      {
        stepId: ids.stepOne,
        position: 0,
        title: "Reproduce the gap",
        rationale: "The report is vague.",
        status: "pending",
      },
      { stepId: ids.stepTwo, position: 1, title: "Fix the projection", status: "pending" },
    ],
    proposedAt: "2026-08-18T09:00:00.000Z",
    updatedAt: "2026-08-18T09:00:00.000Z",
    version: 1,
    ...overrides,
  } as ThreadPlan;
}

function controller(overrides: Partial<PlanController> = {}): PlanController {
  return {
    plan: plan(),
    history: [],
    status: "ready",
    commandMessage: undefined,
    pending: false,
    reload: vi.fn(),
    propose: vi.fn(async () => true),
    revise: vi.fn(async () => true),
    approve: vi.fn(async () => true),
    withdraw: vi.fn(async () => true),
    setStepStatus: vi.fn(async () => true),
    ...overrides,
  } as PlanController;
}

describe("the plan panel", () => {
  it("shows the steps and their reasons, and says the plan is not approved yet", () => {
    render(<ThreadPlanPanel controller={controller()} />);

    expect(screen.getByText("Reproduce the gap")).toBeInTheDocument();
    expect(screen.getByText("The report is vague.")).toBeInTheDocument();
    expect(screen.getByText("Proposed · not approved")).toBeInTheDocument();
  });

  it("approves the plan through its own gesture", () => {
    const approve = vi.fn(async () => true);
    render(<ThreadPlanPanel controller={controller({ approve })} />);

    fireEvent.click(screen.getByRole("button", { name: "Approve plan" }));

    expect(approve).toHaveBeenCalled();
  });

  it("offers no way to start work on a plan nobody has approved", () => {
    render(<ThreadPlanPanel controller={controller()} />);

    expect(
      screen.queryByRole("button", { name: "Start Reproduce the gap" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve plan" })).toBeInTheDocument();
  });

  it("turns the approved steps into work that can be started and finished", () => {
    const setStepStatus = vi.fn(async () => true);
    render(
      <ThreadPlanPanel
        controller={controller({
          plan: plan({ status: "approved", approvedRevisionId: ids.revision as never }),
          setStepStatus,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Reproduce the gap" }));

    expect(setStepStatus).toHaveBeenCalledWith(ids.stepOne, "in-progress");
    expect(screen.queryByRole("button", { name: "Approve plan" })).not.toBeInTheDocument();
  });

  it("proposes a plan from one step per line", async () => {
    const propose = vi.fn(async () => true);
    render(<ThreadPlanPanel controller={controller({ plan: null, propose })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Plan title" }), {
      target: { value: "Land the replay fix" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Plan steps" }), {
      target: { value: "1. Reproduce the gap — the report is vague\n2. Fix the projection\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Propose plan" }));

    await waitFor(() =>
      expect(propose).toHaveBeenCalledWith("Land the replay fix", [
        { title: "Reproduce the gap", rationale: "the report is vague" },
        { title: "Fix the projection" },
      ]),
    );
  });

  it("offers no controls at all to a window that may only read the plan", () => {
    render(<ThreadPlanPanel controller={controller()} readOnly />);

    expect(screen.queryByRole("button", { name: "Approve plan" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Plan title" })).not.toBeInTheDocument();
    expect(screen.getByText("Land the replay fix")).toBeInTheDocument();
  });

  it("says why a refused command did not happen", () => {
    render(
      <ThreadPlanPanel
        controller={controller({ commandMessage: "That revision is no longer the plan." })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("That revision is no longer the plan.");
  });
});

describe("the plan card", () => {
  it("reads a dropped step as dropped in words, not only by styling", () => {
    render(
      <PlanCard
        plan={plan({
          status: "approved",
          steps: [
            {
              stepId: ids.stepOne as never,
              position: 0,
              title: "Reproduce the gap",
              status: "dropped",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Dropped")).toBeInTheDocument();
  });

  it("counts progress against the steps still in the plan", () => {
    render(
      <PlanCard
        plan={plan({
          status: "approved",
          steps: [
            { stepId: ids.stepOne as never, position: 0, title: "One", status: "done" },
            { stepId: ids.stepTwo as never, position: 1, title: "Two", status: "dropped" },
          ],
        })}
      />,
    );

    expect(screen.getByText("1 of 1 done")).toBeInTheDocument();
  });
});

describe("reading typed steps", () => {
  it("takes list markers off and keeps the reason after the dash", () => {
    expect(parseSteps("- First — because\n* Second\n3) Third\n\n")).toEqual([
      { title: "First", rationale: "because" },
      { title: "Second" },
      { title: "Third" },
    ]);
  });
});
