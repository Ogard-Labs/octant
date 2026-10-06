import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { AgentRunCenterSummary } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { HomeDashboard } from "./HomeDashboard";
import { createWorkingNowCard, type WorkingNowCardSource } from "./WorkingNowCard";

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

function renderCard(card: ReturnType<typeof createWorkingNowCard>) {
  return render(
    <HomeDashboard
      cards={[card]}
      customization={{ order: [], visibility: [] }}
      onCustomizationChange={vi.fn()}
    />,
  );
}

function client(items: ReadonlyArray<unknown>): AgentRunClient {
  return {
    center: vi.fn(async () => ({ items })),
  } as unknown as AgentRunClient;
}

describe("the Working now card", () => {
  it("says nothing is running in one quiet line when no thread is", async () => {
    renderCard(createWorkingNowCard(source({ threads: [thread(1, { activity: "idle" })] })));
    const card = await screen.findByRole("region", { name: "Working now" });
    expect(within(card).getByText("Nothing is running right now.")).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("lists a running thread with its provider, current step, and when it last moved", async () => {
    renderCard(
      createWorkingNowCard(
        source({
          threads: [
            thread(4, {
              providerInstanceId: "p1",
              projectId: "project-1",
            }),
          ],
          providers: new Map([["p1", { displayName: "Codex", driverKind: "codex" }]]),
          projectNames: new Map([["project-1", "octant"]]),
          boardFacts: new Map([["thread-4", { step: "Running the web tests" }]]),
        }),
      ),
    );
    const card = await screen.findByRole("region", { name: "Working now" });
    const row = within(card).getByRole("button", { name: /Task 4/ });
    expect(within(row).getByText("Running the web tests")).toBeInTheDocument();
    expect(within(row).getByText("Active 4m ago")).toBeInTheDocument();
    expect(within(card).getByText("1")).toBeInTheDocument();
    expect(row.querySelector(".working-now__step")).toHaveClass("oct-meta--mono");
  });

  it("shows the running command in monospace and how long the turn has really run", async () => {
    renderCard(
      createWorkingNowCard(
        source({
          threads: [
            thread(1, {
              turnStartedAt: new Date(NOW - 7 * 60_000).toISOString(),
              liveStep: { kind: "tool", tool: "Command", argument: "bun run test" },
            }),
          ],
        }),
      ),
    );
    const row = await screen.findByRole("button", { name: /Task 1/ });
    expect(within(row).getByText("Command: bun run test")).toHaveClass("oct-meta--mono");
    expect(within(row).getByText("Running 7m")).toBeInTheDocument();
    expect(within(row).queryByText(/Active/)).toBeNull();
  });

  it("says a turn that is waiting on the person in plain words, not code", async () => {
    renderCard(
      createWorkingNowCard(
        source({
          threads: [
            thread(1, {
              turnStartedAt: new Date(NOW - 60_000).toISOString(),
              liveStep: { kind: "waiting", reason: "approval" },
            }),
          ],
        }),
      ),
    );
    const row = await screen.findByRole("button", { name: /Task 1/ });
    expect(within(row).getByText("Waiting for approval")).not.toHaveClass("oct-meta--mono");
  });

  it("falls back to the Project name when the host reports no step, and names a remote host", async () => {
    renderCard(
      createWorkingNowCard(
        source({
          threads: [thread(1, { projectId: "project-1" })],
          projectNames: new Map([["project-1", "octant"]]),
          host: "Studio Mac",
        }),
      ),
    );
    const row = await screen.findByRole("button", { name: /Task 1/ });
    expect(within(row).getByText("octant")).toBeInTheDocument();
    expect(within(row).getByText("Studio Mac")).toBeInTheDocument();
  });

  it("opens the thread that was clicked", async () => {
    const user = userEvent.setup();
    const onOpenRow = vi.fn();
    renderCard(createWorkingNowCard(source({ onOpenRow, threads: [thread(1), thread(2)] })));
    await user.click(await screen.findByRole("button", { name: /Task 2/ }));
    expect(onOpenRow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mode: "code", threadId: "thread-2" }),
    );
  });

  it("shows at most five rows, counts them all, and opens Running from +N more", async () => {
    const user = userEvent.setup();
    const onOpenRunning = vi.fn();
    renderCard(
      createWorkingNowCard(
        source({
          onOpenRunning,
          threads: [1, 2, 3, 4, 5, 6, 7].map((index) => thread(index)),
        }),
      ),
    );
    const card = await screen.findByRole("region", { name: "Working now" });
    expect(within(card).getAllByRole("listitem")).toHaveLength(5);
    expect(within(card).getByText("7")).toBeInTheDocument();
    expect(within(card).getByText("Task 1")).toBeInTheDocument();
    expect(within(card).queryByText("Task 6")).toBeNull();

    await user.click(within(card).getByRole("button", { name: "+2 more" }));
    expect(onOpenRunning).toHaveBeenCalledTimes(1);
  });

  it("offers no more-link when everything fits", async () => {
    renderCard(createWorkingNowCard(source({ threads: [1, 2, 3, 4, 5].map((i) => thread(i)) })));
    await screen.findByRole("region", { name: "Working now" });
    expect(screen.queryByRole("button", { name: /more/ })).toBeNull();
  });

  it("adds agent runs from the AgentRun projection and says how long a run has run", async () => {
    const reader = client([
      {
        runId: "run-1",
        parentThreadId: "resting",
        parentThreadTitle: "Resting thread",
        mode: "code",
        role: "reviewer",
        task: "Review the diff",
        lifecycleStatus: "running",
        route: { executionProviderInstanceId: "p1" },
        createdAt: new Date(NOW - 12 * 60_000).toISOString(),
        updatedAt: new Date(NOW - 60_000).toISOString(),
      },
    ] as unknown as ReadonlyArray<AgentRunCenterSummary>);
    renderCard(
      createWorkingNowCard(
        source({
          agentRunClient: reader,
          threads: [thread(1)],
        }),
      ),
    );
    const row = await screen.findByRole("button", { name: /Resting thread/ });
    expect(within(row).getByText("reviewer: Review the diff")).toBeInTheDocument();
    expect(within(row).getByText("Running 12m")).toBeInTheDocument();
    expect(reader.center).toHaveBeenCalledWith({ status: "active", mode: "all", limit: 50 });
  });

  it("keeps listing threads when the agent run read is refused", async () => {
    const reader = {
      center: vi.fn(async () => {
        throw new Error("refused");
      }),
    } as unknown as AgentRunClient;
    renderCard(createWorkingNowCard(source({ agentRunClient: reader, threads: [thread(1)] })));
    expect(await screen.findByRole("button", { name: /Task 1/ })).toBeInTheDocument();
    await waitFor(() => expect(reader.center).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Task 1/ })).toBeInTheDocument();
  });

  it("reads the agent runs again when the thread lists change, and not on its own", async () => {
    const reader = client([]);
    const card = (revision: number) =>
      createWorkingNowCard(source({ agentRunClient: reader, runRevision: revision }));
    const { rerender } = render(
      <HomeDashboard
        cards={[card(0)]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(reader.center).toHaveBeenCalledTimes(1));
    rerender(
      <HomeDashboard
        cards={[card(0)]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    expect(reader.center).toHaveBeenCalledTimes(1);
    rerender(
      <HomeDashboard
        cards={[card(1)]}
        customization={{ order: [], visibility: [] }}
        onCustomizationChange={vi.fn()}
      />,
    );
    await waitFor(() => expect(reader.center).toHaveBeenCalledTimes(2));
  });
});
