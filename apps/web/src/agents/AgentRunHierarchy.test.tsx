import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { type AgentRunSettingsClient } from "@octant/client-runtime/agent-run-settings-client";
import { decodeAgentRunId, decodeAgentRunParentThreadId } from "@octant/contracts/agent-run";
import { AgentRunHierarchy } from "./AgentRunHierarchy";

const parentThreadId = decodeAgentRunParentThreadId("11111111-1111-4111-8111-111111111111");
const runId = decodeAgentRunId("22222222-2222-4222-8222-222222222222");

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
    cancel: vi.fn(async () => ({ results: [] })),
    steer: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    retry: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    resume: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
    usageResume: vi.fn(async () => ({ kind: "run-updated" as const, run: {} as never })),
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
  it("follows up a completed managed child with its existing identity and version", async () => {
    const user = userEvent.setup();
    const resume = vi.fn<AgentRunClient["resume"]>().mockResolvedValue({ kind: "run-updated" });
    const client = emptyClient({
      resume,
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "completed", task: "Review the migration" })],
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);
    await user.click(await screen.findByRole("button", { name: /Review the migration/ }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    await user.type(
      screen.getByRole("textbox", { name: "Follow-up message" }),
      "  Check recovery too.  ",
    );
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(resume).toHaveBeenCalledExactlyOnceWith({
      runId,
      expectedVersion: 3,
      message: "Check recovery too.",
    });
  });

  it.each([
    { lifecycleStatus: "cancelled", executionKind: "octant-managed" },
    { lifecycleStatus: "completed", executionKind: "provider-native" },
  ])("does not offer a follow-up for $lifecycleStatus $executionKind children", async (state) => {
    const user = userEvent.setup();
    const client = emptyClient({
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [
          {
            ...summaryEntry({ lifecycleStatus: state.lifecycleStatus, task: "Read-only child" }),
            ...state,
          },
        ],
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);
    await user.click(await screen.findByRole("button", { name: /Read-only child/ }));
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
    const client = emptyClient({
      resume,
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "completed", task: "Review the migration" })],
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);
    await user.click(await screen.findByRole("button", { name: /Review the migration/ }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    await user.type(
      screen.getByRole("textbox", { name: "Follow-up message" }),
      "  Keep my draft.  ",
    );
    await user.dblClick(screen.getByRole("button", { name: "Send follow-up" }));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toBeDisabled();
    await act(async () =>
      finish?.({ kind: "run-command-failed", message: "Saved session is unavailable." }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved session is unavailable.");
    expect(screen.getByRole("textbox", { name: "Follow-up message" })).toHaveValue(
      "  Keep my draft.  ",
    );
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeEnabled();
  });

  it("requires a message and limits follow-ups to 4096 characters", async () => {
    const user = userEvent.setup();
    const resume = vi.fn<AgentRunClient["resume"]>().mockResolvedValue({ kind: "run-updated" });
    const client = emptyClient({
      resume,
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [summaryEntry({ lifecycleStatus: "completed", task: "Review the migration" })],
      })),
    });
    render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);
    await user.click(await screen.findByRole("button", { name: /Review the migration/ }));
    await user.click(screen.getByRole("button", { name: "Follow up" }));
    const field = screen.getByRole("textbox", { name: "Follow-up message" });
    expect(field).toHaveAttribute("maxlength", "4096");
    await user.type(field, "   ");
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();
    expect(resume).not.toHaveBeenCalled();
    await user.clear(field);
    await user.paste("x".repeat(4096));
    await user.type(field, "y");
    expect(field).toHaveValue("x".repeat(4096));
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(resume).toHaveBeenCalledExactlyOnceWith({
      runId,
      expectedVersion: 3,
      message: "x".repeat(4096),
    });
  });

  it("keeps a new child's draft separate from the previous child's pending request", async () => {
    const user = userEvent.setup();
    const secondRunId = decodeAgentRunId("33333333-3333-4333-8333-333333333333");
    let finish: ((result: Awaited<ReturnType<AgentRunClient["resume"]>>) => void) | undefined;
    const resume = vi.fn<AgentRunClient["resume"]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const client = emptyClient({
      resume,
      parentSummary: vi.fn(async () => ({
        parentThreadId,
        entries: [
          summaryEntry({ lifecycleStatus: "completed", task: "First child" }),
          {
            ...summaryEntry({ lifecycleStatus: "completed", task: "Second child" }),
            runId: secondRunId,
          },
        ],
      })),
    });
    const view = render(
      <AgentRunHierarchy client={client} parentThreadId={parentThreadId} requestedRunId={runId} />,
    );
    await user.click(await screen.findByRole("button", { name: "Follow up" }));
    await user.type(screen.getByRole("textbox", { name: "Follow-up message" }), "First draft");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    view.rerender(
      <AgentRunHierarchy
        client={client}
        parentThreadId={parentThreadId}
        requestedRunId={secondRunId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Follow up" }));
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
      const client = emptyClient({
        resume,
        parentSummary: vi.fn(async () => ({
          parentThreadId,
          entries: [summaryEntry({ lifecycleStatus, task: "Resume this child" })],
        })),
      });
      render(<AgentRunHierarchy client={client} parentThreadId={parentThreadId} />);
      await user.click(await screen.findByRole("button", { name: /Resume this child/ }));
      expect(screen.queryByRole("button", { name: "Follow up" })).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Resume" }));
      expect(resume).toHaveBeenCalledExactlyOnceWith({ runId, expectedVersion: 3 });
    },
  );

  it("offers no way to start a subagent by hand; only the thread's agent starts one", async () => {
    render(<AgentRunHierarchy client={emptyClient()} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Subagents" })).toBeVisible());
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/They appear here when the agent hands off part of its work/),
    ).toBeVisible();
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
      <AgentRunHierarchy
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="automatic"
      />,
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
          creationPosture="automatic"
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

  it("keeps a newly started child when an older, slower read answers last", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const secondRunId = decodeAgentRunId("33333333-3333-4333-8333-333333333333");
      const child = (id: typeof runId, lifecycleStatus: "starting" | "completed") => ({
        runId: id,
        requestId: `request-${String(id)}`,
        parentThreadId,
        role: "review",
        task: `Task ${String(id)}`,
        lifecycleStatus,
        executionKind: "octant-managed",
        usageQuality: "provider-reported",
        resultAcknowledgement: { required: false, acknowledged: false },
        version: 2,
        updatedAt: "2026-08-01T15:01:00.000Z",
      });
      const reads: Array<(value: unknown) => void> = [];
      const parentSummary = vi
        .fn()
        .mockResolvedValueOnce({ parentThreadId, entries: [child(runId, "starting")] })
        .mockImplementation(() => new Promise((resolve) => reads.push(resolve)));
      render(
        <AgentRunHierarchy
          client={emptyClient({ parentSummary: parentSummary as never })}
          parentThreadId={parentThreadId}
          creationPosture="automatic"
        />,
      );
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Working · 1" })).toBeVisible(),
      );

      // Two beats go out before either answers.
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(reads).toHaveLength(2);
      // The newer read sees a second child; the older one answers after it.
      reads[1]?.({
        parentThreadId,
        entries: [child(runId, "starting"), child(secondRunId, "starting")],
      });
      await waitFor(() =>
        expect(screen.getByRole("heading", { name: "Working · 2" })).toBeVisible(),
      );
      reads[0]?.({ parentThreadId, entries: [child(runId, "completed")] });
      await act(() => vi.advanceTimersByTimeAsync(50));

      expect(screen.getByRole("heading", { name: "Working · 2" })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says subagents are turned off when the posture is Off", async () => {
    const client = emptyClient();
    render(
      <AgentRunHierarchy client={client} parentThreadId={parentThreadId} creationPosture="off" />,
    );
    // The loading state has a heading too, so wait for the words themselves.
    expect(await screen.findAllByText(/turned off in Settings/i)).not.toHaveLength(0);
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
        client={client}
        parentThreadId={parentThreadId}
        creationPosture="off"
        settingsClient={settingsClient}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/They appear here when the agent hands off/)).toBeVisible(),
    );
    expect(screen.queryByText(/turned off in Settings/i)).not.toBeInTheDocument();
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
