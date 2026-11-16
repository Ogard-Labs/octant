import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentsTray, ThreadSubagentsTray } from "./ComposerSubagentsTray";
import { ObservedChildDetail } from "./ObservedChildActivity";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";
import { observedChildFixture, resultPacketFixture } from "./agentActivityFixtures";

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
    <SubagentsTray
      entries={entries}
      storage={memoryStorage({ "octant.composer-subagents.open": "true" })}
      {...handlers}
      {...overrides}
    />,
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
  it("counts observed failures while folded and opens their read-only detail without a stop action", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray([], {
      observations: [observedChildFixture({ lifecycleStatus: "failed" })],
      observationsTruncated: true,
      storage: memoryStorage(),
    });
    const toggle = screen.getByRole("button", { name: /Subagents,/ });
    expect(toggle).toHaveTextContent("1 failed · earlier ones not retained");
    expect(screen.getByText(/Earlier observed children/)).toBeVisible();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: /^Inspect parser\. / }));
    expect(onOpenSubagent).toHaveBeenCalledWith("observation:provider-child");
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });

  it("offers Stop for an observed child the running turn can stop, and keeps its status until the provider reports it", async () => {
    const user = userEvent.setup();
    const stopObserved = vi.fn(async () => ({ status: "stop-requested" as const }));
    renderTray([], {
      observations: [observedChildFixture({ lifecycleStatus: "running", control: "stop" })],
      stopClient: { stopObserved },
    });
    await user.click(screen.getByRole("button", { name: /Stop subagent: Inspect parser/ }));
    expect(stopObserved).toHaveBeenCalledWith(
      expect.objectContaining({ observationId: observedChildFixture().observationId }),
    );
    expect(screen.getByRole("button", { name: /Stop subagent/ })).toHaveTextContent("Stopping");
    expect(screen.getByRole("button", { name: /Opens it in Agents/ })).toHaveTextContent("Working");
  });

  it("sends a running observed child to the background and messages it where the running turn offers both", async () => {
    const user = userEvent.setup();
    const backgroundObserved = vi.fn(async () => ({ status: "backgrounded" as const }));
    const messageObserved = vi.fn(async () => ({ status: "queued" as const }));
    renderTray([], {
      observations: [
        observedChildFixture({
          lifecycleStatus: "running",
          control: "stop",
          steering: ["background", "message"],
        }),
      ],
      stopClient: { backgroundObserved, messageObserved },
    });
    await user.click(
      screen.getByRole("button", { name: /Send subagent to the background: Inspect parser/ }),
    );
    expect(backgroundObserved).toHaveBeenCalledWith(
      expect.objectContaining({ observationId: observedChildFixture().observationId }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Running in the background.");
    await user.type(screen.getByRole("textbox", { name: /Message for Inspect parser/ }), "Skip it");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(messageObserved).toHaveBeenCalledWith(expect.objectContaining({ message: "Skip it" }));
    expect(screen.getByRole("status")).toHaveTextContent("next tool call");
  });

  it("offers no background or message control for a child the running turn cannot steer", () => {
    renderTray([], {
      observations: [observedChildFixture({ lifecycleStatus: "running", control: "stop" })],
      stopClient: {
        backgroundObserved: vi.fn(),
        messageObserved: vi.fn(),
      },
    });
    expect(screen.queryByRole("button", { name: /background/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /Message for/ })).not.toBeInTheDocument();
  });

  it("previews a finished observed child's closing report and reported usage, never inventing zeros", () => {
    renderTray([], {
      observations: [
        observedChildFixture({
          childAgentId: "reported",
          observationId: "reported",
          lifecycleStatus: "failed",
          finalSummary: "Parser handles nested quotes.",
          usage: { inputTokens: 14_700, outputTokens: 300 },
        }),
        observedChildFixture({
          childAgentId: "total-only",
          observationId: "total-only",
          task: "Count tokens",
          lifecycleStatus: "failed",
          usage: { totalTokens: 2_000 },
        }),
        observedChildFixture({
          childAgentId: "silent",
          observationId: "silent",
          task: "Say nothing",
          lifecycleStatus: "failed",
        }),
      ],
    });
    const reported = screen.getByRole("button", { name: /^Inspect parser\. / });
    expect(reported).toHaveTextContent("Parser handles nested quotes.");
    expect(reported).toHaveTextContent("IN 14.7k · OUT 300");
    expect(screen.getByRole("button", { name: /^Count tokens\. / })).toHaveTextContent("2k tokens");
    const silent = screen.getByRole("button", { name: /^Say nothing\. / });
    expect(silent).not.toHaveTextContent(/IN |OUT |tokens/);
  });

  it("says why a stop was refused", async () => {
    const user = userEvent.setup();
    renderTray([], {
      observations: [observedChildFixture({ lifecycleStatus: "running", control: "stop" })],
      stopClient: {
        stopObserved: async () => ({ status: "refused" as const, reason: "not-live" as const }),
      },
    });
    await user.click(screen.getByRole("button", { name: /Stop subagent/ }));
    expect(screen.getByRole("status")).toHaveTextContent("no longer running");
  });

  it("previews the latest attributed result using that generation's model and reported evidence", () => {
    renderTray([
      {
        ...entry("a", "completed", { required: true }),
        resultPackets: [
          resultPacketFixture({ generation: 1 }),
          resultPacketFixture({ generation: 2, modelId: "second-model" }),
        ],
      },
    ]);
    const result = screen.getByText(/Generation 2 ·/);
    expect(result).toHaveTextContent("second-model");
    expect(result).not.toHaveTextContent("55555555-5555-4555-8555-555555555555");
    expect(screen.getByText(/1 file reported · unverified/)).toBeVisible();
    expect(screen.getByText(/Checks unavailable/)).toBeVisible();
    expect(screen.queryByText(/first-model/)).not.toBeInTheDocument();
  });

  it("shows a bounded preview with waiting, failed and review counts independent of running work", () => {
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
    expect(rows).toHaveLength(3);
    const toggle = within(tray).getByRole("button", { name: /Subagents,/ });
    expect(toggle).toHaveTextContent("1 failed · 1 waiting · 1 to review · 1 working · 1 done");
    expect(screen.getByRole("button", { name: "View all 5 subagents in Agents" })).toBeVisible();
    expect(within(tray).queryByText("Task e")).not.toBeInTheDocument();
  });

  it("keeps completed results discoverable without expanding their history into the composer", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray(
      [
        entry("a", "completed", { required: true }),
        entry("b", "completed", { required: true, acknowledged: true }),
      ],
      { storage: memoryStorage() },
    );

    const toggle = screen.getByRole("button", { name: /Subagents,/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 to review · 1 done");
    expect(screen.queryByRole("button", { name: /Opens it in Agents/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View all 2 subagents in Agents" }));
    expect(onOpenSubagent).toHaveBeenCalledWith();
  });

  it("lists a failed child with the host's reason, so the head never counts one it hides", () => {
    renderTray([
      {
        ...entry("a", "failed"),
        recoveryReason: "Claude authentication is required.",
      },
      entry("b", "completed"),
    ]);

    expect(screen.getByRole("button", { name: /Subagents,/ })).toHaveTextContent(
      "1 failed · 1 done",
    );
    expect(screen.getByText("Claude authentication is required.")).toBeVisible();
    expect(screen.queryByText("Task b")).not.toBeInTheDocument();
  });

  it("asks for no review of a result the parent already received", () => {
    renderTray(
      [
        { ...entry("a", "completed", { required: true }), resultDeliveryOutcome: "consumed" },
        { ...entry("b", "completed", { required: true }), resultDeliveryOutcome: "delivered" },
      ],
      { storage: memoryStorage() },
    );

    const toggle = screen.getByRole("button", { name: /Subagents,/ });
    expect(toggle).toHaveTextContent("2 done");
    expect(toggle).not.toHaveTextContent(/review/);
  });

  it("still asks for review of a result the parent never received", () => {
    renderTray(
      [{ ...entry("a", "completed", { required: true }), resultDeliveryOutcome: "failed" }],
      { storage: memoryStorage() },
    );

    expect(screen.getByRole("button", { name: /Subagents,/ })).toHaveTextContent("1 to review");
  });

  it("dims and withholds Stop while the connection is lost, without saying so again", async () => {
    const user = userEvent.setup();
    const { onStop } = renderTray([entry("a", "running")], { reconnecting: true });

    expect(screen.getByRole("group", { name: "Subagents" })).toHaveAttribute("data-stale", "true");
    expect(screen.queryByText(/Reconnecting|last status/)).not.toBeInTheDocument();
    const stop = screen.getByRole("button", { name: "Stop subagent: Task a" });
    expect(stop).toBeDisabled();
    await user.click(stop);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("omits the tray when the host reports no children", () => {
    renderTray([]);
    expect(screen.queryByRole("group", { name: "Subagents" })).not.toBeInTheDocument();
  });

  it("shows only recorded model, reason and update age without claiming total run time", () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-26T10:00:12.000Z"), shouldAdvanceTime: true });
    renderTray([
      {
        ...entry("a", "waiting"),
        recoveryReason: "Waiting for approval",
        route: {
          requestedProviderInstanceId: "provider-one",
          executionProviderInstanceId: "provider-two",
          requestedModelId: "requested-model",
          executionModelId: "actual-model",
          poolDerived: false,
        },
      },
      { ...entry("b", "running"), updatedAt: "unavailable" },
    ]);
    const recorded = screen.getByRole("button", { name: /^Task a\. Waiting/ });
    expect(recorded).toHaveTextContent("actual-model");
    expect(recorded).toHaveTextContent("Updated 12s ago");
    expect(recorded).toHaveTextContent("Waiting for approval");
    expect(recorded).not.toHaveTextContent("requested-model");
    const unknown = screen.getByRole("button", { name: /^Task b\. Working/ });
    expect(unknown).not.toHaveTextContent(/Updated|model|NaN/);
  });

  it("asks to open the chosen subagent", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray([entry("a", "running"), entry("b", "running")]);

    await user.click(screen.getByRole("button", { name: /^Task b\. Working/ }));
    expect(onOpenSubagent).toHaveBeenLastCalledWith("b");
  });

  it("folds to its head and stays folded for this viewer", async () => {
    const user = userEvent.setup();
    const storage = memoryStorage({ "octant.composer-subagents.open": "true" });
    renderTray([entry("a", "running")], { storage });

    await user.click(screen.getByRole("button", { name: /Subagents,.*Hide them/ }));
    expect(screen.queryByRole("button", { name: /Opens it in Agents/ })).not.toBeInTheDocument();
    expect(storage.setItem).toHaveBeenCalledWith("octant.composer-subagents.open", "false");

    cleanup();
    renderTray([entry("a", "running")], { storage });
    const toggle = screen.getByRole("button", { name: /Subagents,.*Show them/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard("{Enter}");
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
    expect(confirm).toHaveTextContent("Stop all 2 managed subagents on this thread?");
    expect(confirm).toHaveTextContent("Only this thread's managed subagents are affected.");
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

  it("lists both kinds of subagent as one list, naming the provider on every row and asking first", async () => {
    const user = userEvent.setup();
    const route = {
      requestedProviderInstanceId: "55555555-5555-4555-8555-555555555555",
      requestedModelId: "gpt-6-astra",
      executionProviderInstanceId: "55555555-5555-4555-8555-555555555555",
      executionModelId: "gpt-6-astra",
      poolDerived: false,
    };
    renderTray([{ ...entry("a", "running"), route }], {
      observations: [
        observedChildFixture({
          observationId: "done",
          task: "Finished scan",
          lifecycleStatus: "completed",
        }),
        observedChildFixture({
          observationId: "stuck",
          task: "Stuck scan",
          lifecycleStatus: "failed",
        }),
      ],
      providers: new Map([
        ["55555555-5555-4555-8555-555555555555", { driverKind: "codex", displayName: "Codex" }],
      ]),
    });
    // A finished provider-started subagent counts like a finished managed one.
    expect(screen.getByRole("button", { name: /Subagents,/ })).toHaveTextContent(
      "1 failed · 1 working · 1 done",
    );
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Stuck scan"),
      expect.stringContaining("Task a"),
    ]);
    expect(rows[0]).toHaveTextContent("Failed · Started by Codex · Model unknown");
    expect(rows[1]).toHaveTextContent("Working · Codex · gpt-6-astra");
    expect(rows[0]?.querySelector('[data-driver-kind="codex"]')).not.toBeNull();
    // Only the run Octant started offers Stop.
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: /Stop/ })).toBeNull();
    await user.click(within(rows[1] as HTMLElement).getByRole("button", { name: /Stop subagent/ }));
  });

  it("shows a compare group as one line with its members counted by state", async () => {
    const user = userEvent.setup();
    const { onOpenSubagent } = renderTray([
      { ...entry("a", "running"), compareGroup: "plans" },
      { ...entry("b", "completed"), compareGroup: "plans" },
      { ...entry("c", "running"), compareGroup: "plans" },
    ]);
    const rows = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    const group = within(rows[0] as HTMLElement).getByRole("button", { name: /^Compare plans\./ });
    expect(group).toHaveTextContent("3 subagents · 2 working · 1 done");
    await user.click(group);
    expect(onOpenSubagent).toHaveBeenCalledWith();
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
        session: { status: "running" },
        approvals: [
          {
            id: "approval-1",
            toolName: "shell",
            summary: "Run tests",
            status: "pending",
            source: { runId, providerInstanceId: "worker", modelId: "large" },
          },
        ],
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
    await userEvent.click(await screen.findByRole("button", { name: "Open child" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(runId);
    rendered.rerender(
      <ThreadSubagentsTray
        client={client}
        interactionsClient={interactionsClient}
        threadId="22222222-2222-4222-8222-222222222222"
        onOpenSubagent={onOpenSubagent}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open child" })).not.toBeInTheDocument();
  });

  it("opens a completed result from the host summary without offering to stop it", async () => {
    const client = {
      parentSummary: vi.fn(async () => ({
        parentThreadId: threadId,
        observations: [observedChildFixture()],
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
    const onOpenSubagent = vi.fn();
    render(
      <ThreadSubagentsTray client={client} threadId={threadId} onOpenSubagent={onOpenSubagent} />,
    );

    await userEvent.click(await screen.findByRole("button", { name: /Subagents,.*Show them/ }));

    expect(
      await screen.findByRole("button", {
        name: /^Task 90000000-0000-4000-8000-000000000001\. Working/,
      }),
    ).toBeVisible();
    expect(screen.getByText("Task 90000000-0000-4000-8000-000000000002")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", {
        name: /^Task 90000000-0000-4000-8000-000000000002\. Done/,
      }),
    );
    expect(onOpenSubagent).toHaveBeenCalledWith("90000000-0000-4000-8000-000000000002");
    await userEvent.click(screen.getByRole("button", { name: /^Inspect parser\. / }));
    expect(onOpenSubagent).toHaveBeenLastCalledWith("observation:provider-child");
    expect(
      screen.queryByRole("button", {
        name: "Stop subagent: Task 90000000-0000-4000-8000-000000000002",
      }),
    ).not.toBeInTheDocument();
  });
});

describe("ObservedChildDetail", () => {
  afterEach(cleanup);

  it("folds the subagent's final summary and states usage only as reported", async () => {
    const user = userEvent.setup();
    render(
      <ObservedChildDetail
        child={observedChildFixture({
          lifecycleStatus: "completed",
          finalSummary: "Parser handles nested quotes.",
          usage: { inputTokens: 900, outputTokens: 120 },
        })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByText("Usage: IN 900 · OUT 120")).toBeVisible();
    expect(screen.getByText("Parser handles nested quotes.")).not.toBeVisible();
    await user.click(screen.getByText("Final summary from the subagent"));
    expect(screen.getByText("Parser handles nested quotes.")).toBeVisible();
    cleanup();

    render(<ObservedChildDetail child={observedChildFixture()} onBack={vi.fn()} />);
    expect(screen.getByText("Usage not reported")).toBeVisible();
    expect(screen.queryByText("Final summary from the subagent")).not.toBeInTheDocument();
  });
});
