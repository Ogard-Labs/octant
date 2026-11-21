import { describe, expect, it } from "vitest";
import {
  decodeCodeOperationEvent,
  decodeUtcTimestamp,
  type CodeOperationEvent,
} from "@octant/contracts";
import {
  EMPTY_TURN_ACTIVITY,
  activeRowCount,
  settledTurnActivitySummary,
} from "../transcript/turnActivity";
import { appendReasoning, applyActivityEvent, liveTaskProgress } from "./transcriptActivity";

function tool(state: "started" | "running" | "completed" | "failed"): CodeOperationEvent {
  return {
    kind: "tool-activity",
    toolCallId: "call-1" as never,
    toolName: "Bash",
    state,
    summary: "bun run verify",
  } as CodeOperationEvent;
}

describe("Octant Shield in a Code turn's activity", () => {
  it("adds one row per decision, each its own, and counts none as open work", () => {
    const decision = {
      reviewer: "octant-shield" as const,
      verdict: "allow" as const,
      stage: "fast-allow" as const,
      rule: "in-root-edit",
      reason: "An edit inside the bound folder.",
      latencyMs: 0,
      decidedAt: decodeUtcTimestamp("2026-10-31T00:00:00.000Z"),
    };
    const event = decodeCodeOperationEvent({
      kind: "approval-reviewed",
      summary: "edit: src/a.ts",
      decision,
    });
    const once = applyActivityEvent(EMPTY_TURN_ACTIVITY, event);
    const twice = applyActivityEvent(once, event);
    expect(twice.rows).toHaveLength(2);
    expect(twice.rows[0]).toMatchObject({ kind: "review", summary: "edit: src/a.ts", decision });
    expect(new Set(twice.rows.map((row) => row.id)).size).toBe(2);
    expect(activeRowCount(twice)).toBe(0);
  });
});

describe("A runtime's own turns in a Code turn's activity", () => {
  it("says how often the runtime continued the turn after background work", () => {
    const continued = decodeCodeOperationEvent({
      kind: "runtime-turn-started",
      trigger: "background-task",
    });
    const once = applyActivityEvent(
      applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("completed")),
      continued,
    );
    expect(settledTurnActivitySummary(once)).toBe("1 tool call · Continued after background work");
    expect(settledTurnActivitySummary(applyActivityEvent(once, continued))).toBe(
      "1 tool call · Continued 2 times after background work",
    );
    expect(settledTurnActivitySummary(EMPTY_TURN_ACTIVITY)).toBe("");
  });
});

describe("Octant Shield's Watcher in a Code turn's activity", () => {
  it("keeps a tool row's outside-content mark from the event that set it", () => {
    const outsideContent = { labels: ["hidden-text" as const] };
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("started"));
    const completed = applyActivityEvent(started, {
      ...tool("completed"),
      outsideContent,
    } as CodeOperationEvent);
    expect(completed.rows).toEqual([
      expect.objectContaining({ state: "completed", outsideContent }),
    ]);
    expect(started.rows[0]).not.toHaveProperty("outsideContent");
  });
});

