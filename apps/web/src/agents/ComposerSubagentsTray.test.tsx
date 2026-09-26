import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentsTray, ThreadSubagentsTray } from "./ComposerSubagentsTray";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";

const threadId = "11111111-1111-4111-8111-111111111111";

function entry(
  runId: string,
  lifecycleStatus: string,
  review: { readonly required?: boolean; readonly acknowledged?: boolean } = {},
): AgentHierarchyInputEntry {
  return {
    runId,
    role: "research",
    task: `Task ${runId}`,
    lifecycleStatus,
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: {
      required: review.required ?? false,
      acknowledged: review.acknowledged ?? false,
    },
    version: 7,
    updatedAt: "2026-09-26T10:00:00.000Z",
  };
}

function renderTray(
  entries: ReadonlyArray<AgentHierarchyInputEntry>,
  overrides: Partial<Parameters<typeof SubagentsTray>[0]> = {},
) {
  const handlers = {
    onOpenSubagent: vi.fn(),
    onStop: vi.fn(),
    onStopAll: vi.fn(),
    onMarkReviewed: vi.fn(),
  };
  render(<SubagentsTray entries={entries} {...handlers} {...overrides} />);
  return handlers;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SubagentsTray", () => {
  it("shows working subagents and unreviewed results, in words, and leaves reviewed ones to Agents", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-26T10:00:12.000Z"), shouldAdvanceTime: true });
    renderTray([
      entry("a", "running"),
      entry("b", "completed", { required: true }),
      entry("c", "failed", { required: true }),
      entry("d", "completed", { required: true, acknowledged: true }),
    ]);

    const tray = screen.getByRole("group", { name: "Subagents" });
    const rows = within(tray).getAllByRole("button", { name: /Opens it in Agents/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "Task aWorking · 12s",
      "Task bDone — review",
      "Task cFailed",
    ]);
    expect(within(tray).queryByText("Task d")).not.toBeInTheDocument();
  });

  it("renders nothing once every subagent has settled and been reviewed", () => {
    renderTray([entry("a", "completed", { required: true, acknowledged: true })]);

    expect(screen.queryByRole("group", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("asks to open the chosen subagent, and the Agents list for the rows past three", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray([
      entry("a", "running"),
      entry("b", "running"),
      entry("c", "waiting"),
      entry("d", "queued"),
      entry("e", "completed", { required: true }),
    ]);

    await user.click(screen.getByRole("button", { name: /^Task b\. Working/ }));
    expect(onOpenSubagent).toHaveBeenLastCalledWith("b");

    await user.click(screen.getByRole("button", { name: "Show 2 more subagents in Agents" }));
    expect(onOpenSubagent).toHaveBeenLastCalledWith();
  });

  it("stops one named subagent at once and marks a finished one reviewed at its version", async () => {
    const user = userEvent.setup();
    const { onStop, onMarkReviewed } = renderTray([
      entry("a", "running"),
      entry("b", "completed", { required: true }),
    ]);

    await user.click(screen.getByRole("button", { name: "Stop subagent: Task a" }));
    expect(onStop).toHaveBeenCalledWith("a");

    await user.click(screen.getByRole("button", { name: "Mark reviewed: Task b" }));
    expect(onMarkReviewed).toHaveBeenCalledWith({ runId: "b", version: 7 });
  });

  it("asks before stopping every working subagent, and stops nothing when declined", async () => {
    const user = userEvent.setup();
    const { onStopAll } = renderTray([entry("a", "running"), entry("b", "waiting")]);

    await user.click(screen.getByRole("button", { name: "Stop all" }));
    const confirm = screen.getByRole("group", { name: "Confirm stopping subagents" });
    expect(confirm).toHaveTextContent("Stop all 2 working subagents on this thread?");
    expect(confirm).toHaveTextContent("Only this thread's subagents are affected.");
    expect(onStopAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep running" }));
    expect(onStopAll).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Stop all" }));
    await user.click(screen.getByRole("button", { name: "Stop 2 subagents" }));
    expect(onStopAll).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed stop as an alert instead of implying success", () => {
    renderTray([entry("a", "running")], {
      errorMessage: "Subagents could not be stopped. They are still running.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Subagents could not be stopped. They are still running.",
    );
  });
});

describe("ThreadSubagentsTray", () => {
  it("drops a finished subagent from the tray once it is marked reviewed", async () => {
    const user = userEvent.setup();
    let acknowledged = false;
    const acknowledge = vi.fn(async () => {
      acknowledged = true;
      return { kind: "run-updated" as const, run: {} as never };
    });
    const client = {
      parentSummary: vi.fn(async () => ({
        parentThreadId: threadId,
        entries: [
          {
            ...entry("90000000-0000-4000-8000-000000000001", "completed", {
              required: true,
              acknowledged,
            }),
            requestId: "request-1",
            parentThreadId: threadId,
          },
        ],
      })),
      acknowledge,
      cancel: vi.fn(async () => ({ results: [] })),
    } as never;
    render(<ThreadSubagentsTray client={client} threadId={threadId} />);

    await user.click(
      await screen.findByRole("button", {
        name: "Mark reviewed: Task 90000000-0000-4000-8000-000000000001",
      }),
    );

    expect(acknowledge).toHaveBeenCalledWith({
      runId: "90000000-0000-4000-8000-000000000001",
      expectedVersion: 7,
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Subagents" })).not.toBeInTheDocument(),
    );
  });
});
