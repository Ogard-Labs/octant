import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ThreadGoal } from "@octant/contracts";
import { GoalClientFailure, type GoalClient } from "@octant/client-runtime/goal-client";
import { ThreadGoalPanel } from "./ThreadGoalPanel";

const threadId = "00000000-0000-4000-8000-000000000208";

function goalWith(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return {
    id: "00000000-0000-4000-8000-000000000206",
    threadId,
    revisionId: "00000000-0000-4000-8000-000000000207",
    objective: "Ship the Goal surface",
    status: "active",
    budget: {},
    usage: { tokensUsed: 0, elapsedMs: 0, turnsUsed: 0 },
    evidence: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  } as unknown as ThreadGoal;
}

describe("ThreadGoalPanel", () => {
  it("mounts the Goal card for the thread and states host retention honestly", async () => {
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({
        goal: goalWith(),
        history: [
          {
            revisionId: "00000000-0000-4000-8000-000000000207",
            objective: "Ship the Goal surface",
            status: "active",
            recordedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
      execute: vi.fn(),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);

    expect(await screen.findByTestId("goal-objective")).toHaveTextContent("Ship the Goal surface");
    expect(screen.getByTestId("goal-status")).toHaveTextContent("active");
    expect(screen.getByText("1 recorded revision.")).toBeVisible();
    expect(
      screen.getByText("The host records this Goal in its journal, so it survives a restart."),
    ).toBeVisible();
  });

  it("offers the next Goal once the current one is complete, keeping its card", async () => {
    const user = userEvent.setup();
    const completed = goalWith({ status: "complete", version: 4 } as Partial<ThreadGoal>);
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: completed, history: [] }),
      execute: vi
        .fn()
        .mockResolvedValue({ goal: goalWith({ objective: "Ship the next thing" }), history: [] }),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);

    // The finished Goal stays on screen as the thread's record of it.
    expect(await screen.findByTestId("goal-status")).toHaveTextContent("complete");
    await user.type(
      await screen.findByRole("textbox", { name: "Goal objective" }),
      "Ship the next thing",
    );
    await user.click(screen.getByRole("button", { name: "Set Goal" }));

    await waitFor(() => expect(client.execute).toHaveBeenCalledOnce());
    expect(vi.mocked(client.execute).mock.calls[0]?.[0]).toMatchObject({
      kind: "create-thread-goal",
      threadId,
      objective: "Ship the next thing",
      // The host refuses a create that does not name the version it read.
      expectedVersion: 4,
    });
  });

  it("offers no create form while a Goal is still open", async () => {
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
      execute: vi.fn(),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);

    expect(await screen.findByTestId("goal-status")).toHaveTextContent("active");
    expect(screen.queryByRole("button", { name: "Set Goal" })).toBeNull();
  });

  it("creates a Goal through the host when the thread has none", async () => {
    const user = userEvent.setup();
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: null, history: [] }),
      execute: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);

    expect(await screen.findByText("No Goal is set for this thread.")).toBeVisible();
    await user.type(screen.getByLabelText("Goal objective"), "Ship the Goal surface");
    await user.click(screen.getByRole("button", { name: "Set Goal" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create-thread-goal", objective: "Ship the Goal surface" }),
    );
    expect(await screen.findByTestId("goal-objective")).toHaveTextContent("Ship the Goal surface");
  });

  it("revises the objective only after the host accepts the revision", async () => {
    const user = userEvent.setup();
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
      execute: vi.fn().mockResolvedValue({
        goal: goalWith({ objective: "Ship it twice", version: 2 as ThreadGoal["version"] }),
        history: [],
      }),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);
    await screen.findByTestId("goal-objective");
    await user.click(screen.getByRole("button", { name: "Revise" }));
    const field = screen.getByLabelText("Revised objective");
    await user.clear(field);
    await user.type(field, "Ship it twice");
    await user.click(screen.getByRole("button", { name: "Save revision" }));

    expect(client.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "revise-thread-goal", objective: "Ship it twice" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("goal-objective")).toHaveTextContent("Ship it twice"),
    );
  });

  it("announces a refused command in words alongside its icon", async () => {
    const user = userEvent.setup();
    const client: GoalClient = {
      read: vi.fn().mockResolvedValue({ goal: goalWith(), history: [] }),
      execute: vi
        .fn()
        .mockRejectedValue(new GoalClientFailure("Goal is already complete.", 409, "conflict")),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);
    await screen.findByTestId("goal-objective");
    await user.click(screen.getByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Goal is already complete.");
  });

  it("names an unauthorized window in words and offers a retry instead of a card", async () => {
    const client: GoalClient = {
      read: vi.fn().mockRejectedValue(new GoalClientFailure("Goal request is unauthorized.", 401)),
      execute: vi.fn(),
    };

    render(<ThreadGoalPanel client={client} threadId={threadId} />);

    expect(
      await screen.findByText("This window is not authorized to read the Goal."),
    ).toBeVisible();
    expect(screen.queryByTestId("goal-objective")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("says Goals are unavailable when the window has no Goal client", () => {
    render(<ThreadGoalPanel threadId={threadId} />);

    expect(screen.getByText("Goals are unavailable in this window.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
