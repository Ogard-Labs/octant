import { cleanup, render, screen, within } from "@testing-library/react";
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
  };
  render(
    <SubagentsTray entries={entries} storage={memoryStorage()} {...handlers} {...overrides} />,
  );
  return handlers;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SubagentsTray", () => {
  it("shows only working subagents, in words, and leaves finished ones to Environment and Agents", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-26T10:00:12.000Z"), shouldAdvanceTime: true });
    renderTray([
      entry("a", "running"),
      entry("b", "waiting"),
      entry("c", "completed", { required: true }),
      entry("d", "failed", { required: true }),
      entry("e", "completed", { required: true, acknowledged: true }),
    ]);

    const tray = screen.getByRole("group", { name: "Subagents" });
    const rows = within(tray).getAllByRole("button", { name: /Opens it in Agents/ });
    expect(rows.map((row) => row.textContent)).toEqual([
      "Task aWorking · 12s",
      "Task bWaiting · 12s",
    ]);
    expect(tray).toHaveTextContent("2 working");
    expect(within(tray).queryByText("Task c")).not.toBeInTheDocument();
  });

  it("renders nothing when no subagent is working", () => {
    renderTray([
      entry("a", "completed", { required: true }),
      entry("b", "completed", { required: true, acknowledged: true }),
    ]);

    expect(screen.queryByRole("group", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("asks to open the chosen subagent", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray([entry("a", "running"), entry("b", "running")]);

    await user.click(screen.getByRole("button", { name: /^Task b\. Working/ }));
    expect(onOpenSubagent).toHaveBeenLastCalledWith("b");
  });

  it("folds to its head and stays folded for this viewer", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage();
    renderTray([entry("a", "running")], { storage });

    await user.click(screen.getByRole("button", { name: "Subagents, 1 working. Hide them" }));
    expect(screen.queryByRole("button", { name: /Opens it in Agents/ })).not.toBeInTheDocument();
    expect(storage.setItem).toHaveBeenCalledWith("octant.composer-subagents.open", "false");

    cleanup();
    renderTray([entry("a", "running")], { storage });
    const toggle = screen.getByRole("button", { name: "Subagents, 1 working. Show them" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: /^Task a\. Working/ })).toBeVisible();
  });

  it("stops one named subagent at once", async () => {
    const user = userEvent.setup();
    const { onStop } = renderTray([entry("a", "running")]);

    await user.click(screen.getByRole("button", { name: "Stop subagent: Task a" }));
    expect(onStop).toHaveBeenCalledWith("a");
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
  it("makes a child's pending approval reachable from the parent composer and clears it when leaving that thread", async () => {
    const runId = "90000000-0000-4000-8000-000000000001";
    const client = {
      parentSummary: vi.fn(async () => ({
        parentThreadId: threadId,
        entries: [{ ...entry(runId, "running"), requestId: "r1", parentThreadId: threadId }],
      })),
      acknowledge: vi.fn(),
      cancel: vi.fn(),
    } as never;
    const interactionsClient = {
      session: vi.fn(async () => ({
        approvals: [{ status: "pending", source: { runId } }],
        questions: [],
      })),
    } as never;
    const onOpenSubagent = vi.fn();
    const rendered = render(
      <ThreadSubagentsTray
        client={client}
        interactionsClient={interactionsClient}
        threadId={threadId}
        onOpenSubagent={onOpenSubagent}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Review request" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(runId);
    rendered.rerender(
      <ThreadSubagentsTray
        client={client}
        interactionsClient={interactionsClient}
        threadId="22222222-2222-4222-8222-222222222222"
        onOpenSubagent={onOpenSubagent}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
  });

  it("shows the host's working subagents and none of its finished ones", async () => {
    const client = {
      parentSummary: vi.fn(async () => ({
        parentThreadId: threadId,
        entries: [
          {
            ...entry("90000000-0000-4000-8000-000000000001", "running"),
            requestId: "r1",
            parentThreadId: threadId,
          },
          {
            ...entry("90000000-0000-4000-8000-000000000002", "completed", { required: true }),
            requestId: "r2",
            parentThreadId: threadId,
          },
        ],
      })),
      acknowledge: vi.fn(),
      cancel: vi.fn(async () => ({ results: [] })),
    } as never;
    render(<ThreadSubagentsTray client={client} threadId={threadId} />);

    expect(
      await screen.findByRole("button", {
        name: /^Task 90000000-0000-4000-8000-000000000001\. Working/,
      }),
    ).toBeVisible();
    expect(screen.queryByText("Task 90000000-0000-4000-8000-000000000002")).not.toBeInTheDocument();
  });
});
