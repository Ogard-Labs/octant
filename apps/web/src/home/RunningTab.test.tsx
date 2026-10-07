import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { RunningTab } from "./RunningTab";
import type { StopRowOutcome } from "./stopRunningRow";
import type { WorkingNowCardSource } from "./WorkingNowCard";

const NOW = Date.parse("2026-10-06T10:00:00.000Z");

function thread(index: number, overrides: Partial<ChatThreadNavigationItem> = {}) {
  return {
    mode: "code" as const,
    thread: {
      threadId: `thread-${String(index)}`,
      title: `Task ${String(index)}`,
      activity: "working" as const,
      updatedAt: new Date(NOW - index * 60_000).toISOString(),
      ...overrides,
    },
  };
}

function source(overrides: Partial<WorkingNowCardSource> = {}): WorkingNowCardSource {
  return {
    agentRunClient: undefined,
    runRevision: 0,
    now: NOW,
    onOpenRow: vi.fn(),
    onOpenRunning: vi.fn(),
    threads: [],
    modes: ["code"],
    projectNames: new Map(),
    providers: new Map(),
    boardFacts: new Map(),
    ...overrides,
  };
}

const stopped: StopRowOutcome = { kind: "stopped" };

describe("the Running tab", () => {
  it("says nothing is running in one quiet line", () => {
    render(
      <RunningTab
        onStop={vi.fn()}
        source={source({ threads: [thread(1, { activity: "idle" })] })}
      />,
    );
    expect(screen.getByText("Nothing is running right now.")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lists every running thread, past the five the card shows, newest first", () => {
    const threads = [1, 2, 3, 4, 5, 6, 7].map((index) => thread(index));
    render(<RunningTab onStop={vi.fn()} source={source({ threads })} />);
    const rows = within(screen.getByRole("list", { name: "Running now" })).getAllByRole("listitem");
    expect(rows).toHaveLength(7);
    expect(within(rows[0]!).getByText("Task 1")).toBeVisible();
    expect(within(rows[6]!).getByText("Task 7")).toBeVisible();
  });

  it("shows the live step and how long a turn has run, as the Working now card does", () => {
    render(
      <RunningTab
        onStop={vi.fn()}
        source={source({
          threads: [
            thread(1, {
              turnStartedAt: new Date(NOW - 7 * 60_000).toISOString(),
              liveStep: { kind: "tool", tool: "Command", argument: "bun run test" },
            }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Command: bun run test")).toHaveClass("oct-meta--mono");
    expect(screen.getByText("Running 7m")).toBeVisible();
  });

  it("opens the thread of the row whose Open was pressed", async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    render(
      <RunningTab
        onStop={vi.fn()}
        source={source({ onOpenRow, threads: [thread(1), thread(2)] })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open Task 2" }));
    expect(onOpenRow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId: "thread-2", mode: "code" }),
    );
  });

  it("asks before stopping and stops nothing when the person keeps it running", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn(async () => stopped);
    render(<RunningTab onStop={onStop} source={source({ threads: [thread(1)] })} />);

    await user.click(screen.getByRole("button", { name: "Stop Task 1" }));
    const question = screen.getByRole("group", { name: "Confirm stopping Task 1" });
    expect(within(question).getByText("Stop this turn?")).toBeVisible();
    expect(onStop).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(within(question).getByRole("button", { name: "Keep running" })).toHaveFocus(),
    );

    await user.click(within(question).getByRole("button", { name: "Keep running" }));
    expect(onStop).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop Task 1" })).toHaveFocus());
  });

  it("stops the confirmed row through the stop command and reports it", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn(async () => stopped);
    render(<RunningTab onStop={onStop} source={source({ threads: [thread(1), thread(2)] })} />);

    await user.click(screen.getByRole("button", { name: "Stop Task 2" }));
    await user.click(screen.getByRole("button", { name: "Stop Task 2 now" }));

    expect(onStop).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ threadId: "thread-2", mode: "code" }),
    );
    expect(await screen.findByText("Stopped.")).toBeVisible();
  });

  it("says why a stop was refused and offers Stop again", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn(
      async (): Promise<StopRowOutcome> => ({
        kind: "refused",
        message: "The host is unreachable.",
      }),
    );
    render(<RunningTab onStop={onStop} source={source({ threads: [thread(1)] })} />);

    await user.click(screen.getByRole("button", { name: "Stop Task 1" }));
    await user.click(screen.getByRole("button", { name: "Stop Task 1 now" }));

    expect(await screen.findByText("The host is unreachable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop Task 1" })).toBeEnabled();
  });
});
