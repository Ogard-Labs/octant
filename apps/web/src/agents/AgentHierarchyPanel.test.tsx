import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHierarchyPanel, type SubagentWorker } from "./AgentHierarchyPanel";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";

const entries: ReadonlyArray<AgentHierarchyInputEntry> = [
  {
    runId: "run-live",
    role: "research",
    task: "Active research",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    route: {
      requestedProviderInstanceId: "provider-a",
      requestedModelId: "gpt-6-astra",
      executionProviderInstanceId: "provider-a",
      executionModelId: "gpt-6-astra",
      poolDerived: false,
    },
    version: 2,
    updatedAt: "2026-08-01T15:01:00.000Z",
  },
  {
    runId: "run-older",
    role: "review",
    task: "Older review",
    lifecycleStatus: "completed",
    executionKind: "octant-managed",
    usageQuality: "estimated",
    resultAcknowledgement: { required: true, acknowledged: true },
    version: 3,
    updatedAt: "2026-08-01T15:00:00.000Z",
  },
  {
    runId: "run-newer",
    role: "review",
    task: "Newer review",
    lifecycleStatus: "completed",
    executionKind: "provider-native",
    usageQuality: "estimated",
    resultAcknowledgement: { required: true, acknowledged: false },
    version: 4,
    updatedAt: "2026-08-01T15:02:00.000Z",
  },
];

