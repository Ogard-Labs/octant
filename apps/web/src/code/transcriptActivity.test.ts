import { describe, expect, it } from "vitest";
import type { CodeOperationEvent } from "@octant/contracts";
import {
  EMPTY_TURN_ACTIVITY,
  activeRowCount,
  appendReasoning,
  applyActivityEvent,
} from "./transcriptActivity";

function tool(state: "started" | "running" | "completed" | "failed"): CodeOperationEvent {
  return {
    kind: "tool-activity",
    toolCallId: "call-1" as never,
    toolName: "Bash",
    state,
    summary: "bun run verify",
  } as CodeOperationEvent;
}

describe("transcript activity", () => {
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
        arguments: "bun run verify",
        output: "bun run verify",
      },
    ]);
  });

  it("keeps the invocation when a completed call records a different result", () => {
    const started = applyActivityEvent(EMPTY_TURN_ACTIVITY, tool("running"));
    const finished = applyActivityEvent(started, {
      kind: "tool-activity",
      toolCallId: "call-1" as never,
      toolName: "Bash",
      state: "completed",
      summary: "exit 0",
    } as CodeOperationEvent);
    expect(finished.rows[0]).toMatchObject({
      arguments: "bun run verify",
      output: "exit 0",
      state: "completed",
    });
  });

  it("records a failed call's message as output so the fold still names the refusal", () => {
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
      arguments: "bun run verify",
      output: "Write refused: path is outside the checkout.",
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
});
