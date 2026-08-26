import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { ThreadPlan } from "@octant/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InlineThreadPlan } from "./InlineThreadPlan";
import { ThreadPlanProvider } from "./ThreadPlanContext";

const ids = {
  thread: "10000000-0000-4000-8000-000000000001",
  plan: "20000000-0000-4000-8000-000000000001",
  revision: "30000000-0000-4000-8000-000000000001",
  first: "40000000-0000-4000-8000-000000000001",
  second: "40000000-0000-4000-8000-000000000002",
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
    ],
    proposedAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    version: 5,
    ...overrides,
  } as ThreadPlan;
}

function planClient(value: ThreadPlan | null = plan()): PlanClient {
  return {
    read: vi.fn(async () => ({ plan: value, history: [] })),
    execute: vi.fn(),
  };
}

describe("InlineThreadPlan", () => {
  it("forwards host-observed changed-file evidence onto the compact viewer", async () => {
    const user = userEvent.setup();
    render(
      <ThreadPlanProvider client={planClient()} threadId={ids.thread}>
        <InlineThreadPlan
          changedFiles={{
            kind: "observed",
            changedPathCount: 4,
            freshness: "stale",
            insertions: 173,
            deletions: 0,
          }}
        />
      </ThreadPlanProvider>,
    );

    const trigger = await screen.findByRole("button", { name: /^Show task progress/ });
    expect(trigger).toHaveTextContent("4 files changed +173 −0 · stale");
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Task progress" })).toHaveTextContent(
      "4 files changed +173 −0 · stale",
    );
  });

  it("omits a changed-file count when the caller supplied none", async () => {
    render(
      <ThreadPlanProvider client={planClient()} threadId={ids.thread}>
        <InlineThreadPlan />
      </ThreadPlanProvider>,
    );

    const trigger = await screen.findByRole("button", { name: /^Show task progress/ });
    expect(trigger).toHaveTextContent("Step 2 / 2");
    expect(trigger).not.toHaveTextContent("file");
    expect(trigger).not.toHaveTextContent("changed");
  });
});
