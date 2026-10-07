import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentsTray, ThreadSubagentsTray } from "./ComposerSubagentsTray";
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
    await user.click(
      screen.getByRole("button", { name: /Inspect observed child: Inspect parser/ }),
    );
    expect(onOpenSubagent).toHaveBeenCalledWith("observation:provider-child");
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
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
        approvals: [{ status: "pending", source: { runId } }],
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
    await userEvent.click(await screen.findByRole("button", { name: "Review request" }));
    expect(onOpenSubagent).toHaveBeenCalledWith(runId);
    rendered.rerender(
      <ThreadSubagentsTray
        client={client}
        interactionsClient={interactionsClient}
        threadId="22222222-2222-4222-8222-222222222222"
        onOpenSubagent={onOpenSubagent}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review request" })).not.toBeInTheDocument();
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
    await userEvent.click(
      screen.getByRole("button", { name: /Inspect observed child: Inspect parser/ }),
    );
    expect(onOpenSubagent).toHaveBeenLastCalledWith("observation:provider-child");
    expect(
      screen.queryByRole("button", {
        name: "Stop subagent: Task 90000000-0000-4000-8000-000000000002",
      }),
    ).not.toBeInTheDocument();
  });
});
