import type { ThreadPlan } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadTaskViewer } from "./ThreadTaskViewer";
import type { PlanController } from "./usePlanController";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  plan: "20000000-0000-4000-8000-000000000001",
  revision: "30000000-0000-4000-8000-000000000001",
  first: "40000000-0000-4000-8000-000000000001",
  second: "40000000-0000-4000-8000-000000000002",
  third: "40000000-0000-4000-8000-000000000003",
  fourth: "40000000-0000-4000-8000-000000000004",
} as const;

function plan(overrides: Partial<ThreadPlan> = {}): ThreadPlan {
  return {
    id: ids.plan,
    threadId: ids.thread,
    revisionId: ids.revision,
    title: "Ship the context controls",
    status: "approved",
    approvedRevisionId: ids.revision,
    steps: [
      { stepId: ids.first, position: 0, title: "Map the context", status: "done" },
      { stepId: ids.second, position: 1, title: "Build the viewer", status: "in-progress" },
      { stepId: ids.third, position: 2, title: "Verify the result", status: "pending" },
      { stepId: ids.fourth, position: 3, title: "Discarded idea", status: "dropped" },
    ],
    proposedAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    version: 5,
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

describe("ThreadTaskViewer", () => {
  it("opens compact task progress and manages an approved step", async () => {
    const user = userEvent.setup();
    const setStepStatus = vi.fn(async () => true);
    render(<ThreadTaskViewer controller={controller({ setStepStatus })} />);

    const trigger = screen.getByRole("button", { name: /^Show task progress/ });
    expect(trigger).toHaveTextContent("Step 2 / 3");
    await user.click(trigger);

    const popover = screen.getByRole("dialog", { name: "Task progress" });
    expect(popover).toHaveTextContent("Ship the context controls");
    expect(popover).toHaveTextContent("1 of 3 done");
    expect(popover).toHaveTextContent("Map the context");
    expect(popover).toHaveTextContent("Build the viewer");
    expect(popover).toHaveTextContent("Verify the result");
    expect(popover).toHaveTextContent("Discarded idea");

    await user.click(screen.getByRole("button", { name: "Finish Build the viewer" }));
    expect(setStepStatus).toHaveBeenCalledWith(ids.second, "done");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Task progress" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("shows only server-provided changed-file evidence", async () => {
    const user = userEvent.setup();
    render(
      <ThreadTaskViewer
        changedFiles={{ kind: "observed", changedPathCount: 3, freshness: "stale" }}
        controller={controller()}
      />,
    );

    expect(screen.getByRole("button", { name: /^Show task progress/ })).toHaveTextContent(
      "3 files changed · stale",
    );
    await user.click(screen.getByRole("button", { name: /^Show task progress/ }));
    expect(screen.getByRole("dialog", { name: "Task progress" })).toHaveTextContent(
      "3 files changed · stale",
    );
  });

  it("lets the reader approve a proposed task plan", async () => {
    const user = userEvent.setup();
    const approve = vi.fn(async () => true);
    render(
      <ThreadTaskViewer
        controller={controller({
          approve,
          plan: plan({ status: "proposed", approvedRevisionId: undefined }),
        })}
      />,
    );

    expect(screen.getByRole("button", { name: /^Show task progress/ })).toHaveTextContent(
      "Review 3-step plan",
    );
    await user.click(screen.getByRole("button", { name: /^Show task progress/ }));
    await user.click(screen.getByRole("button", { name: "Approve plan" }));
    expect(approve).toHaveBeenCalledOnce();
  });

  it("renders nothing without an active plan", () => {
    const { container } = render(<ThreadTaskViewer controller={controller({ plan: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
