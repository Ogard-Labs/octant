import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  decodeProviderSessionId,
} from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  mapCodexMessage,
  type CodexEventContext,
  type CodexMappedMessage,
} from "./codexEventMapper";
import type { CodexServerMessage } from "./codexProtocol";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000081");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000082");
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "80000000-0000-4000-8000-000000000083",
);
const occurredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T10:00:00.000Z");

function context(overrides: Partial<CodexEventContext> = {}): CodexEventContext {
  let request = 0;
  let task = 0;
  let tool = 0;
  return {
    instanceId,
    sessionId,
    correlationId,
    occurredAt,
    projectRoot: "/tmp/project",
    threadId: "thread-1",
    turnId: "turn-1",
    sequence: 41,
    terminal: false,
    requestIds: new Map(),
    agentMessages: new Map(),
    taskIds: new Map(),
    toolStates: new Map(),
    makeRequestId: () => `request-${++request}`,
    makeTaskId: () => `task-${++task}`,
    makeToolCallId: () => `tool-${++tool}`,
    ...overrides,
  };
}

function map(
  ctx: CodexEventContext,
  message: CodexServerMessage,
): ReadonlyArray<CodexMappedMessage> {
  return mapCodexMessage(ctx, message).map((mapped) =>
    mapped.kind === "event"
      ? { kind: "event", event: decodeProviderRuntimeEvent(mapped.event) }
      : mapped.kind === "approval"
        ? {
            kind: "approval",
            approval: {
              ...mapped.approval,
              event: decodeProviderRuntimeEvent(mapped.approval.event),
            },
          }
        : mapped,
  );
}

function taskEvents(results: ReadonlyArray<CodexMappedMessage>) {
  return results.flatMap((result) =>
    result.kind === "event" && result.event.kind === "task-progress" ? [result.event] : [],
  );
}

function notification(
  method: Extract<CodexServerMessage, { kind: "notification" }>["method"],
  params: Extract<CodexServerMessage, { kind: "notification" }>["params"],
): CodexServerMessage {
  return { kind: "notification", method, params } as CodexServerMessage;
}

const commandItem = {
  type: "commandExecution" as const,
  id: "provider-command-1",
  command: "printf 'raw command must-not-cross'",
  cwd: "/tmp/project",
  status: "inProgress" as const,
};

