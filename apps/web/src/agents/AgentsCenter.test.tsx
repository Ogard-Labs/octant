import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeAgentRunCanvasSnapshotResult, decodeAgentRunCenterSummary } from "@octant/contracts";
import { AgentsCenter } from "./AgentsCenter";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";

const summary = decodeAgentRunCenterSummary({
  runId: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  parentThreadId: "33333333-3333-4333-8333-333333333333",
  parentThreadTitle: "Design chat",
  mode: "chat",
  role: "research",
  task: "Summarize the design",
  lifecycleStatus: "running",
  executionKind: "octant-managed",
  authority: {
    filesystem: false,
    shell: false,
    git: false,
    network: true,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  workspaceKind: "chat-virtual",
  usageQuality: "provider-reported",
  route: {
    requestedProviderInstanceId: "44444444-4444-4444-8444-444444444444",
    requestedModelId: "gpt-4o",
    executionProviderInstanceId: "44444444-4444-4444-8444-444444444444",
    executionModelId: "gpt-4o",
    poolDerived: false,
  },
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 2,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:01:00.000Z",
});

function createClient(overrides: Partial<AgentRunClient> = {}): AgentRunClient {
  return {
    center: vi.fn(async () => ({ items: [summary] })),
    conversation: vi.fn(),
    parentSummary: vi.fn(),
    snapshotCanvas: vi.fn(),
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    steer: vi.fn(),
    retry: vi.fn(),
    resume: vi.fn(),
    usageResume: vi.fn(),
    ...overrides,
  };
}

describe("AgentsCenter", () => {
  it("follows up a completed managed child with its existing identity and version", async () => {
    const user = userEvent.setup();
    const item = { ...summary, lifecycleStatus: "completed" as const };
    const resume = vi.fn<AgentRunClient["resume"]>().mockResolvedValue({ kind: "run-updated" });
    render(
      <AgentsCenter
        client={createClient({ center: vi.fn(async () => ({ items: [item] })), resume })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: summary.task }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    await user.type(
      screen.getByRole("textbox", { name: "Follow-up message" }),
      "  Check recovery too.  ",
    );
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(resume).toHaveBeenCalledExactlyOnceWith({
      runId: summary.runId,
      expectedVersion: 2,
      message: "Check recovery too.",
    });
  });

  it.each([
    { lifecycleStatus: "cancelled", executionKind: "octant-managed" },
    { lifecycleStatus: "completed", executionKind: "provider-native" },
  ])("does not offer a follow-up for $lifecycleStatus $executionKind children", async (state) => {
    const user = userEvent.setup();
    const item = decodeAgentRunCenterSummary({ ...summary, ...state });
    render(
      <AgentsCenter client={createClient({ center: vi.fn(async () => ({ items: [item] })) })} />,
    );
    await user.click(await screen.findByRole("button", { name: summary.task }));
    expect(screen.queryByRole("button", { name: "Follow up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Follow-up message" })).not.toBeInTheDocument();
  });

  it("prevents duplicate follow-ups and keeps the draft when the host refuses", async () => {
    const user = userEvent.setup();
    let finish: ((result: Awaited<ReturnType<AgentRunClient["resume"]>>) => void) | undefined;
    const resume = vi.fn<AgentRunClient["resume"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const item = { ...summary, lifecycleStatus: "completed" as const };
    render(
      <AgentsCenter
        client={createClient({ center: vi.fn(async () => ({ items: [item] })), resume })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: summary.task }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    await user.type(
      screen.getByRole("textbox", { name: "Follow-up message" }),
      "  Keep my draft.  ",
    );
    await user.dblClick(screen.getByRole("button", { name: "Send follow-up" }));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    await act(async () =>
      finish?.({ kind: "run-command-failed", message: "Saved session is unavailable." }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved session is unavailable.");
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toHaveValue(
      "  Keep my draft.  ",
    );
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
  });

  it("keeps a new child's draft separate from the previous child's pending request", async () => {
    const user = userEvent.setup();
    let finish: ((result: Awaited<ReturnType<AgentRunClient["resume"]>>) => void) | undefined;
    const resume = vi.fn<AgentRunClient["resume"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = { ...summary, lifecycleStatus: "completed" as const };
    const second = decodeAgentRunCenterSummary({
      ...first,
      runId: "55555555-5555-4555-8555-555555555555",
      task: "Second child",
    });
    render(
      <AgentsCenter
        client={createClient({ center: vi.fn(async () => ({ items: [first, second] })), resume })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: summary.task }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    await user.type(screen.getByRole("textbox", { name: "Follow-up message" }), "First draft");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    await user.click(screen.getByRole("button", { name: "Second child" }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toHaveValue("");
    await user.type(screen.getByRole("textbox", { name: "Follow-up message" }), "Second draft");
    await act(async () =>
      finish?.({ kind: "run-command-failed", message: "First child refused." }),
    );
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toHaveValue("Second draft");
    expect(screen.queryByText("First child refused.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
  });

  it.each(["waiting", "interrupted"])(
    "resumes a %s child without a follow-up message",
    async (lifecycleStatus) => {
      const user = userEvent.setup();
      const resume = vi.fn<AgentRunClient["resume"]>().mockResolvedValue({ kind: "run-updated" });
      const item = decodeAgentRunCenterSummary({ ...summary, lifecycleStatus });
      render(
        <AgentsCenter
          client={createClient({ center: vi.fn(async () => ({ items: [item] })), resume })}
        />,
      );
      await user.click(await screen.findByRole("button", { name: summary.task }));
      expect(screen.queryByRole("button", { name: "Follow up" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Resume" }));
      expect(resume).toHaveBeenCalledExactlyOnceWith({ runId: summary.runId, expectedVersion: 2 });
    },
  );

  it("offers resume after a recoverable provider process death", async () => {
    const item = {
      ...summary,
      lifecycleStatus: "interrupted" as const,
      recoveryReason: "provider-process-death" as const,
    };
    render(
      <AgentsCenter client={createClient({ center: vi.fn(async () => ({ items: [item] })) })} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: summary.task }));
    expect(screen.getByRole("button", { name: /^Resume$/ })).toBeVisible();
  });

  it("does not offer steering on a completed run", async () => {
    const item = { ...summary, lifecycleStatus: "completed" as const };
    render(
      <AgentsCenter client={createClient({ center: vi.fn(async () => ({ items: [item] })) })} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /^History$/ }));
    await userEvent.click(await screen.findByRole("button", { name: summary.task }));
    expect(screen.queryByRole("button", { name: /^Steer$/ })).not.toBeInTheDocument();
  });

  it("offers retry instead of resume when restart lost resumable execution", async () => {
    const item = {
      ...summary,
      lifecycleStatus: "interrupted" as const,
      recoveryReason: "restart-without-resumable-execution" as const,
    };
    render(
      <AgentsCenter client={createClient({ center: vi.fn(async () => ({ items: [item] })) })} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: summary.task }));
    expect(screen.queryByRole("button", { name: /^Resume$/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Retry$/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Steer$/ })).not.toBeInTheDocument();
    expect(screen.getByText("Stopped by a host restart. Retry to run it again.")).toBeVisible();
  });

  it("shows a loading state while the center query is in flight", () => {
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(() => new Promise(() => {})) as AgentRunClient["center"],
        })}
      />,
    );
    expect(screen.getByText("Loading agent runs.")).toBeInTheDocument();
  });

  it("shows an empty state when no runs match the filters", async () => {
    render(<AgentsCenter client={createClient({ center: vi.fn(async () => ({ items: [] })) })} />);
    const title = await screen.findByText("No agent runs yet");
    expect(title.closest("[role='status']")).toHaveClass("surface-empty");
    expect(screen.getByText("Child agents appear here after a thread starts one.")).toBeVisible();
  });

  it("opens a parent thread without creating another hierarchy", async () => {
    const onOpenThread = vi.fn();
    render(
      <AgentsCenter client={createClient()} onOpenThread={onOpenThread} projectNames={new Map()} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Open thread" }));
    expect(onOpenThread).toHaveBeenCalledWith({
      mode: "chat",
      threadId: String(summary.parentThreadId),
      title: summary.parentThreadTitle,
    });
  });

  it("uses accessible toggle groups for status and mode filters", async () => {
    const user = userEvent.setup();
    render(<AgentsCenter client={createClient()} />);
    expect(await screen.findByText(summary.task)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "History" }));
    expect(await screen.findByText("No agent runs match these filters")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeVisible();
  });

  it("keeps the rows on screen while a changed filter is in flight", async () => {
    const user = userEvent.setup();
    let settleSecond: ((value: { readonly items: readonly [] }) => void) | undefined;
    const center = vi
      .fn()
      .mockResolvedValueOnce({ items: [summary] })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleSecond = resolve as never;
          }),
      );
    render(<AgentsCenter client={createClient({ center })} />);
    expect(await screen.findByText(summary.task)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "History" }));

    // The previous answer stays until the new one arrives; marking the list
    // busy is the feedback, not a full-pane loading screen.
    expect(screen.getByText(summary.task)).toBeInTheDocument();
    expect(screen.queryByText("Loading agent runs.")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Agent runs" })).toHaveAttribute("aria-busy", "true");

    settleSecond?.({ items: [] });
    expect(await screen.findByText("No agent runs match these filters")).toBeInTheDocument();
  });

  it("confirms stopping a live run and does nothing when the answer is keep running", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => ({ results: [] }));
    render(<AgentsCenter client={createClient({ cancel })} />);
    await user.click(await screen.findByRole("button", { name: "Summarize the design" }));

    await user.click(await screen.findByRole("button", { name: "Stop child agents" }));
    expect(screen.getByText(/Stop this run and any child agents/)).toBeVisible();
    expect(cancel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Keep running" }));
    expect(screen.queryByText(/Stop this run and any child agents/)).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("does not carry a stop confirmation onto the run selected next", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => ({ results: [] }));
    const finished = decodeAgentRunCenterSummary({
      ...summary,
      runId: "55555555-5555-4555-8555-555555555555",
      task: "Audit the copy",
      lifecycleStatus: "completed",
      version: 3,
    });
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(async () => ({ items: [summary, finished] })),
          cancel,
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Summarize the design" }));
    await user.click(await screen.findByRole("button", { name: "Stop child agents" }));
    expect(screen.getByText(/Stop this run and any child agents/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Audit the copy" }));

    expect(screen.queryByText(/Stop this run and any child agents/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop child agents" })).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("offers a finished run only the actions its lifecycle allows", async () => {
    const user = userEvent.setup();
    const finished = decodeAgentRunCenterSummary({
      ...summary,
      lifecycleStatus: "completed",
      version: 3,
    });
    render(
      <AgentsCenter
        client={createClient({ center: vi.fn(async () => ({ items: [finished] })) })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Summarize the design" }));

    expect(screen.queryByRole("button", { name: "Stop child agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resume" })).not.toBeInTheDocument();
  });

  it("shows unavailable copy when the center query fails", async () => {
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(async () => {
            throw new Error("Agents Center is unavailable right now.");
          }),
        })}
      />,
    );
    expect(await screen.findByText("Agents are unavailable")).toBeInTheDocument();
  });

  it("offers Graph next to List and shows the parent thread above the run", async () => {
    const user = userEvent.setup();
    render(<AgentsCenter client={createClient()} />);
    expect(await screen.findByRole("list", { name: "Agent runs" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Graph" }));

    expect(screen.queryByRole("list", { name: "Agent runs" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Agent run graph" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Design chat thread" })).toBeVisible();
    expect(screen.getByRole("button", { name: summary.task })).toBeVisible();
  });

  it("selecting a graph card opens the same detail pane as the list", async () => {
    const user = userEvent.setup();
    render(<AgentsCenter client={createClient()} />);
    await user.click(await screen.findByRole("button", { name: "Graph" }));
    await user.click(screen.getByRole("button", { name: summary.task }));
    expect(screen.getByRole("region", { name: "Agent run details" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Agent run details" })).toHaveTextContent(
      "Design chat",
    );
  });

  it("saves the graph as a Canvas for the only parent thread", async () => {
    const user = userEvent.setup();
    const snapshotCanvas = vi.fn(async () =>
      decodeAgentRunCanvasSnapshotResult({
        kind: "accepted",
        canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "Design chat agent graph",
        originThreadId: summary.parentThreadId,
        mode: "chat",
        projectId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    const onOpenCanvas = vi.fn();
    render(<AgentsCenter client={createClient({ snapshotCanvas })} onOpenCanvas={onOpenCanvas} />);
    await user.click(await screen.findByRole("button", { name: "Graph" }));
    await user.click(screen.getByRole("button", { name: "Save as Canvas" }));
    expect(snapshotCanvas).toHaveBeenCalledWith(summary.parentThreadId);
    expect(await screen.findByText("Saved the graph as a Canvas.")).toBeVisible();
    expect(onOpenCanvas).toHaveBeenCalledWith({
      mode: "chat",
      title: "Design chat agent graph",
      canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      projectId: "77777777-7777-4777-8777-777777777777",
    });
  });

  it("asks the user to select a run when the graph has more than one parent thread", async () => {
    const user = userEvent.setup();
    const other = decodeAgentRunCenterSummary({
      ...summary,
      runId: "21111111-1111-4111-8111-111111111111",
      parentThreadId: "55555555-5555-4555-8555-555555555555",
      parentThreadTitle: "Implement auth",
      task: "Code work",
    });
    const snapshotCanvas = vi.fn();
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(async () => ({ items: [summary, other] })),
          snapshotCanvas,
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Graph" }));
    await user.click(screen.getByRole("button", { name: "Save as Canvas" }));
    expect(snapshotCanvas).not.toHaveBeenCalled();
    expect(await screen.findByText("Select a run first.")).toBeVisible();
  });

  it("saves the selected run parent thread when the graph has several trees", async () => {
    const user = userEvent.setup();
    const other = decodeAgentRunCenterSummary({
      ...summary,
      runId: "21111111-1111-4111-8111-111111111111",
      parentThreadId: "55555555-5555-4555-8555-555555555555",
      parentThreadTitle: "Implement auth",
      task: "Code work",
    });
    const snapshotCanvas = vi.fn(async () =>
      decodeAgentRunCanvasSnapshotResult({
        kind: "accepted",
        canvasId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        versionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        title: "Implement auth agent graph",
        originThreadId: other.parentThreadId,
        mode: "chat",
        projectId: "77777777-7777-4777-8777-777777777777",
      }),
    );
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(async () => ({ items: [summary, other] })),
          snapshotCanvas,
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Graph" }));
    await user.click(screen.getByRole("button", { name: "Code work" }));
    await user.click(screen.getByRole("button", { name: "Save as Canvas" }));
    expect(snapshotCanvas).toHaveBeenCalledWith(other.parentThreadId);
  });

  it("keeps List only when Agents Center is narrow", async () => {
    render(<AgentsCenter client={createClient()} narrow />);
    expect(await screen.findByRole("list", { name: "Agent runs" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Graph" })).not.toBeInTheDocument();
  });
  it("graphs a grandchild under the run that launched it", async () => {
    const user = userEvent.setup();
    const child = decodeAgentRunCenterSummary({
      ...summary,
      runId: "21111111-1111-4111-8111-111111111111",
      parentRunId: String(summary.runId),
      task: "Review findings",
      role: "review",
      createdAt: "2026-08-01T10:02:00.000Z",
    });
    const grandchild = decodeAgentRunCenterSummary({
      ...summary,
      runId: "31111111-1111-4111-8111-111111111111",
      parentRunId: String(child.runId),
      task: "Tighten the review",
      createdAt: "2026-08-01T10:03:00.000Z",
    });
    render(
      <AgentsCenter
        client={createClient({
          center: vi.fn(async () => ({ items: [summary, child, grandchild] })),
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Graph" }));
    expect(screen.getByRole("button", { name: "Design chat thread" })).toBeVisible();
    expect(screen.getByRole("button", { name: summary.task })).toBeVisible();
    expect(screen.getByRole("button", { name: "Review findings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tighten the review" })).toBeVisible();
  });

  it("keeps the graph thread card inert when there is no thread to open", async () => {
    const user = userEvent.setup();
    render(<AgentsCenter client={createClient()} />);

    await user.click(await screen.findByRole("button", { name: "Graph" }));

    expect(screen.getByRole("button", { name: "Design chat thread" })).toBeDisabled();
  });

  it("opens the parent thread from the graph thread card", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(<AgentsCenter client={createClient()} onOpenThread={onOpenThread} />);

    await user.click(await screen.findByRole("button", { name: "Graph" }));
    await user.click(screen.getByRole("button", { name: "Design chat thread" }));

    expect(onOpenThread).toHaveBeenCalledWith({
      mode: "chat",
      threadId: String(summary.parentThreadId),
      title: summary.parentThreadTitle,
    });
  });
});
