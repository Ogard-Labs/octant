import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSubagentsTray } from "./ComposerSubagentsTray";
import { observedChildFixture } from "./agentActivityFixtures";
import { TurnActivityRows } from "../transcript/TurnActivityRows";
import { ThreadSubagentsProvider, TurnSubagentRows } from "./threadSubagents";

const threadId = "11111111-1111-4111-8111-111111111111";

afterEach(cleanup);

function run(runId: string, overrides: Record<string, unknown>) {
  return {
    runId,
    requestId: `r-${runId}`,
    parentThreadId: threadId,
    role: "research",
    task: `Task ${runId}`,
    lifecycleStatus: "completed",
    executionKind: "octant-managed",
    usageQuality: "provider-reported",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:05:21.000Z",
    ...overrides,
  };
}

function client(entries: ReadonlyArray<unknown>, observations: ReadonlyArray<unknown> = []) {
  const parentSummary = vi.fn(async () => ({ parentThreadId: threadId, entries, observations }));
  return {
    client: { parentSummary, acknowledge: vi.fn(), cancel: vi.fn() } as unknown as AgentRunClient,
    parentSummary,
  };
}

describe("TurnSubagentRows", () => {
  it("lists under a turn the subagents it started, with what ran them, how long, and how they ended", async () => {
    const { client: agents } = client(
      [
        run("90000000-0000-4000-8000-000000000001", {
          task: "Judge batch one\nRead every file",
          route: {
            executionProviderInstanceId: "55555555-5555-4555-8555-555555555555",
            executionModelId: "sonnet-5-5",
          },
          normalizedReasoning: "high",
          result: { reference: "r", text: "\nJudged 1 of 1; skipped none", truncated: false },
        }),
        // Started after the next turn began, so it is that turn's.
        run("90000000-0000-4000-8000-000000000002", {
          task: "Later batch",
          createdAt: "2026-11-17T10:30:00.000Z",
        }),
      ],
      [observedChildFixture({ firstObservedAt: "2026-11-17T10:01:00.000Z" as never })],
    );
    render(
      <ThreadSubagentsProvider client={agents} threadId={threadId}>
        <TurnSubagentRows
          window={{ from: "2026-11-17T09:59:00.000Z", until: "2026-11-17T10:20:00.000Z" }}
        />
      </ThreadSubagentsProvider>,
    );
    const list = await screen.findByRole("list", { name: "Subagents" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(
      "Judge batch one, 55555555-5555-4555-8555-555555555555 Sonnet 5.5 High, Done, 5m 21s",
    );
    expect(rows[0]).toHaveTextContent("Judged 1 of 1; skipped none");
    // A provider's own subagent reports its progress; with no model reported it shows none.
    expect(rows[1]).toHaveTextContent("Inspect parser");
    expect(rows[1]).toHaveTextContent("Reading the parser");
    expect(rows[1]).toHaveAccessibleName(
      /^Inspect parser, 55555555-5555-4555-8555-555555555555, Working/,
    );
    expect(screen.queryByText("Later batch")).toBeNull();
  });

  it("lists a turn's subagents when the turn left no tool row of its own", async () => {
    const { client: agents } = client([], [observedChildFixture()]);
    render(
      <ThreadSubagentsProvider client={agents} threadId={threadId}>
        <TurnActivityRows
          activity={{ rows: [], reasoning: "" }}
          running={false}
          subagents={{ from: "2026-09-26T09:00:00.000Z" }}
        />
      </ThreadSubagentsProvider>,
    );
    expect(await screen.findByRole("listitem")).toHaveTextContent("Inspect parser");
  });

  it("reads the thread's subagents once for the composer's tray and the transcript's rows", async () => {
    const pane = client([
      run("90000000-0000-4000-8000-000000000001", { lifecycleStatus: "running" }),
    ]);
    const trayOwn = client([]);
    render(
      <ThreadSubagentsProvider client={pane.client} threadId={threadId}>
        <TurnSubagentRows window={{ from: "2026-11-17T09:59:00.000Z" }} />
        <ThreadSubagentsTray client={trayOwn.client} threadId={threadId} />
      </ThreadSubagentsProvider>,
    );
    await screen.findByRole("list", { name: "Subagents" });
    expect(await screen.findByRole("button", { name: /Subagents,/ })).toBeVisible();
    expect(pane.parentSummary).toHaveBeenCalled();
    expect(trayOwn.parentSummary).not.toHaveBeenCalled();
  });
});
