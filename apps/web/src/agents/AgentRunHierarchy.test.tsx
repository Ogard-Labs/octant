import { render, screen, waitFor, within } from "@testing-library/react";
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
    conversation: vi.fn(async () => ({
      runId: "00000000-0000-4000-8000-000000000001" as never,
      parentThreadId,
      executionKind: "octant-managed" as const,
      modelId: "test-model" as never,
      lifecycleStatus: "running" as const,
      status: "live" as const,
      entries: [],
      truncated: false,
    })),
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
    snapshotCanvas: vi.fn(),
    ...overrides,
  };
}

function summaryEntry(overrides: {
  readonly lifecycleStatus: string;
  readonly task: string;
  readonly result?: {
    readonly reference: string;
    readonly text?: string;
    readonly truncated: boolean;
  };
}) {
  return {
    runId,
    requestId: "request-1",
    parentThreadId,
    role: "research",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: true, acknowledged: false },
    version: 3,
    updatedAt: "2026-08-01T15:01:00.000Z",
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible());
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(requestRun).not.toHaveBeenCalled();
  });

  it("opens a finished subagent and marks it reviewed at the version the host reported", async () => {
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible());
    await user.click(screen.getByRole("button", { name: /Verify the packaged child/ }));
    await user.click(screen.getByRole("button", { name: "Mark reviewed" }));

    expect(acknowledge).toHaveBeenCalledWith({ runId, expectedVersion: 2 });
  });

  it("shows a child that finishes while the panel is open without the person clicking anything", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const child = (lifecycleStatus: "starting" | "completed") => ({
        parentThreadId,
        entries: [
          {
            runId,
            requestId: "request-1",
            parentThreadId,
            role: "review",
            task: "Say hello",
            lifecycleStatus,
            executionKind: "octant-managed",
            usageQuality: "provider-reported",
            resultAcknowledgement: { required: false, acknowledged: false },
            version: lifecycleStatus === "starting" ? 2 : 4,
            updatedAt: "2026-08-01T15:01:00.000Z",
          },
        ],
      });
      const parentSummary = vi
        .fn()
        .mockResolvedValueOnce(child("starting"))
        .mockResolvedValue(child("completed"));
      render(
        <AgentRunHierarchy
          client={emptyClient({ parentSummary: parentSummary as never })}
          parentThreadId={parentThreadId}
          creationPosture="ask"
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Working · 1" })).toBeVisible(),
      );

      await vi.advanceTimersByTimeAsync(2_000);

      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Finished · 1" })).toBeVisible(),
      );
      expect(screen.queryByRole("heading", { name: /Working/ })).not.toBeInTheDocument();
      // Settled children stop the panel from asking again.
      const calls = parentSummary.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(parentSummary).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
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
    expect(screen.getAllByText(/turned off in Settings/i).length).toBeGreaterThan(0);
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

  it("cancels a working subagent from its page", async () => {
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
    await user.click(await screen.findByRole("button", { name: /Draft the release notes/ }));
    await user.click(screen.getByRole("button", { name: "Cancel this subagent" }));

    expect(cancel).toHaveBeenCalledWith({ runId, scope: "subtree" });
    await waitFor(() => expect(parentSummary).toHaveBeenCalledTimes(2));
  });

  it("steers a running subagent from its page at the version the host reported", async () => {
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
    await user.click(await screen.findByRole("button", { name: /Draft the release notes/ }));
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

  it("goes from the list to a subagent's page and back", async () => {
    const user = userEvent.setup();
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "running", task: "Trace the flaky test" })],
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);

    await user.click(await screen.findByRole("button", { name: /Trace the flaky test/ }));
    const page = screen.getByRole("region", { name: "Subagent" });
    expect(within(page).getByRole("heading", { name: "Trace the flaky test" })).toBeVisible();
    expect(client.conversation).toHaveBeenCalledWith(runId);

    await user.click(screen.getByRole("button", { name: "Back to subagents" }));
    expect(screen.queryByRole("region", { name: "Subagent" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Working · 1" })).toBeVisible();
  });

  it("answers with the retained reply when the live conversation is gone after completion", async () => {
    const user = userEvent.setup();
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [
          summaryEntry({
            lifecycleStatus: "completed",
            task: "Summarize the release",
            result: {
              reference: "result-1",
              text: "The release **ships** Friday.",
              truncated: true,
            },
          }),
        ],
      })),
      conversation: vi.fn(async () => ({
        runId,
        parentThreadId,
        executionKind: "octant-managed" as const,
        modelId: "test-model" as never,
        lifecycleStatus: "completed" as const,
        status: "unavailable" as const,
        entries: [],
        truncated: false,
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);

    await user.click(await screen.findByRole("button", { name: /Summarize the release/ }));

    const conversation = screen.getByRole("log", { name: "Subagent conversation" });
    await waitFor(() => expect(within(conversation).getByText("ships")).toBeVisible());
    expect(within(conversation).getByText("ships").tagName).toBe("STRONG");
    expect(conversation).toHaveTextContent("The reply was truncated.");
  });

  it("reads a streamed reply as one message, not one paragraph per piece", async () => {
    const user = userEvent.setup();
    const occurredAt = "2026-09-26T19:00:35.000Z" as never;
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "completed", task: "Say hello" })],
      })),
      conversation: vi.fn(async () => ({
        runId,
        parentThreadId,
        executionKind: "octant-managed" as const,
        modelId: "test-model" as never,
        lifecycleStatus: "completed" as const,
        status: "complete" as const,
        entries: ["Hello", ",", " Henrik", "!"].map((text, index) => ({
          sequence: index + 1,
          kind: "assistant" as const,
          text,
          occurredAt,
        })),
        truncated: false,
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);

    await user.click(await screen.findByRole("button", { name: /Say hello/ }));

    const conversation = screen.getByRole("log", { name: "Subagent conversation" });
    await waitFor(() => expect(within(conversation).getByText("Hello, Henrik!")).toBeVisible());
  });

  it("says plainly when a finished subagent left nothing to read", async () => {
    const user = userEvent.setup();
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "failed", task: "Probe the cache" })],
      })),
      conversation: vi.fn(async () => {
        throw new Error("gone");
      }),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);

    await user.click(await screen.findByRole("button", { name: /Probe the cache/ }));

    await waitFor(() =>
      expect(screen.getByRole("log", { name: "Subagent conversation" })).toHaveTextContent(
        "This subagent left no reply to show.",
      ),
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel this subagent" })).not.toBeInTheDocument();
  });

  it("stays on the subagent another surface asked for, even when the tool remounts, until the reader goes back", async () => {
    const user = userEvent.setup();
    const onRequestedRunHandled = vi.fn();
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "running", task: "Trace the flaky test" })],
      })),
    });
    const tool = () => (
      <AgentRunHierarchy
        client={client}
        onRequestedRunHandled={onRequestedRunHandled}
        parentThreadId={parentThreadId}
        requestedRunId={String(runId)}
      />
    );
    const first = render(tool());
    expect(await screen.findByRole("region", { name: "Subagent" })).toBeVisible();
    // The dock re-keys the tool body once the new tab has its id.
    first.unmount();
    render(tool());
    expect(await screen.findByRole("region", { name: "Subagent" })).toBeVisible();
    expect(onRequestedRunHandled).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Back to subagents" }));
    expect(onRequestedRunHandled).toHaveBeenCalledTimes(1);
  });
});
