import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { type AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { AgentRunHierarchy } from "./AgentRunHierarchy";

const parentThreadId = decodeAgentRunParentThreadId("11111111-1111-4111-8111-111111111111");
const runId = decodeAgentRunId("22222222-2222-4222-8222-222222222222");

const chatFacts = {
  status: "ready" as const,
  facts: {
    mode: "chat" as const,
    allowedRoles: ["research" as const],
    providerInstanceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" as never,
    modelId: "gpt-4o" as never,
    workspaceKind: "chat-virtual" as const,
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: true,
      executionPolicy: "plan" as const,
      permissionPersistence: "current-session" as const,
    },
    executionKind: "octant-managed" as const,
    attemptedExecutionKind: "provider-native" as const,
    nativeFallbackReason: "nativeChildAgents-claimed-unsupported",
    capabilityDegradations: ["native-child-agents-unavailable"],
    creationPosture: "automatic" as const,
  },
};

function emptyClient(overrides: Partial<AgentRunClient> = {}): AgentRunClient {
  return {
    center: vi.fn(async () => ({ items: [] })),
    parentSummary: vi.fn(async () => ({ parentThreadId, entries: [] })),
    acknowledge: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    preview: vi.fn(async () => chatFacts),
    prepareWorkspace: vi.fn(async () => ({
      status: "prepared" as const,
      workspace: {
        kind: "chat-virtual" as const,
        mode: "chat" as const,
        receiptId: "66666666-6666-4666-8666-666666666666" as never,
      },
    })),
    confirmWorkspace: vi.fn(async () => ({
      status: "confirmed" as const,
      workspace: {
        kind: "code-worktree" as const,
        mode: "code" as const,
        worktreeReceiptId: "66666666-6666-4666-8666-666666666666" as never,
        confirmation: "confirmed" as const,
      },
    })),
    requestRun: vi.fn(async () => ({ kind: "run-accepted" as const })),
    cancel: vi.fn(async () => ({ results: [] })),
    steer: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    retry: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    resume: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    ...overrides,
  };
}