describe("mapCodexMessage", () => {
  it.each([
    {
      name: "agent text",
      method: "item/agentMessage/delta" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-agent-1",
        delta: "Hello",
      },
      expected: { kind: "text-delta", text: "Hello" },
    },
    {
      name: "reasoning summary",
      method: "item/reasoning/summaryTextDelta" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-reasoning-1",
        summaryIndex: 0,
        delta: "Checking constraints",
      },
      expected: { kind: "reasoning-delta", text: "Checking constraints" },
    },
    {
      name: "reasoning text",
      method: "item/reasoning/textDelta" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-reasoning-1",
        contentIndex: 0,
        delta: "Evaluating",
      },
      expected: { kind: "reasoning-delta", text: "Evaluating" },
    },
    {
      name: "plan delta",
      method: "item/plan/delta" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-plan-1",
        delta: "Implement mapper",
      },
      expected: { kind: "reasoning-delta", text: "Implement mapper" },
    },
  ])("maps a $name delta without exposing provider item IDs", ({ method, params, expected }) => {
    const [result] = map(context(), notification(method, params));

    expect(result).toMatchObject({
      kind: "event",
      event: {
        ...expected,
        instanceId,
        sessionId,
        sequence: 41,
        correlationId,
        occurredAt,
      },
    });
    expect(JSON.stringify(result)).not.toContain("provider-");
  });

  it("preserves meaningful streamed whitespace, ignores empty deltas, and bounds large deltas", () => {
    const ctx = context();
    const spaced = map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: " hello ",
      }),
    );
    const empty = map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "",
      }),
    );
    const bounded = map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "x".repeat(70_000),
      }),
    );

    expect(spaced).toMatchObject([{ kind: "event", event: { text: " hello ", sequence: 41 } }]);
    expect(empty).toEqual([{ kind: "ignored" }]);
    expect(bounded).toHaveLength(2);
    expect(bounded).toMatchObject([
      { kind: "event", event: { kind: "text-delta", sequence: 42 } },
      { kind: "event", event: { kind: "text-delta", sequence: 43 } },
    ]);
    expect(
      bounded.reduce(
        (length, result) =>
          length +
          (result.kind === "event" && result.event.kind === "text-delta"
            ? result.event.text.length
            : 0),
        0,
      ),
    ).toBe(70_000);
  });

  it("chunks streamed Unicode text without splitting surrogate pairs", () => {
    const text = `${"x".repeat(65_535)}😀y`;
    const results = map(
      context(),
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-unicode",
        delta: text,
      }),
    );
    const chunks = results.flatMap((result) =>
      result.kind === "event" && result.event.kind === "text-delta" ? [result.event.text] : [],
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatch(/😀$/u);
    expect(chunks.join("")).toBe(text);
    expect(chunks.join("")).not.toContain("�");
  });

  it("reconciles an incomplete agent delta stream from the authoritative completed item", () => {
    const ctx = context();
    expect(
      map(
        ctx,
        notification("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "provider-agent-follow-up",
          delta: "F",
        }),
      ),
    ).toMatchObject([{ kind: "event", event: { kind: "text-delta", text: "F" } }]);

    expect(
      map(
        ctx,
        notification("item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "provider-agent-follow-up",
            text: "FOLLOWUP_OK",
          },
          completedAtMs: 20,
        }),
      ),
    ).toMatchObject([{ kind: "event", event: { kind: "text-delta", text: "OLLOWUP_OK" } }]);
  });

  it("does not duplicate a fully streamed completed agent message", () => {
    const ctx = context();
    map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-agent-complete",
        delta: "FOLLOWUP_OK",
      }),
    );

    expect(
      map(
        ctx,
        notification("item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "provider-agent-complete",
            text: "FOLLOWUP_OK",
          },
          completedAtMs: 20,
        }),
      ),
    ).toEqual([{ kind: "ignored" }]);
  });

  it("fails closed when completed agent text contradicts streamed text", () => {
    const ctx = context();
    map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "provider-agent-conflict",
        delta: "private-stream-value",
      }),
    );

    const result = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "provider-agent-conflict",
          text: "different-private-value",
        },
        completedAtMs: 20,
      }),
    );

    expect(result).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider completed agent text that contradicted its streamed text.",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-stream|different-private|provider-agent/);
  });

  it.each([
    {
      name: "command",
      item: commandItem,
      toolName: "Command",
    },
    {
      name: "MCP tool",
      item: {
        type: "mcpToolCall" as const,
        id: "provider-mcp-1",
        server: "filesystem",
        tool: "read_file",
        status: "inProgress" as const,
      },
      toolName: "MCP filesystem/read_file",
    },
    {
      name: "dynamic tool",
      item: {
        type: "dynamicToolCall" as const,
        id: "provider-tool-1",
        namespace: "workspace",
        tool: "inspect",
        status: "inProgress" as const,
        success: null,
      },
      toolName: "workspace/inspect",
    },
  ])("maps $name start and progress with a provider-neutral tool ID", ({ item, toolName }) => {
    const results = map(
      context(),
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item,
        startedAtMs: 10,
      }),
    );

    expect(results).toMatchObject([
      {
        kind: "event",
        event: { kind: "tool-start", sequence: 41, toolCallId: "tool-1", toolName },
      },
      {
        kind: "event",
        event: {
          kind: "tool-progress",
          sequence: 42,
          toolCallId: "tool-1",
          message: "Tool is running.",
        },
      },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/provider-|raw command must-not-cross/);
  });

  it.each([
    { status: "completed" as const, kind: "tool-success", summary: "Tool completed." },
    { status: "failed" as const, kind: "tool-failure", message: "Tool failed." },
    { status: "declined" as const, kind: "tool-failure", message: "Tool was declined." },
  ])("maps command $status without raw command output", ({ status, kind, ...expected }) => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: commandItem,
        startedAtMs: 10,
      }),
    );
    const results = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          ...commandItem,
          status,
          aggregatedOutput: "raw output must-not-cross",
          exitCode: status === "completed" ? 0 : 1,
        },
        completedAtMs: 20,
      }),
    );

    expect(results).toMatchObject([
      { kind: "event", event: { kind, toolCallId: "tool-1", sequence: 43, ...expected } },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/raw command|raw output|provider-command/);
  });

  it("maps a web search item as a visible tool step and completes it with the query", () => {
    const ctx = context();
    const started = map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "webSearch" as const, id: "exec-1", query: "" },
        startedAtMs: 10,
      }),
    );
    expect(started).toMatchObject([
      {
        kind: "event",
        event: { kind: "tool-start", toolCallId: "tool-1", toolName: "Web search" },
      },
      { kind: "event", event: { kind: "tool-progress", toolCallId: "tool-1" } },
    ]);

    const completed = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "webSearch" as const, id: "exec-1", query: "Stavanger weather tomorrow" },
        completedAtMs: 20,
      }),
    );
    expect(completed).toMatchObject([
      {
        kind: "event",
        event: {
          kind: "tool-success",
          toolCallId: "tool-1",
          summary: "Searched: Stavanger weather tomorrow",
        },
      },
    ]);

    // The turn may then complete normally: the search is no longer an active tool.
    expect(
      map(
        ctx,
        notification("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" as const },
        }),
      ),
    ).toMatchObject([{ kind: "event", event: { kind: "completed" } }]);
  });

  it("ignores item types Octant does not model instead of failing the turn", () => {
    const results = map(
      context(),
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "imageView", id: "item-9" } as never,
        startedAtMs: 10,
      }),
    );
    expect(results).toEqual([{ kind: "ignored" }]);
  });

  it.each([
    {
      item: {
        type: "mcpToolCall" as const,
        id: "mcp-1",
        server: "filesystem",
        tool: "read_file",
        status: "completed" as const,
      },
      expected: { kind: "tool-success", summary: "Tool completed." },
    },
    {
      item: {
        type: "dynamicToolCall" as const,
        id: "tool-1",
        namespace: null,
        tool: "inspect",
        status: "failed" as const,
        success: false,
      },
      expected: { kind: "tool-failure", message: "Tool failed." },
    },
  ])("maps completed MCP and dynamic tool terminal states", ({ item, expected }) => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...item, status: "inProgress" },
        startedAtMs: 10,
      }),
    );
    expect(
      map(
        ctx,
        notification("item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item,
          completedAtMs: 20,
        }),
      ),
    ).toMatchObject([{ kind: "event", event: { toolCallId: "tool-1", ...expected } }]);
  });

  it("maps completed file changes to confined relative paths and a sanitized tool result", () => {
    const ctx = context();
    const started = map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "provider-file-1",
          changes: [],
          status: "inProgress",
        },
        startedAtMs: 10,
      }),
    );
    const completed = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "provider-file-1",
          status: "completed",
          changes: [
            { path: "/tmp/project/src/new.ts", kind: { type: "add" }, diff: "+secret" },
            {
              path: "/tmp/project/src/main.ts",
              kind: { type: "update", move_path: null },
              diff: "+secret",
            },
            { path: "src/old.ts", kind: { type: "delete" }, diff: "-secret" },
          ],
        },
        completedAtMs: 20,
      }),
    );

    expect(started).toMatchObject([
      { kind: "event", event: { kind: "tool-start", toolCallId: "tool-1" } },
      { kind: "event", event: { kind: "tool-progress", toolCallId: "tool-1" } },
    ]);
    expect(completed).toMatchObject([
      { kind: "event", event: { kind: "file-change", path: "src/new.ts", change: "created" } },
      {
        kind: "event",
        event: { kind: "file-change", path: "src/main.ts", change: "modified" },
      },
      { kind: "event", event: { kind: "file-change", path: "src/old.ts", change: "deleted" } },
      {
        kind: "event",
        event: { kind: "tool-success", toolCallId: "tool-1", summary: "File change completed." },
      },
    ]);
    expect(JSON.stringify(completed)).not.toMatch(/\/tmp\/project|\+secret|-secret|provider-file/);
  });

  it("fails closed when a file-change item reports a path outside the authorized root", () => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "fileChange", id: "file-1", changes: [], status: "inProgress" },
        startedAtMs: 10,
      }),
    );
    const result = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-1",
          status: "completed",
          changes: [
            {
              path: "/Users/private/outside/secret.txt",
              kind: { type: "update", move_path: null },
              diff: "raw diff must-not-cross",
            },
          ],
        },
        completedAtMs: 20,
      }),
    );

    expect(result).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider reported a file change outside the authorized Project root.",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Users|private|secret\.txt|raw diff|file-1/);
  });

  it.each([
    {
      name: "source traversal",
      path: "../../private/source-secret.txt",
      movePath: null,
      privateValue: "source-secret",
    },
    {
      name: "absolute move destination",
      path: "src/main.ts",
      movePath: "/Users/private/move-secret.txt",
      privateValue: "move-secret",
    },
    {
      name: "move destination traversal",
      path: "src/main.ts",
      movePath: "../../private/traversal-secret.txt",
      privateValue: "traversal-secret",
    },
  ])("fails closed for an outside-root $name", ({ path, movePath, privateValue }) => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "fileChange", id: "file-path-check", changes: [], status: "inProgress" },
        startedAtMs: 10,
      }),
    );

    const result = map(
      ctx,
      notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-path-check",
          status: "completed",
          changes: [
            {
              path,
              kind: { type: "update", move_path: movePath },
              diff: "raw path diff must-not-cross",
            },
          ],
        },
        completedAtMs: 20,
      }),
    );

    expect(result).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider reported a file change outside the authorized Project root.",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${privateValue}|raw path diff|file-path-check`),
    );
  });

  it.each([
    {
      name: "item/started",
      prepare: false,
      message: notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-lifecycle-path",
          status: "inProgress",
          changes: [
            {
              path: "src/main.ts",
              kind: { type: "update", move_path: "../../private/started-secret.txt" },
              diff: "raw started diff",
            },
          ],
        },
        startedAtMs: 10,
      }),
    },
    {
      name: "failed item/completed",
      prepare: true,
      message: notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "file-lifecycle-path",
          status: "failed",
          changes: [
            {
              path: "/Users/private/failed-secret.txt",
              kind: { type: "update", move_path: null },
              diff: "raw failed diff",
            },
          ],
        },
        completedAtMs: 20,
      }),
    },
  ])("validates file-change paths on $name", ({ prepare, message }) => {
    const ctx = context();
    if (prepare) {
      map(
        ctx,
        notification("item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "fileChange",
            id: "file-lifecycle-path",
            changes: [],
            status: "inProgress",
          },
          startedAtMs: 10,
        }),
      );
    }

    const result = map(ctx, message);
    expect(result).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider reported a file change outside the authorized Project root.",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Users|started-secret|failed-secret|raw .* diff/);
  });

  it("maps bounded diffs and rejects oversized diffs without exposing provider content", () => {
    const ok = map(
      context(),
      notification("turn/diff/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: "diff --git a/src/a.ts b/src/a.ts\n+value",
      }),
    );
    const oversized = map(
      context(),
      notification("turn/diff/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        diff: `raw-provider-diff-${"x".repeat(70_000)}`,
      }),
    );

    expect(ok).toMatchObject([
      { kind: "event", event: { kind: "diff", diff: "diff --git a/src/a.ts b/src/a.ts\n+value" } },
    ]);
    expect(oversized).toEqual([
      {
        kind: "protocol-failure",
        failure: { category: "protocol", message: "Provider diff exceeded the supported size." },
      },
    ]);
    expect(JSON.stringify(oversized)).not.toContain("raw-provider-diff");
  });

  it("maps plan steps with stable neutral task IDs and contiguous sequences", () => {
    const ctx = context({ sequence: 7 });
    const first = map(
      ctx,
      notification("turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: "raw explanation must-not-cross",
        plan: [
          { step: "Inspect types", status: "inProgress" },
          { step: "Write mapper", status: "pending" },
        ],
      }),
    );
    const second = map(
      ctx,
      notification("turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        explanation: null,
        plan: [
          { step: "Inspect types", status: "completed" },
          { step: "Write mapper", status: "inProgress" },
        ],
      }),
    );

    expect(first).toMatchObject([
      {
        kind: "event",
        event: {
          kind: "task-progress",
          taskId: "task-1",
          status: "in-progress",
          summary: "Inspect types",
          sequence: 7,
        },
      },
      {
        kind: "event",
        event: {
          kind: "task-progress",
          taskId: "task-2",
          status: "pending",
          summary: "Write mapper",
          sequence: 8,
        },
      },
    ]);
    expect(second).toMatchObject([
      { kind: "event", event: { taskId: "task-1", status: "completed", sequence: 9 } },
      { kind: "event", event: { taskId: "task-2", status: "in-progress", sequence: 10 } },
    ]);
    expect(JSON.stringify([...first, ...second])).not.toContain("raw explanation");
  });

  it("keeps semantic task IDs stable when steps are inserted and reordered", () => {
    const ctx = context();
    const initial = taskEvents(
      map(
        ctx,
        notification("turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Implement mapper", status: "inProgress" },
            { step: "Run checks", status: "pending" },
          ],
        }),
      ),
    );
    const inserted = taskEvents(
      map(
        ctx,
        notification("turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Inspect protocol", status: "completed" },
            { step: "Implement mapper", status: "completed" },
            { step: "Run checks", status: "inProgress" },
          ],
        }),
      ),
    );
    const reordered = taskEvents(
      map(
        ctx,
        notification("turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Run checks", status: "completed" },
            { step: "Implement mapper", status: "completed" },
            { step: "Inspect protocol", status: "completed" },
          ],
        }),
      ),
    );

    expect(initial.map(({ taskId }) => taskId)).toEqual(["task-1", "task-2"]);
    expect(inserted.map(({ taskId }) => taskId)).toEqual(["task-3", "task-1", "task-2"]);
    expect(reordered.map(({ taskId }) => taskId)).toEqual(["task-2", "task-1", "task-3"]);
    for (const event of [...initial, ...inserted, ...reordered]) {
      expect(event.taskId).toMatch(/^task-\d+$/);
      expect(event.taskId).not.toContain(event.summary);
    }
  });

  it("uses occurrence identity for duplicate plan summaries", () => {
    const ctx = context();
    const initial = taskEvents(
      map(
        ctx,
        notification("turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Review", status: "inProgress" },
            { step: "Deploy", status: "pending" },
            { step: "Review", status: "pending" },
          ],
        }),
      ),
    );
    const reordered = taskEvents(
      map(
        ctx,
        notification("turn/plan/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          explanation: null,
          plan: [
            { step: "Review", status: "completed" },
            { step: "Review", status: "inProgress" },
            { step: "Deploy", status: "completed" },
          ],
        }),
      ),
    );

    expect(initial.map(({ taskId }) => taskId)).toEqual(["task-1", "task-2", "task-3"]);
    expect(reordered.map(({ taskId }) => taskId)).toEqual(["task-1", "task-3", "task-2"]);
  });

  it("maps only numeric total usage", () => {
    expect(
      map(
        context(),
        notification("thread/tokenUsage/updated", {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              totalTokens: 20,
              inputTokens: 12,
              cachedInputTokens: 3,
              outputTokens: 8,
              reasoningOutputTokens: 2,
            },
            last: {
              totalTokens: 7,
              inputTokens: 4,
              cachedInputTokens: 1,
              outputTokens: 3,
              reasoningOutputTokens: 1,
            },
            modelContextWindow: 200_000,
          },
        }),
      ),
    ).toMatchObject([
      { kind: "event", event: { kind: "usage", inputTokens: 12, outputTokens: 8 } },
    ]);
  });

  it.each([
    {
      name: "command",
      message: {
        kind: "request" as const,
        id: 9,
        method: "item/commandExecution/requestApproval" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "provider-item-1",
          startedAtMs: 10,
          environmentId: null,
          reason: "raw reason must-not-cross",
          command: "curl account.example/private",
          cwd: "/tmp/project",
        },
      },
      kind: "command",
      action: "command",
    },
    {
      name: "file change",
      message: {
        kind: "request" as const,
        id: "file-request",
        method: "item/fileChange/requestApproval" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "provider-item-2",
          startedAtMs: 10,
          reason: "raw reason must-not-cross",
          grantRoot: null,
        },
      },
      kind: "file-change",
      action: "file change",
    },
    {
      name: "permissions",
      message: {
        kind: "request" as const,
        id: 11,
        method: "item/permissions/requestApproval" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "provider-item-3",
          environmentId: null,
          startedAtMs: 10,
          cwd: "/tmp/project",
          reason: "raw permission reason must-not-cross",
          permissions: { network: { enabled: true }, fileSystem: null },
        },
      },
      kind: "permissions",
      action: "permissions",
    },
  ])("correlates $name approval without granting authority", ({ message, kind, action }) => {
    const ctx = context();
    const [result] = map(ctx, message);

    expect(result).toMatchObject({
      kind: "approval",
      approval: {
        kind,
        requestId: "request-1",
        providerRequestId: message.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: message.params.itemId,
        event: {
          kind: "approval-request",
          requestId: "request-1",
          action,
          description: "Approval is required for this action.",
          sequence: 41,
        },
      },
    });
    expect(result).not.toHaveProperty("approval.approved");
    expect(result).not.toHaveProperty("approval.decision");
    expect(ctx.requestIds.get(message.id)).toBe("request-1");
    expect(JSON.stringify(result)).not.toMatch(/raw reason|curl account/);
    if (result?.kind === "approval" && result.approval.kind === "command") {
      expect(result.approval.requestedCwd).toBe("/tmp/project");
      expect(JSON.stringify(result.approval.event)).not.toContain("/tmp/project");
    }
  });

  it("rejects a duplicate provider approval request ID", () => {
    const ctx = context();
    const message = {
      kind: "request" as const,
      id: 9,
      method: "item/commandExecution/requestApproval" as const,
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        startedAtMs: 10,
        environmentId: null,
      },
    };
    map(ctx, message);

    expect(map(ctx, message)).toEqual([
      {
        kind: "protocol-failure",
        failure: { category: "protocol", message: "Provider repeated an approval request ID." },
      },
    ]);
  });

  it.each([
    {
      status: "interrupted" as const,
      expected: { kind: "interrupted", message: "Provider execution was interrupted." },
    },
    {
      status: "failed" as const,
      expected: {
        kind: "failed",
        failure: { category: "provider-failed", message: "Provider execution failed." },
      },
    },
    {
      status: "completed" as const,
      expected: {
        kind: "completed",
        resumeCursor: { driverKind: "codex", value: "thread-1" },
      },
    },
  ])("maps a $status turn exactly once", ({ status, expected }) => {
    const ctx = context();
    const result = map(
      ctx,
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status },
      }),
    );

    expect(result).toMatchObject([{ kind: "event", event: { ...expected, sequence: 41 } }]);
    expect(ctx.terminal).toBe(true);
  });

  it("keeps accepted partial output followed by failure terminal as failed", () => {
    const ctx = context();
    const partial = map(
      ctx,
      notification("item/agentMessage/delta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "Partial output",
      }),
    );
    const failed = map(
      ctx,
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "failed" },
      }),
    );

    expect(partial).toMatchObject([{ kind: "event", event: { kind: "text-delta" } }]);
    expect(failed).toMatchObject([{ kind: "event", event: { kind: "failed", sequence: 42 } }]);
    expect(failed).not.toMatchObject([{ kind: "event", event: { kind: "completed" } }]);
  });

  it("fails closed on duplicate terminal without consuming another sequence", () => {
    const ctx = context();
    map(
      ctx,
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );

    expect(
      map(
        ctx,
        notification("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "failed" },
        }),
      ),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider emitted more than one terminal event.",
        },
      },
    ]);
    expect(ctx.sequence).toBe(42);
  });

  it("rejects tool lifecycle completion without a matching start", () => {
    expect(
      map(
        context(),
        notification("item/completed", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { ...commandItem, status: "completed" },
          completedAtMs: 20,
        }),
      ),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider completed a tool item that was not started.",
        },
      },
    ]);
  });

  it("rejects a duplicate tool start", () => {
    const ctx = context();
    const started = notification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: commandItem,
      startedAtMs: 10,
    });
    map(ctx, started);

    expect(map(ctx, started)).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider started a tool item more than once.",
        },
      },
    ]);
  });

  it("rejects a duplicate tool completion", () => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: commandItem,
        startedAtMs: 10,
      }),
    );
    const completed = notification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { ...commandItem, status: "completed" },
      completedAtMs: 20,
    });
    map(ctx, completed);

    expect(map(ctx, completed)).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider completed a terminal tool item.",
        },
      },
    ]);
  });

  it.each([
    {
      name: "a terminal status in item/started",
      message: notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { ...commandItem, status: "completed" },
        startedAtMs: 10,
      }),
      expected: "Provider started a tool item with a terminal status.",
    },
    {
      name: "an in-progress status in item/completed",
      message: notification("item/completed", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: commandItem,
        completedAtMs: 20,
      }),
      expected: "Provider completed a tool item with a non-terminal status.",
    },
  ])("rejects $name", ({ message, expected }) => {
    const ctx = context();
    if (message.kind === "notification" && message.method === "item/completed") {
      map(
        ctx,
        notification("item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: commandItem,
          startedAtMs: 10,
        }),
      );
    }
    expect(map(ctx, message)).toEqual([
      { kind: "protocol-failure", failure: { category: "protocol", message: expected } },
    ]);
  });

  it("rejects turn completion while a tool item remains active", () => {
    const ctx = context();
    map(
      ctx,
      notification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: commandItem,
        startedAtMs: 10,
      }),
    );

    expect(
      map(
        ctx,
        notification("turn/completed", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        }),
      ),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider completed the turn while tool items were still active.",
        },
      },
    ]);
    expect(ctx.terminal).toBe(false);
    expect([...ctx.toolStates.values()]).toMatchObject([{ lifecycle: "active" }]);
  });

  it.each([
    {
      status: "failed" as const,
      expected: {
        kind: "failed",
        failure: { category: "provider-failed", message: "Provider execution failed." },
      },
    },
    {
      status: "interrupted" as const,
      expected: { kind: "interrupted", message: "Provider execution was interrupted." },
    },
  ])(
    "preserves an active-tool $status terminal and closes remaining tools",
    ({ status, expected }) => {
      const ctx = context();
      map(
        ctx,
        notification("item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: commandItem,
          startedAtMs: 10,
        }),
      );

      expect(
        map(
          ctx,
          notification("turn/completed", {
            threadId: "thread-1",
            turn: { id: "turn-1", status },
          }),
        ),
      ).toMatchObject([{ kind: "event", event: { ...expected, sequence: 43 } }]);
      expect(ctx.terminal).toBe(true);
      expect([...ctx.toolStates.values()]).toMatchObject([{ lifecycle: "terminal" }]);
      expect(
        map(
          ctx,
          notification("item/agentMessage/delta", {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "late-provider-item",
            delta: "late provider output must-not-cross",
          }),
        ),
      ).toEqual([
        {
          kind: "protocol-failure",
          failure: {
            category: "protocol",
            message: "Provider emitted runtime activity after the terminal event.",
          },
        },
      ]);
    },
  );

  it("rejects a non-running turn start and activity after terminal", () => {
    expect(
      map(
        context(),
        notification("turn/started", {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed" },
        }),
      ),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider returned a non-running turn start status.",
        },
      },
    ]);

    const ctx = context();
    map(
      ctx,
      notification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      }),
    );
    expect(
      map(
        ctx,
        notification("item/agentMessage/delta", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "late-item",
          delta: "late raw output must-not-cross",
        }),
      ),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider emitted runtime activity after the terminal event.",
        },
      },
    ]);
  });

  it("ignores unrelated unknown notifications but fails an unknown required transition", () => {
    expect(map(context(), { kind: "unknown-notification", method: "account/updated" })).toEqual([
      { kind: "ignored" },
    ]);
    expect(map(context(), { kind: "unknown-notification", method: "turn/cancelled" })).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider emitted an unsupported active runtime notification.",
        },
      },
    ]);
  });

  it("fails mismatched active correlations without leaking provider data", () => {
    const failure = map(
      context(),
      notification("item/agentMessage/delta", {
        threadId: "other-thread-account@example.test",
        turnId: "other-turn-/Users/private",
        itemId: "raw-item",
        delta: "raw prompt must-not-cross",
      }),
    );

    expect(failure).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Provider message did not match the active thread and turn.",
        },
      },
    ]);
    expect(JSON.stringify(failure)).not.toMatch(
      /other-thread|account@example|other-turn|Users|private|raw-item|raw prompt/,
    );
  });

  it.each([
    { kind: "response" as const, id: 1, result: { account: "private@example.test" } },
    { kind: "unsupported-request" as const, id: 2, method: "item/tool/requestUserInput" },
  ])("honestly rejects a mapper input that Task 2/transport must handle elsewhere", (message) => {
    const failure = map(context(), message);
    expect(failure).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "unsupported",
          message: "Provider message is not supported by the stable Codex adapter.",
        },
      },
    ]);
    expect(JSON.stringify(failure)).not.toMatch(/private@example|requestUserInput/);
  });

  it("ignores benign lifecycle items that have no normalized runtime representation", () => {
    expect(
      map(
        context(),
        notification("item/started", {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "contextCompaction", id: "provider-compaction" },
          startedAtMs: 10,
        }),
      ),
    ).toEqual([{ kind: "ignored" }]);
  });
});