describe("transcript activity", () => {
  it("shows an endpoint retry and clears it when content or a tool call arrives", () => {
    const announcedAt = decodeUtcTimestamp("2026-10-06T12:00:00.000Z");
    const retrying = decodeCodeOperationEvent({
      kind: "provider-retry",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 4_000,
      reason: "unavailable",
      announcedAt,
    });
    const waiting = applyActivityEvent(EMPTY_TURN_ACTIVITY, retrying);
    expect(waiting.retrying).toMatchObject({ attempt: 2, maxAttempts: 5, delayMs: 4_000 });
    const content = decodeCodeOperationEvent({
      kind: "provider-content",
      channel: "message",
      content: {
        contentId: "89000000-0000-4000-8000-000000000030",
        digest: "d".repeat(64),
        byteLength: 4,
      },
    });
    expect(applyActivityEvent(waiting, content).retrying).toBeUndefined();
    // A retried response that only calls a tool streams no content.
    const toolOnly = applyActivityEvent(waiting, tool("started"));
    expect(toolOnly.retrying).toBeUndefined();
    expect(toolOnly.rows).toHaveLength(1);
  });

  it("stops showing an endpoint retry once the turn fails or ends without content", () => {
    const waiting = applyActivityEvent(
      EMPTY_TURN_ACTIVITY,
      decodeCodeOperationEvent({
        kind: "provider-retry",
        attempt: 5,
        maxAttempts: 5,
        delayMs: 4_000,
        reason: "unavailable",
        announcedAt: decodeUtcTimestamp("2026-10-06T12:00:00.000Z"),
      }),
    );
    const operationId = "89000000-0000-4000-8000-000000000031";
    const failed = decodeCodeOperationEvent({
      kind: "operation-state",
      state: "failed",
      failure: { category: "unavailable", message: "The provider stayed busy." },
    });
    const refused = decodeCodeOperationEvent({
      kind: "operation-result",
      result: {
        kind: "operation-failed",
        operationId,
        failure: { category: "failed", message: "The turn could not finish." },
      },
    });
    const stillRunning = decodeCodeOperationEvent({ kind: "operation-state", state: "running" });

    expect(applyActivityEvent(waiting, failed).retrying).toBeUndefined();
    expect(applyActivityEvent(waiting, refused).retrying).toBeUndefined();
    expect(applyActivityEvent(waiting, stillRunning).retrying).toBeDefined();
  });

  it("remembers the files a turn created or rewrote and forgets one it deleted", () => {
    const change = (path: string, kind: "created" | "modified" | "deleted"): CodeOperationEvent =>
      ({ kind: "file-change", path, change: kind, reconciled: true }) as CodeOperationEvent;
    let activity = applyActivityEvent(EMPTY_TURN_ACTIVITY, change("docs/handoff.md", "created"));
    activity = applyActivityEvent(activity, change("docs/handoff.md", "modified"));
    activity = applyActivityEvent(activity, change("src/index.ts", "modified"));
    expect(activity.writtenPaths).toEqual(["docs/handoff.md", "src/index.ts"]);
    activity = applyActivityEvent(activity, change("src/index.ts", "deleted"));
    expect(activity.writtenPaths).toEqual(["docs/handoff.md"]);
  });

  it("updates a tool row in place rather than appending each state change", () => {
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("started"));
    const finished = applyActivityEvent(started, tool("completed"));
    expect(finished.rows).toEqual([
      {
        kind: "tool",
        id: "call-1",
        toolName: "Bash",
        state: "completed",
        summary: "bun run verify",
      },
    ]);
  });

  it("keeps a journaled summary as a summary, not as tool arguments or output", () => {
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "tool-activity",
      toolCallId: "call-1" as never,
      toolName: "Read",
      state: "running",
      summary: "Reading file…",
    } as CodeOperationEvent);
    expect(started.rows[0]).toEqual({
      kind: "tool",
      id: "call-1",
      toolName: "Read",
      state: "running",
      summary: "Reading file…",
    });
    expect(started.rows[0]).not.toHaveProperty("arguments");
    expect(started.rows[0]).not.toHaveProperty("output");
  });

  it("replaces the summary when a later event records a different one", () => {
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("running"));
    const finished = applyActivityEvent(started, {
      kind: "tool-activity",
      toolCallId: "call-1" as never,
      toolName: "Bash",
      state: "completed",
      summary: "exit 0",
    } as CodeOperationEvent);
    expect(finished.rows[0]).toMatchObject({
      summary: "exit 0",
      state: "completed",
    });
    expect(finished.rows[0]).not.toHaveProperty("arguments");
    expect(finished.rows[0]).not.toHaveProperty("output");
  });

  it("keeps a failed call's message as the row summary so the fold still names the refusal", () => {
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("running"));
    const failed = applyActivityEvent(started, {
      kind: "tool-activity",
      toolCallId: "call-1" as never,
      toolName: "Bash",
      state: "failed",
      summary: "Write refused: path is outside the checkout.",
    } as CodeOperationEvent);
    expect(failed.rows[0]).toMatchObject({
      state: "failed",
      summary: "Write refused: path is outside the checkout.",
    });
  });

  it("keeps tool and task rows apart even when their ids collide", () => {
    const withTool = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("running"));
    const withTask = applyActivityEvent(withTool, {
      kind: "task-progress",
      taskId: "call-1",
      state: "running",
      summary: "Rewrite the diff pane",
    } as CodeOperationEvent);
    expect(withTask.rows).toHaveLength(2);
  });

  it("drops task rows a restated plan leaves out and follows its order around tool rows", () => {
    const task = (taskId: string, summary: string) =>
      ({ kind: "task-progress", taskId, state: "pending", summary }) as CodeOperationEvent;
    let activity = applyActivityEvent(EMPTY_TURN_ACTIVITY, task("t1", "Read"));
    activity = applyActivityEvent(activity, tool("running"));
    activity = applyActivityEvent(activity, task("t2", "Write"));
    activity = applyActivityEvent(activity, task("t3", "Test"));
    const restated = applyActivityEvent(activity, {
      kind: "task-list",
      taskIds: ["t3", "t1"],
    } as CodeOperationEvent);
    expect(restated.rows.map((row) => `${row.kind} ${row.id}`)).toEqual([
      "task t3",
      "tool call-1",
      "task t1",
    ]);
    expect(
      applyActivityEvent(restated, {
        kind: "task-list",
        taskIds: ["t3", "t1"],
      } as CodeOperationEvent),
    ).toBe(restated);
  });

  it("ignores events the transcript does not render", () => {
    const unchanged = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "operation-state",
      state: "running",
    } as CodeOperationEvent);
    expect(unchanged).toBe(EMPTY_TURN_ACTIVITY);
  });

  it("accumulates reasoning chunks in arrival order", () => {
    const reasoning = appendReasoning(appendReasoning(EMPTY_TURN_ACTIVITY, "First "), "second.");
    expect(reasoning.reasoning).toBe("First second.");
    expect(appendReasoning(reasoning, "")).toBe(reasoning);
  });

  it("counts only rows that are still open", () => {
    const running = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("running"));
    const withDoneTask = applyActivityEvent(running, {
      kind: "task-progress",
      taskId: "task-1",
      state: "completed",
      summary: "Ship it",
    } as CodeOperationEvent);
    expect(activeRowCount(withDoneTask)).toBe(1);
    expect(activeRowCount(applyActivityEvent(withDoneTask, tool("completed")))).toBe(0);
  });

  it("shows the newest turn's task list while any of it is still open", () => {
    const earlier = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "task-progress",
      taskId: "t1",
      state: "completed",
      summary: "Earlier work",
    } as CodeOperationEvent);
    const live = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "task-progress",
      taskId: "t2",
      state: "running",
      summary: "Watch CI on the branch head",
    } as CodeOperationEvent);
    expect(
      liveTaskProgress([
        { activity: earlier, running: false },
        { activity: live, running: true },
      ]),
    ).toEqual({
      tasks: [{ kind: "task", id: "t2", state: "running", summary: "Watch CI on the branch head" }],
      running: true,
    });
  });

  it("keeps an interrupted turn's unfinished list on the panel", () => {
    const interrupted = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "task-progress",
      taskId: "t1",
      state: "pending",
      summary: "Update the pull request body",
    } as CodeOperationEvent);
    expect(liveTaskProgress([{ activity: interrupted, running: false }])).toEqual({
      tasks: [
        { kind: "task", id: "t1", state: "pending", summary: "Update the pull request body" },
      ],
      running: false,
    });
  });

  it("leaves no panel for a settled turn whose tasks all finished", () => {
    const settled = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
      kind: "task-progress",
      taskId: "t1",
      state: "completed",
      summary: "Post the verification comment",
    } as CodeOperationEvent);
    expect(liveTaskProgress([{ activity: settled, running: false }])).toBeUndefined();
  });

  describe("turn timings", () => {
    const started = "2026-07-21T13:00:12.000Z";
    const ended = "2026-07-21T13:04:14.000Z";

    it("assigns the journaled reasoning total instead of adding to it", () => {
      const first = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "reasoning-time",
        reasoningMs: 12_000,
      } as CodeOperationEvent);
      expect(first.reasoningMs).toBe(12_000);
      const replayed = applyActivityEvent(first, {
        kind: "reasoning-time",
        reasoningMs: 12_000,
      } as CodeOperationEvent);
      expect(replayed.reasoningMs).toBe(12_000);
      const grown = applyActivityEvent(replayed, {
        kind: "reasoning-time",
        reasoningMs: 20_500,
      } as CodeOperationEvent);
      expect(grown.reasoningMs).toBe(20_500);
    });

    it("times a completed call and keeps the person's wait beside it", () => {
      const activity = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "completed",
        timing: { startedAt: started, endedAt: ended, approvalWaitMs: 240_000 },
      } as CodeOperationEvent);
      const row = activity.rows.find((r) => r.kind === "tool");
      expect(row).toMatchObject({ durationMs: 2_000, waitedMs: 240_000 });
    });

    it("keeps the first bounded measurement when a restated completion carries none", () => {
      const activity = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "completed",
        timing: { startedAt: started, endedAt: ended, approvalWaitMs: 240_000 },
      } as CodeOperationEvent);
      const restated = applyActivityEvent(activity, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "completed",
        summary: "Provider restated the completion.",
      } as CodeOperationEvent);
      const row = restated.rows.find((r) => r.kind === "tool");
      expect(row).toMatchObject({
        summary: "Provider restated the completion.",
        durationMs: 2_000,
        waitedMs: 240_000,
      });
    });

    it("times a call with no wait as a plain duration", () => {
      const activity = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "completed",
        timing: { startedAt: started, endedAt: ended },
      } as CodeOperationEvent);
      const row = activity.rows.find((r) => r.kind === "tool");
      expect(row).toMatchObject({ durationMs: 242_000 });
      expect(row && "waitedMs" in row ? row.waitedMs : undefined).toBeUndefined();
    });

    it("shows no duration for a running call or malformed bounds", () => {
      const running = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "started",
      } as CodeOperationEvent);
      const runningRow = running.rows.find((r) => r.kind === "tool");
      expect(
        runningRow && "durationMs" in runningRow ? runningRow.durationMs : undefined,
      ).toBeUndefined();
      const malformed = applyActivityEvent(EMPTY_TURN_ACTIVITY, {
        kind: "tool-activity",
        toolCallId: "call-1",
        toolName: "Read",
        state: "completed",
        timing: { startedAt: ended, endedAt: started },
      } as CodeOperationEvent);
      const badRow = malformed.rows.find((r) => r.kind === "tool");
      expect(badRow && "durationMs" in badRow ? badRow.durationMs : undefined).toBeUndefined();
    });
  });

  it("leaves no panel for a turn that journaled no tasks", () => {
    const toolOnly = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("completed"));
    expect(liveTaskProgress([{ activity: toolOnly, running: true }])).toBeUndefined();
  });
});