describe("AgentRunHierarchy", () => {
  it("does not offer child creation unless the surface opts in", async () => {
    const requestRun = vi.fn(async (_input: unknown) => ({ kind: "run-accepted" as const }));
    render(
      <AgentRunHierarchy
        client={emptyClient({ requestRun: requestRun as never })}
        parentThreadId={parentThreadId}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Active / History" })).toBeVisible(),
    );
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("renders server-authored history and acknowledges a completed child", async () => {
    const user = userEvent.setup();
    const acknowledge = vi.fn(async () => ({
      kind: "run-updated" as const,
      run: {} as never,
    }));
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [
          {
            runId,
            requestId: "request-1",
            parentThreadId,
            role: "review",
            task: "Verify the packaged child",
            lifecycleStatus: "completed",
            executionKind: "provider-native",
            usageQuality: "provider-reported",
            resultAcknowledgement: {
              required: true,
              acknowledged: false,
              followUpReason: "unacknowledged-child-result",
            },
            version: 2,
            updatedAt: "2026-08-01T15:01:00.000Z",
          },
        ],
      })),
      acknowledge,
    });

    render(
      <AgentRunHierarchy client={client} parentThreadId={parentThreadId} creationPosture="ask" />,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Active / History" })).toBeVisible(),
    );
    await user.selectOptions(screen.getByLabelText("Agent hierarchy filter"), "history");
    expect(screen.getByText("Verify the packaged child")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /acknowledge result/i }));

    expect(acknowledge).toHaveBeenCalledWith({ runId, expectedVersion: 2 });
  });

  it("hides child creation and shows the Off explanation when posture is Off", async () => {
    const client = emptyClient();
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="off"
      />,
    );
    await waitFor(() => expect(screen.getByRole("heading")).toBeVisible());
    expect(screen.getAllByText(/posture is Off/i).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Task")).not.toBeInTheDocument();
  });

  it("submits a role and task and shows resolved facts instead of raw IDs", async () => {
    const user = userEvent.setup();
    const requestRun = vi.fn(async (_input: unknown) => ({ kind: "run-accepted" as const }));
    const parentSummary = vi.fn(async () => ({ parentThreadId, entries: [] }));
    const client = emptyClient({ requestRun: requestRun as never, parentSummary });
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="automatic"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Task")).toBeVisible());
    expect(screen.queryByLabelText("Provider instance ID")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Resolved child facts" })).toHaveTextContent(
      "Octant-managed",
    );
    await user.type(screen.getByLabelText("Task"), "Summarize the open PRs.");
    await user.click(screen.getByRole("button", { name: "Create subagent" }));

    await waitFor(() => expect(requestRun).toHaveBeenCalledTimes(1));
    const submitted = requestRun.mock.calls[0]?.[0];
    expect(submitted).toMatchObject({
      parentThreadId,
      task: "Summarize the open PRs.",
      role: "research",
    });
    expect(submitted).not.toHaveProperty("providerInstanceId");
    expect(submitted).not.toHaveProperty("requestedAuthority");
    await waitFor(() => expect(parentSummary).toHaveBeenCalledTimes(2));
  });

  it("surfaces a server denial reason next to the creation form without crashing the hierarchy", async () => {
    const user = userEvent.setup();
    const requestRun = vi.fn(async () => ({
      kind: "run-command-failed" as const,
      reason: "posture-rejected",
      message: "Subagent creation posture is Off.",
    }));
    const client = emptyClient({ requestRun });
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="automatic"
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Task")).toBeVisible());
    await user.type(screen.getByLabelText("Task"), "Summarize the open PRs.");
    await user.click(screen.getByRole("button", { name: "Create subagent" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Subagent creation posture is Off."),
    );
  });

  it("cancels an active child through the panel's Cancel action", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(async () => ({
      results: [{ kind: "run-updated" as const, run: { id: runId, lifecycleStatus: "cancelled" } }],
    }));
    const parentSummary = vi.fn(async () => ({
      parentThreadId,
      entries: [
        {
          runId,
          requestId: "request-1",
          parentThreadId,
          role: "research",
          task: "Draft the release notes",
          lifecycleStatus: "running",
          executionKind: "octant-managed",
          usageQuality: "provider-reported",
          resultAcknowledgement: { required: false, acknowledged: false },
          version: 1,
          updatedAt: "2026-08-01T15:01:00.000Z",
        },
      ],
    }));
    const client = emptyClient({ cancel, parentSummary });
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="automatic"
      />,
    );
    await waitFor(() => expect(screen.getByText("Draft the release notes")).toBeVisible());
    await user.click(screen.getByRole("button", { name: "Cancel Draft the release notes" }));

    expect(cancel).toHaveBeenCalledWith({ runId, scope: "subtree" });
    await waitFor(() => expect(parentSummary).toHaveBeenCalledTimes(2));
  });

  it("steers a running child with expected version", async () => {
    const user = userEvent.setup();
    const steer = vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never }));
    const client = emptyClient({
      steer,
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [
          {
            runId,
            requestId: "request-1",
            parentThreadId,
            role: "research",
            task: "Draft the release notes",
            lifecycleStatus: "running",
            executionKind: "octant-managed",
            usageQuality: "provider-reported",
            resultAcknowledgement: { required: false, acknowledged: false },
            version: 3,
            updatedAt: "2026-08-01T15:01:00.000Z",
          },
        ],
      })),
    });
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="automatic"
      />,
    );
    await waitFor(() => expect(screen.getByText("Draft the release notes")).toBeVisible());
    await user.click(screen.getByRole("button", { name: "Steer Draft the release notes" }));
    await user.type(screen.getByLabelText("Steering instruction"), "Stay on the failing test.");
    await user.click(screen.getByRole("button", { name: "Send steering" }));
    expect(steer).toHaveBeenCalledWith({
      runId,
      expectedVersion: 3,
      message: "Stay on the failing test.",
    });
  });

  it("fetches the server-authoritative posture from an injected settings client", async () => {
    const settingsClient: AgentRunSettingsClient = {
      current: vi.fn(async () => ({
        creationPosture: "automatic" as const,
        version: 3 as never,
        updatedAt: "2026-08-01T15:00:00.000Z" as never,
      })),
      update: vi.fn() as never,
    };
    const client = emptyClient();
    render(
      <AgentRunHierarchy
        allowCreation
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="off"
        settingsClient={settingsClient}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText("Task")).toBeVisible());
    expect(settingsClient.current).toHaveBeenCalled();
  });
});
