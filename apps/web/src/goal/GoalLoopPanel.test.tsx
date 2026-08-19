import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import type { ThreadGoal } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GoalLoopPanel } from "./GoalLoopPanel";

const threadId = "00000000-0000-4000-8000-000000000401";

const goal = {
  id: "00000000-0000-4000-8000-000000000402",
  threadId,
  revisionId: "00000000-0000-4000-8000-000000000403",
  objective: "Get the migration passing",
  status: "active",
  budget: { tokenBudget: 1_000 },
  usage: { tokensUsed: 900, elapsedMs: 0, turnsUsed: 2 },
  evidence: [],
  createdAt: "2026-08-19T09:00:00.000Z",
  updatedAt: "2026-08-19T09:00:00.000Z",
  version: 3,
} as unknown as ThreadGoal;

const runningLoop = {
  id: "00000000-0000-4000-8000-000000000404",
  threadId,
  goalId: goal.id,
  ceiling: {
    filesystem: true,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
  },
  trigger: { kind: "continuous" },
  status: "running",
  roundsRun: 4,
  startedAt: "2026-08-19T09:00:00.000Z",
  updatedAt: "2026-08-19T09:20:00.000Z",
  version: 5,
};

function client(overrides: Partial<GoalLoopClient> = {}): GoalLoopClient {
  return {
    read: vi.fn(async () => ({ loop: runningLoop, rounds: [] })),
    execute: vi.fn(async () => ({ kind: "goal-loop", loop: runningLoop, rounds: [] })),
    ...overrides,
  } as unknown as GoalLoopClient;
}

describe("watching a loop work on its own", () => {
  it("shows how much of the budget is gone against the ceiling that will stop it", async () => {
    render(<GoalLoopPanel client={client()} goal={goal} threadId={threadId} />);

    expect(await screen.findByText("90% of tokens spent")).toBeVisible();
    expect(screen.getByText("4 rounds")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
  });

  it("stops a running loop with the version the host last reported", async () => {
    const loopClient = client();
    render(<GoalLoopPanel client={loopClient} goal={goal} threadId={threadId} />);
    await screen.findByText("Running");

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(loopClient.execute).toHaveBeenCalledWith({
      kind: "stop-goal-loop",
      threadId,
      expectedVersion: 5,
    });
  });

  it("says why a loop stopped in the host's own words", async () => {
    render(
      <GoalLoopPanel
        client={client({
          read: vi.fn(async () => ({
            loop: {
              ...runningLoop,
              status: "awaiting-approval",
              pauseReason: "approval-required",
            },
            rounds: [],
          })) as unknown as GoalLoopClient["read"],
        })}
        goal={goal}
        threadId={threadId}
      />,
    );

    expect(await screen.findByText(/needs an approval/i)).toBeVisible();
    expect(screen.getByText("Waiting for an approval")).toBeVisible();
  });

  it("shows a refusal rather than pretending the command took", async () => {
    const loopClient = client({
      execute: vi.fn(async () => ({
        kind: "goal-loop-refused",
        reason: "would-widen",
        message: "A running loop's ceiling can only narrow.",
      })) as unknown as GoalLoopClient["execute"],
    });
    render(<GoalLoopPanel client={loopClient} goal={goal} threadId={threadId} />);
    await screen.findByText("Running");

    await userEvent.click(screen.getByRole("button", { name: "Withhold tools" }));

    await waitFor(() =>
      expect(screen.getByText("A running loop's ceiling can only narrow.")).toBeVisible(),
    );
    // The loop still reads as running: nothing renders as changed before the
    // host accepted it.
    expect(screen.getByText("Running")).toBeVisible();
  });

  it("offers to start one, and says what will stop it, when there is no loop yet", async () => {
    render(
      <GoalLoopPanel
        client={client({
          read: vi.fn(async () => ({
            loop: null,
            rounds: [],
          })) as unknown as GoalLoopClient["read"],
        })}
        goal={goal}
        threadId={threadId}
      />,
    );

    expect(await screen.findByRole("button", { name: "Start loop" })).toBeVisible();
    expect(screen.getByText(/checkpointed first/i)).toBeVisible();
    expect(screen.getByText(/stops at the budget/i)).toBeVisible();
  });

  it("renders nothing at all on a host that serves no loops", () => {
    const { container } = render(<GoalLoopPanel goal={goal} threadId={threadId} />);

    expect(container.firstChild).toBeNull();
  });
});
