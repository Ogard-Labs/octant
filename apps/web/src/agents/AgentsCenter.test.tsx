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
    expect(await screen.findByText("No agent runs match the current filters.")).toBeInTheDocument();
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
    expect(await screen.findByText("Agents Center is unavailable")).toBeInTheDocument();
  });
});
