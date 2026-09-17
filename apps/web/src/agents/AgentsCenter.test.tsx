import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeAgentRunCenterSummary } from "@octant/contracts";
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
    acknowledge: vi.fn(),
    prepareWorkspace: vi.fn(),
    confirmWorkspace: vi.fn(),
    preview: vi.fn(),
    requestRun: vi.fn(),
    cancel: vi.fn(),
    steer: vi.fn(),
    retry: vi.fn(),
    resume: vi.fn(),
    ...overrides,
  };
}

describe("AgentsCenter", () => {
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
});