describe("AgentHierarchyPanel", () => {
  it("lists working subagents apart from finished ones, newest finished first", () => {
    render(<AgentHierarchyPanel entries={entries} creationPosture="automatic" />);

    const working = screen.getByRole("region", { name: "Working" });
    expect(within(working).getByRole("button", { name: /Active research/ })).toHaveTextContent(
      "Working · Research · gpt-6-astra",
    );
    const finished = screen.getByRole("region", { name: "Finished" });
    const rows = within(finished).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Newer review"),
      expect.stringContaining("Older review"),
    ]);
    // Only the result nobody has looked at yet asks for review, in words.
    expect(rows[0]).toHaveTextContent("Needs review");
    expect(rows[1]).not.toHaveTextContent("Needs review");
  });

  it("does not ask to review a result the host already handed to the thread's agent", () => {
    const unreviewed = entries[2];
    if (unreviewed === undefined) throw new Error("fixture lost its unreviewed row");
    render(
      <AgentHierarchyPanel
        entries={[
          {
            ...unreviewed,
            runId: "run-delivered",
            task: "Delivered review",
            resultDeliveryOutcome: "delivered",
          },
          {
            ...unreviewed,
            runId: "run-consumed",
            task: "Consumed review",
            resultDeliveryOutcome: "consumed",
          },
          {
            ...unreviewed,
            runId: "run-failed",
            task: "Undelivered review",
            resultDeliveryOutcome: "failed",
          },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: /Delivered review/ })).not.toHaveTextContent(
      "Needs review",
    );
    expect(screen.getByRole("button", { name: /Consumed review/ })).not.toHaveTextContent(
      "Needs review",
    );
    expect(screen.getByRole("button", { name: /Undelivered review/ })).toHaveTextContent(
      "Needs review",
    );
  });

  it("opens the subagent whose row is chosen", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<AgentHierarchyPanel entries={entries} onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: /Newer review/ }));

    expect(onOpen).toHaveBeenCalledWith("run-newer");
  });

  it("offers the graph only when the caller keeps the choice and the thread has subagents", () => {
    const { rerender } = render(<AgentHierarchyPanel entries={entries} />);
    expect(screen.queryByRole("group", { name: "View" })).not.toBeInTheDocument();

    rerender(<AgentHierarchyPanel entries={[]} onViewChange={vi.fn()} view="graph" />);
    expect(screen.queryByRole("group", { name: "View" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No subagents yet.");

    rerender(<AgentHierarchyPanel entries={entries} onViewChange={vi.fn()} view="list" />);
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Subagent graph" })).not.toBeInTheDocument();
  });

  it("asks for the graph when Graph is chosen", async () => {
    const user = userEvent.setup();
    const onViewChange = vi.fn();
    render(<AgentHierarchyPanel entries={entries} onViewChange={onViewChange} view="list" />);

    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(onViewChange).toHaveBeenCalledWith("graph");
  });

  it("draws the thread's subagents as cards that say what each waits for, and opens one", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const live = entries[0];
    if (live === undefined) throw new Error("fixture lost its working row");
    render(
      <AgentHierarchyPanel
        entries={[
          { ...live, runId: "tokens", task: "Color tokens", lifecycleStatus: "completed" },
          { ...live, runId: "toggle", task: "Theme toggle" },
          {
            ...live,
            runId: "verify",
            task: "Verify and open PR",
            lifecycleStatus: "waiting",
            recoveryReason: "waiting-on-dependencies",
            dependsOn: ["tokens", "toggle"],
            normalizedReasoning: "high",
          },
        ]}
        onOpen={onOpen}
        onViewChange={vi.fn()}
        providers={new Map([["provider-a", { driverKind: "codex", displayName: "Codex" }]])}
        view="graph"
      />,
    );

    const graph = screen.getByRole("group", { name: "Subagent graph" });
    // The graph replaces the two list sections; it does not sit beside them.
    expect(screen.queryByRole("region", { name: "Working" })).not.toBeInTheDocument();
    expect(within(graph).getAllByRole("button")).toHaveLength(3);
    const verify = within(graph).getByRole("button", { name: /Verify and open PR/ });
    expect(verify).toHaveTextContent("gpt-6-astra");
    expect(verify).toHaveTextContent("high · Research");
    expect(verify).toHaveTextContent("Waiting on 1");
    expect(verify).toHaveTextContent("Runs after Color tokens, Theme toggle.");
    expect(verify.querySelector('[data-driver-kind="codex"]')).not.toBeNull();
    // One arrow per wait.
    expect(graph.querySelectorAll('path[data-kind="after"]')).toHaveLength(2);

    await user.click(verify);

    expect(onOpen).toHaveBeenCalledWith("verify");
  });

  describe("on a coordinator", () => {
    const run = (
      runId: string,
      task: string,
      more: Partial<SubagentWorker["runs"][number]> = {},
    ) => ({
      runId,
      role: "implementation",
      task,
      lifecycleStatus: "running",
      needsReview: false,
      model: "gpt-6-astra",
      providerInstanceId: "provider-a",
      runsAfter: [],
      updatedAt: "2026-08-01T15:01:00.000Z",
      ...more,
    });
    const workers: ReadonlyArray<SubagentWorker> = [
      {
        threadId: "worker-a",
        title: "Add dark mode",
        provider: { driverKind: "codex", displayName: "Codex" },
        state: "working",
        runs: [
          run("a-1", "Color tokens", { lifecycleStatus: "completed" }),
          run("a-2", "Page styles", { runsAfter: [{ runId: "a-1", task: "Color tokens" }] }),
        ],
        runsTruncated: false,
      },
      {
        threadId: "worker-b",
        title: "Audit dependencies",
        state: "attention",
        runs: [],
        runsTruncated: false,
      },
    ];

    it("lists its workers with each one's state and how much it handed off, and opens one", async () => {
      const user = userEvent.setup();
      const onOpenWorker = vi.fn();
      render(<AgentHierarchyPanel entries={[]} onOpenWorker={onOpenWorker} workers={workers} />);

      const section = screen.getByRole("region", { name: "Workers" });
      expect(within(section).getByRole("heading", { name: "Workers · 2" })).toBeVisible();
      expect(within(section).getByRole("button", { name: /Add dark mode/ })).toHaveTextContent(
        "Working · 2 subagents · 1 working",
      );
      expect(within(section).getByRole("button", { name: /Audit dependencies/ })).toHaveTextContent(
        "Needs attention",
      );
      // It delegated nothing itself, but it is not empty: its workers are listed.
      expect(screen.queryByText(/No subagents yet/)).not.toBeInTheDocument();
      // The list names the workers; their subagents are drawn only in Graph.
      expect(screen.queryByRole("group", { name: /Subagents of/ })).not.toBeInTheDocument();

      await user.click(within(section).getByRole("button", { name: /Audit dependencies/ }));

      expect(onOpenWorker).toHaveBeenCalledWith("worker-b");
    });

    it("offers the graph for its workers' subagents even when it delegated nothing itself", () => {
      render(
        <AgentHierarchyPanel entries={[]} onViewChange={vi.fn()} view="list" workers={workers} />,
      );

      expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
    });

    it("draws each worker's subagents under it, and a card opens the worker, not a run", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const onOpenWorker = vi.fn();
      render(
        <AgentHierarchyPanel
          entries={[]}
          onOpen={onOpen}
          onOpenWorker={onOpenWorker}
          onViewChange={vi.fn()}
          view="graph"
          workers={workers}
        />,
      );

      const graph = screen.getByRole("group", { name: "Subagents of Add dark mode" });
      expect(within(graph).getAllByRole("button")).toHaveLength(2);
      expect(graph.querySelectorAll('path[data-kind="after"]')).toHaveLength(1);
      // A worker that handed off nothing has a row and no graph.
      expect(
        screen.queryByRole("group", { name: "Subagents of Audit dependencies" }),
      ).not.toBeInTheDocument();

      await user.click(within(graph).getByRole("button", { name: /Page styles/ }));

      expect(onOpenWorker).toHaveBeenCalledWith("worker-a");
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("says so when the host would not answer for the workers' subagents", () => {
      render(
        <AgentHierarchyPanel
          entries={[]}
          workers={workers.map((worker) => ({ ...worker, runs: [] }))}
          workersNotice="This window cannot read the workers' subagents."
        />,
      );

      expect(
        within(screen.getByRole("region", { name: "Workers" })).getByText(
          "This window cannot read the workers' subagents.",
        ),
      ).toBeVisible();
    });
  });

  it("says where subagents come from on a thread with none", () => {
    render(<AgentHierarchyPanel entries={[]} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "No subagents yet. They appear here when the agent hands off part of its work.",
    );
  });
});
