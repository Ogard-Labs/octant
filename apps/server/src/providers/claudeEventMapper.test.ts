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
  mapClaudeMessage,
  mapClaudeToolRequest,
  type ClaudeEventContext,
  type ClaudeMappedMessage,
} from "./claudeEventMapper";
import type { ClaudeDecodedMessage, ClaudeToolRequest, ClaudeUsage } from "./claudeAgentSdkPort";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000091");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000092");
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "80000000-0000-4000-8000-000000000093",
);
const occurredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-16T10:00:00.000Z");
const projectRoot = "/repo";
const claudeSessionId = "sdk-session-private";

const usage: ClaudeUsage = {
  inputTokens: 12,
  outputTokens: 7,
  cacheCreationInputTokens: 2,
  cacheReadInputTokens: 3,
};

function context(overrides: Partial<ClaudeEventContext> = {}): ClaudeEventContext {
  let request = 0;
  let task = 0;
  let tool = 0;
  return {
    instanceId,
    sessionId,
    correlationId,
    occurredAt,
    projectRoot,
    isProjectConfinedPath: () => true,
    claudeSessionId,
    sequence: 41,
    terminal: false,
    requestIds: new Map(),
    taskIds: new Map(),
    toolStates: new Map(),
    makeRequestId: () => `request-${++request}`,
    makeTaskId: () => `task-${++task}`,
    makeToolCallId: () => `tool-${++tool}`,
    ...overrides,
  };
}

function mapped(
  ctx: ClaudeEventContext,
  message: ClaudeDecodedMessage,
): ReadonlyArray<ClaudeMappedMessage> {
  return mapClaudeMessage(ctx, message).map(
    (result): ClaudeMappedMessage =>
      result.kind === "event"
        ? { kind: "event", event: decodeProviderRuntimeEvent(result.event) }
        : result,
  );
}

function eventValues(results: ReadonlyArray<ClaudeMappedMessage>) {
  return results.flatMap((result) => (result.kind === "event" ? [result.event] : []));
}

function toolRequest(overrides: Partial<ClaudeToolRequest> = {}): ClaudeToolRequest {
  return {
    toolName: "Bash",
    toolUseId: "sdk-tool-private",
    requestId: "sdk-request-private",
    input: { command: "printf hello" },
    blockedPath: "/outside/private-must-not-cross",
    title: "Raw title must-not-cross",
    displayName: "Raw display must-not-cross",
    description: "Raw description must-not-cross",
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("mapClaudeMessage", () => {
  it.each([
    {
      name: "assistant text",
      message: {
        kind: "stream-event",
        sessionId: claudeSessionId,
        event: { kind: "text-delta", index: 0, text: "Hello" },
      } satisfies ClaudeDecodedMessage,
      expected: { kind: "text-delta", text: "Hello" },
    },
    {
      name: "assistant reasoning",
      message: {
        kind: "stream-event",
        sessionId: claudeSessionId,
        event: { kind: "reasoning-delta", index: 1, text: "Checking constraints" },
      } satisfies ClaudeDecodedMessage,
      expected: { kind: "reasoning-delta", text: "Checking constraints" },
    },
  ])("maps $name with provider-neutral envelope identity", ({ message, expected }) => {
    const [result] = mapped(context(), message);

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
    expect(JSON.stringify(result)).not.toContain(claudeSessionId);
  });

  it.each(["text-delta", "reasoning-delta"] as const)(
    "chunks %s at Unicode code-point boundaries without loss",
    (kind) => {
      const ctx = context();
      const source = `${"x".repeat(65_535)}😀y`;

      const results = mapped(ctx, {
        kind: "stream-event",
        sessionId: claudeSessionId,
        event: { kind, index: 0, text: source },
      });
      const chunks = eventValues(results).map((value) => (value.kind === kind ? value.text : ""));

      expect(chunks).toHaveLength(2);
      expect(chunks.join("")).toBe(source);
      expect(chunks.map((chunk) => Array.from(chunk).length)).toEqual([65_536, 1]);
      expect(chunks.join("")).not.toContain("�");
    },
  );

  it("maps tool start, bounded progress, and sanitized success/failure results", () => {
    const ctx = context();
    const started = mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: {
        kind: "content-start",
        index: 0,
        content: {
          kind: "tool-use",
          toolUseId: "sdk-tool-1",
          toolName: "Bash",
          input: { command: "private command must-not-cross" },
        },
      },
    });
    const progress = mapped(ctx, {
      kind: "tool-progress",
      sessionId: claudeSessionId,
      toolUseId: "sdk-tool-1",
      toolName: "Bash",
      elapsedSeconds: 1.75,
      taskId: "sdk-task-private",
    });
    const succeeded = mapped(ctx, {
      kind: "tool-results",
      sessionId: claudeSessionId,
      results: [{ toolUseId: "sdk-tool-1", isError: false }],
    });
    const secondStarted = mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: {
        kind: "content-start",
        index: 1,
        content: {
          kind: "tool-use",
          toolUseId: "sdk-tool-2",
          toolName: "Read",
          input: { file_path: "/repo/private-input-must-not-cross" },
        },
      },
    });
    const failed = mapped(ctx, {
      kind: "tool-results",
      sessionId: claudeSessionId,
      results: [{ toolUseId: "sdk-tool-2", isError: true }],
    });

    expect(started).toMatchObject([
      { kind: "event", event: { kind: "tool-start", toolCallId: "tool-1", toolName: "Bash" } },
    ]);
    expect(progress).toMatchObject([
      {
        kind: "event",
        event: { kind: "tool-progress", toolCallId: "tool-1", message: "Tool is running." },
      },
    ]);
    expect(succeeded).toMatchObject([
      {
        kind: "event",
        event: { kind: "tool-success", toolCallId: "tool-1", summary: "Tool completed." },
      },
    ]);
    expect(secondStarted).toMatchObject([
      { kind: "event", event: { kind: "tool-start", toolCallId: "tool-2", toolName: "Read" } },
    ]);
    expect(failed).toMatchObject([
      {
        kind: "event",
        event: { kind: "tool-failure", toolCallId: "tool-2", message: "Tool failed." },
      },
    ]);
    expect(JSON.stringify([started, progress, succeeded, secondStarted, failed])).not.toMatch(
      /sdk-tool|sdk-task|private command|private-input/,
    );
  });

  it("uses one Unicode-safe bounded tool label across streamed and authoritative tool-use", () => {
    const ctx = context();
    const toolName = `${"T".repeat(255)}😀private-suffix`;
    const started = mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: {
        kind: "content-start",
        index: 0,
        content: { kind: "tool-use", toolUseId: "sdk-tool-long", toolName, input: {} },
      },
    });
    const authoritative = mapped(ctx, {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [{ kind: "tool-use", toolUseId: "sdk-tool-long", toolName, input: {} }],
      usage,
    });
    const label = eventValues(started)[0];

    expect(label).toMatchObject({ kind: "tool-start" });
    if (label?.kind !== "tool-start") throw new Error("Expected tool-start event");
    expect(Array.from(label.toolName)).toHaveLength(256);
    expect(label.toolName.endsWith("…")).toBe(true);
    expect(authoritative).toMatchObject([
      { kind: "event", event: { kind: "usage", inputTokens: 12, outputTokens: 7 } },
    ]);
    expect(JSON.stringify([started, authoritative])).not.toContain("private-suffix");
  });

  it("ignores raw provider tool summaries regardless of Unicode length", () => {
    const ctx = context();
    const rawSummary = `${"😀".repeat(1_025)}private-tool-output`;
    const sequenceBefore = ctx.sequence;

    const results = mapped(ctx, {
      kind: "tool-summary",
      sessionId: claudeSessionId,
      summary: rawSummary,
      toolUseIds: ["sdk-tool-private"],
    });

    expect(results).toEqual([{ kind: "ignored" }]);
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(JSON.stringify(results)).not.toContain("private-tool-output");
  });

  it("protocol-fails unknown tool progress without synthesizing tool state or start", () => {
    const ctx = context();

    const results = mapped(ctx, {
      kind: "tool-progress",
      sessionId: claudeSessionId,
      toolUseId: "sdk-tool-unknown",
      toolName: "Bash",
      elapsedSeconds: 1,
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude tool progress did not match an active tool.",
        },
      },
    ]);
    expect(ctx.toolStates).toHaveLength(0);
    expect(ctx.sequence).toBe(41);
  });

  it.each([
    {
      name: "duplicate successful entries",
      results: [
        { toolUseId: "sdk-tool-duplicate", isError: false },
        { toolUseId: "sdk-tool-duplicate", isError: false },
      ],
    },
    {
      name: "contradictory success and error entries",
      results: [
        { toolUseId: "sdk-tool-duplicate", isError: false },
        { toolUseId: "sdk-tool-duplicate", isError: true },
      ],
    },
  ])("rejects $name atomically before tool state or sequence mutation", ({ results }) => {
    const ctx = context();
    mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: {
        kind: "content-start",
        index: 0,
        content: {
          kind: "tool-use",
          toolUseId: "sdk-tool-duplicate",
          toolName: "Read",
          input: {},
        },
      },
    });
    const sequenceBefore = ctx.sequence;

    const mappedResults = mapped(ctx, {
      kind: "tool-results",
      sessionId: claudeSessionId,
      results,
    });

    expect(mappedResults).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned duplicate or contradictory tool results.",
        },
      },
    ]);
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(ctx.toolStates.get("sdk-tool-duplicate")?.lifecycle).toBe("active");
  });

  it("emits authoritative confined Edit and Write changes only after successful results", () => {
    const checkedPaths: string[] = [];
    const ctx = context({
      isProjectConfinedPath: (absolutePath) => {
        checkedPaths.push(absolutePath);
        return true;
      },
    });
    const started = mapped(ctx, {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [
        {
          kind: "tool-use",
          toolUseId: "sdk-edit-private",
          toolName: "Edit",
          input: {
            file_path: "/repo/src/app.ts",
            old_string: "fixture-prompt-must-not-cross",
            new_string: "sk-ant-fixture-api-key-must-not-cross",
            rawSecret: "raw-tool-input-must-not-cross",
          },
        },
        {
          kind: "tool-use",
          toolUseId: "sdk-write-private",
          toolName: "Write",
          input: {
            file_path: "src/new.ts",
            content: "fixture-command-output-must-not-cross",
            rawSecret: "raw-write-input-must-not-cross",
          },
        },
      ],
      usage,
    });
    const completed = mapped(ctx, {
      kind: "tool-results",
      sessionId: claudeSessionId,
      results: [
        { toolUseId: "sdk-edit-private", isError: false },
        { toolUseId: "sdk-write-private", isError: false },
      ],
    });
    const events = eventValues(completed);

    expect(started).toMatchObject([
      { kind: "event", event: { kind: "tool-start", toolCallId: "tool-1", toolName: "Edit" } },
      { kind: "event", event: { kind: "tool-start", toolCallId: "tool-2", toolName: "Write" } },
      { kind: "event", event: { kind: "usage", inputTokens: 12, outputTokens: 7 } },
    ]);
    expect(events).toMatchObject([
      { kind: "file-change", path: "src/app.ts", change: "modified" },
      { kind: "diff", diff: expect.stringContaining("@@ Claude Edit (content redacted) @@") },
      { kind: "tool-success", toolCallId: "tool-1", summary: "File edit completed." },
      { kind: "file-change", path: "src/new.ts", change: "modified" },
      { kind: "diff", diff: expect.stringContaining("@@ Claude Write (content redacted) @@") },
      { kind: "tool-success", toolCallId: "tool-2", summary: "File write completed." },
    ]);
    expect(JSON.stringify([started, completed])).not.toMatch(
      /sdk-(message|edit|write)|raw-tool-input|raw-write-input|fixture-prompt|fixture-command-output|sk-ant-fixture/,
    );
    expect(checkedPaths).toEqual(["/repo/src/app.ts", "/repo/src/new.ts"]);
  });

  it.each([
    {
      name: "identical",
      repeatedInput: {
        file_path: "/repo/src/app.ts",
        old_string: "private old",
        new_string: "private new",
      },
    },
    {
      name: "changed",
      repeatedInput: {
        file_path: "/repo/src/changed.ts",
        old_string: "different private old",
        new_string: "different private new",
      },
    },
  ])(
    "rejects $name duplicate authoritative metadata within one assistant message atomically",
    ({ repeatedInput }) => {
      const checkedPaths: string[] = [];
      const ctx = context({
        isProjectConfinedPath: (absolutePath) => {
          checkedPaths.push(absolutePath);
          return true;
        },
      });

      const results = mapped(ctx, {
        kind: "assistant",
        sessionId: claudeSessionId,
        messageId: "sdk-message-private",
        content: [
          {
            kind: "tool-use",
            toolUseId: "sdk-edit-duplicate",
            toolName: "Edit",
            input: {
              file_path: "/repo/src/app.ts",
              old_string: "private old",
              new_string: "private new",
            },
          },
          {
            kind: "tool-use",
            toolUseId: "sdk-edit-duplicate",
            toolName: "Edit",
            input: repeatedInput,
          },
        ],
        usage,
      });

      expect(results).toEqual([
        {
          kind: "failure",
          failure: {
            category: "protocol",
            message: "Claude returned duplicate authoritative file metadata.",
          },
        },
      ]);
      expect(checkedPaths).toHaveLength(0);
      expect(ctx.sequence).toBe(41);
      expect(ctx.toolStates).toHaveLength(0);
    },
  );

  it.each([
    {
      name: "identical",
      repeatedInput: {
        file_path: "/repo/src/app.ts",
        old_string: "private old",
        new_string: "private new",
      },
    },
    {
      name: "changed",
      repeatedInput: {
        file_path: "/repo/src/changed.ts",
        old_string: "different private old",
        new_string: "different private new",
      },
    },
  ])(
    "rejects $name authoritative metadata repeated across assistant messages without overwrite",
    ({ repeatedInput }) => {
      const checkedPaths: string[] = [];
      const ctx = context({
        isProjectConfinedPath: (absolutePath) => {
          checkedPaths.push(absolutePath);
          return true;
        },
      });
      mapped(ctx, {
        kind: "assistant",
        sessionId: claudeSessionId,
        messageId: "sdk-message-first",
        content: [
          {
            kind: "tool-use",
            toolUseId: "sdk-edit-repeated",
            toolName: "Edit",
            input: {
              file_path: "/repo/src/app.ts",
              old_string: "private old",
              new_string: "private new",
            },
          },
        ],
        usage,
      });
      const acceptedState = ctx.toolStates.get("sdk-edit-repeated");
      const acceptedMetadata = acceptedState?.fileChange;
      const sequenceBefore = ctx.sequence;

      const results = mapped(ctx, {
        kind: "assistant",
        sessionId: claudeSessionId,
        messageId: "sdk-message-repeated",
        content: [
          {
            kind: "tool-use",
            toolUseId: "sdk-edit-repeated",
            toolName: "Edit",
            input: repeatedInput,
          },
        ],
        usage,
      });

      expect(results).toEqual([
        {
          kind: "failure",
          failure: {
            category: "protocol",
            message: "Claude returned duplicate authoritative file metadata.",
          },
        },
      ]);
      expect(checkedPaths).toEqual(["/repo/src/app.ts"]);
      expect(ctx.sequence).toBe(sequenceBefore);
      expect(ctx.toolStates.get("sdk-edit-repeated")).toBe(acceptedState);
      expect(ctx.toolStates.get("sdk-edit-repeated")?.fileChange).toBe(acceptedMetadata);
      expect(ctx.toolStates.get("sdk-edit-repeated")?.lifecycle).toBe("active");
    },
  );

  it("fails closed without exposing an outside-root file path", () => {
    const outsidePath = "/private/outside-root-secret.ts";
    const results = mapped(context(), {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [
        {
          kind: "tool-use",
          toolUseId: "sdk-write-private",
          toolName: "Write",
          input: { file_path: outsidePath, content: "private content" },
        },
      ],
      usage,
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned invalid file-change metadata.",
        },
      },
    ]);
    expect(JSON.stringify(results)).not.toContain(outsidePath);
  });

  it("fails closed when Project authority denies a lexically confined file path", () => {
    const checkedPaths: string[] = [];
    const ctx = context({
      isProjectConfinedPath: (absolutePath) => {
        checkedPaths.push(absolutePath);
        return false;
      },
    });
    const sequenceBefore = ctx.sequence;
    const deniedPath = "src/symlink/private.ts";

    const results = mapped(ctx, {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [
        {
          kind: "tool-use",
          toolUseId: "sdk-write-private",
          toolName: "Write",
          input: { file_path: deniedPath, content: "private content" },
        },
      ],
      usage,
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned invalid file-change metadata.",
        },
      },
    ]);
    expect(checkedPaths).toEqual(["/repo/src/symlink/private.ts"]);
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(ctx.toolStates).toHaveLength(0);
    expect(JSON.stringify(results)).not.toContain(deniedPath);
  });

  it("fails closed on contradictory tool correlation without emitting partial events", () => {
    const ctx = context();
    mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: {
        kind: "content-start",
        index: 0,
        content: {
          kind: "tool-use",
          toolUseId: "sdk-tool-conflict",
          toolName: "Read",
          input: {},
        },
      },
    });

    const results = mapped(ctx, {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [
        {
          kind: "tool-use",
          toolUseId: "sdk-tool-conflict",
          toolName: "Bash",
          input: { command: "private command must-not-cross" },
        },
      ],
      usage,
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned invalid tool correlation metadata.",
        },
      },
    ]);
    expect(JSON.stringify(results)).not.toMatch(/private command|sdk-tool-conflict/);
  });

  it.each([
    { name: "negative input", field: "inputTokens" as const, value: -1 },
    { name: "fractional output", field: "outputTokens" as const, value: 1.5 },
    {
      name: "non-finite cache creation",
      field: "cacheCreationInputTokens" as const,
      value: Infinity,
    },
    {
      name: "unsafe cache read",
      field: "cacheReadInputTokens" as const,
      value: Number.MAX_SAFE_INTEGER + 1,
    },
  ])("rejects $name usage before assistant tool state or event mutation", ({ field, value }) => {
    const ctx = context();

    const results = mapped(ctx, {
      kind: "assistant",
      sessionId: claudeSessionId,
      messageId: "sdk-message-private",
      content: [
        {
          kind: "tool-use",
          toolUseId: "sdk-tool-unsafe-usage",
          toolName: "Read",
          input: {},
        },
      ],
      usage: { ...usage, [field]: value },
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: { category: "protocol", message: "Claude returned invalid usage metadata." },
      },
    ]);
    expect(ctx.sequence).toBe(41);
    expect(ctx.toolStates).toHaveLength(0);
  });

  it("normalizes task progress with provider-neutral task IDs and bounded summaries", () => {
    const ctx = context();
    const started = mapped(ctx, {
      kind: "task",
      sessionId: claudeSessionId,
      subtype: "task_started",
      taskId: "sdk-task-private",
      description: "Implement the mapper",
    });
    const finished = mapped(ctx, {
      kind: "task",
      sessionId: claudeSessionId,
      subtype: "task_notification",
      taskId: "sdk-task-private",
      status: "completed",
      summary: "Mapper implemented",
      usage: { totalTokens: 19, toolUses: 2, durationMs: 25 },
    });

    expect([started, finished]).toMatchObject([
      [
        {
          kind: "event",
          event: {
            kind: "task-progress",
            taskId: "task-1",
            status: "in-progress",
            summary: "Implement the mapper",
          },
        },
      ],
      [
        {
          kind: "event",
          event: {
            kind: "task-progress",
            taskId: "task-1",
            status: "completed",
            summary: "Mapper implemented",
          },
        },
      ],
    ]);
    expect(JSON.stringify([started, finished])).not.toContain("sdk-task-private");
  });

  it("truncates task summaries at a Unicode code-point boundary", () => {
    const description = `${"x".repeat(1_023)}😀private-suffix`;
    const [result] = mapped(context(), {
      kind: "task",
      sessionId: claudeSessionId,
      subtype: "task_started",
      taskId: "sdk-task-private",
      description,
    });
    if (result?.kind !== "event" || result.event.kind !== "task-progress") {
      throw new Error("Expected task-progress event");
    }
    const summary = result.event.summary;

    expect(Array.from(summary)).toHaveLength(1_024);
    expect(summary.endsWith("…")).toBe(true);
    expect(summary).not.toContain("�");
    expect(summary).not.toContain("private-suffix");
  });

  it("tracks a valid task pause, resume, progress, and completion lifecycle", () => {
    const ctx = context();
    const messages: ClaudeDecodedMessage[] = [
      {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_started",
        taskId: "sdk-task-lifecycle",
        description: "Run lifecycle",
      },
      {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_updated",
        taskId: "sdk-task-lifecycle",
        status: "paused",
      },
      {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_updated",
        taskId: "sdk-task-lifecycle",
        status: "running",
      },
      {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_progress",
        taskId: "sdk-task-lifecycle",
        description: "Still running",
        usage: { totalTokens: 10, toolUses: 1, durationMs: 5 },
      },
      {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_notification",
        taskId: "sdk-task-lifecycle",
        status: "completed",
        summary: "Finished",
      },
    ];

    const results = messages.map((message) => mapped(ctx, message));

    expect(results).toMatchObject([
      [{ kind: "event", event: { taskId: "task-1", status: "in-progress" } }],
      [{ kind: "event", event: { taskId: "task-1", status: "pending" } }],
      [{ kind: "event", event: { taskId: "task-1", status: "in-progress" } }],
      [
        {
          kind: "event",
          event: { taskId: "task-1", status: "in-progress", summary: "Still running" },
        },
      ],
      [
        {
          kind: "event",
          event: { taskId: "task-1", status: "completed", summary: "Finished" },
        },
      ],
    ]);
  });

  it.each([
    {
      name: "progress before start",
      before: [] as ClaudeDecodedMessage[],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_progress",
        taskId: "sdk-task-invalid",
        description: "not started",
        usage: { totalTokens: 1, toolUses: 0, durationMs: 1 },
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "duplicate start",
      before: [
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_started",
          taskId: "sdk-task-invalid",
          description: "started",
        } satisfies ClaudeDecodedMessage,
      ],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_started",
        taskId: "sdk-task-invalid",
        description: "started twice",
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "running to pending regression",
      before: [
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_started",
          taskId: "sdk-task-invalid",
          description: "started",
        } satisfies ClaudeDecodedMessage,
      ],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_updated",
        taskId: "sdk-task-invalid",
        status: "pending",
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "progress after completion",
      before: [
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_started",
          taskId: "sdk-task-invalid",
          description: "started",
        } satisfies ClaudeDecodedMessage,
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_notification",
          taskId: "sdk-task-invalid",
          status: "completed",
          summary: "done",
        } satisfies ClaudeDecodedMessage,
      ],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_progress",
        taskId: "sdk-task-invalid",
        description: "late",
        usage: { totalTokens: 1, toolUses: 0, durationMs: 1 },
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "contradictory terminal notification",
      before: [
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_started",
          taskId: "sdk-task-invalid",
          description: "started",
        } satisfies ClaudeDecodedMessage,
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_updated",
          taskId: "sdk-task-invalid",
          status: "completed",
        } satisfies ClaudeDecodedMessage,
      ],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_notification",
        taskId: "sdk-task-invalid",
        status: "failed",
        summary: "failed",
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "unknown subtype",
      before: [] as ClaudeDecodedMessage[],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_future",
        taskId: "sdk-task-invalid",
        description: "future",
      } as unknown as ClaudeDecodedMessage,
    },
    {
      name: "unknown status",
      before: [
        {
          kind: "task",
          sessionId: claudeSessionId,
          subtype: "task_started",
          taskId: "sdk-task-invalid",
          description: "started",
        } satisfies ClaudeDecodedMessage,
      ],
      invalid: {
        kind: "task",
        sessionId: claudeSessionId,
        subtype: "task_updated",
        taskId: "sdk-task-invalid",
        status: "future",
      } as unknown as ClaudeDecodedMessage,
    },
  ])("protocol-fails invalid task lifecycle: $name", ({ before, invalid }) => {
    const ctx = context();
    for (const message of before) mapped(ctx, message);
    const sequenceBefore = ctx.sequence;
    const stateBefore = ctx.taskIds.get("sdk-task-invalid");

    const results = mapped(ctx, invalid);

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned an invalid task lifecycle transition.",
        },
      },
    ]);
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(ctx.taskIds.get("sdk-task-invalid")).toEqual(stateBefore);
  });

  it("maps rejected rate limits with bounded retry timing and terminates once", () => {
    const ctx = context();
    const results = mapped(ctx, {
      kind: "rate-limit",
      sessionId: claudeSessionId,
      status: "rejected",
      resetsAt: Date.parse(occurredAt) + 120_000,
      rateLimitType: "five_hour",
      utilization: 1,
    });

    expect(results).toMatchObject([
      {
        kind: "event",
        event: { kind: "rate-limit-window", window: "five_hour", status: "exhausted" },
      },
      {
        kind: "event",
        event: {
          kind: "failed",
          failure: {
            category: "rate-limited",
            message: "Claude is temporarily rate limited.",
            retryAfterMs: 120_000,
          },
        },
      },
    ]);
    expect(ctx.terminal).toBe(true);
  });

  it("reports a usage window that is filling up without failing the turn", () => {
    const ctx = context();
    const resetsAt = Date.parse(occurredAt) + 3_600_000;
    const results = mapped(ctx, {
      kind: "rate-limit",
      sessionId: claudeSessionId,
      status: "allowed_warning",
      resetsAt,
      rateLimitType: "seven_day",
      utilization: 0.87,
    });

    // A warning is a fact about the account, not a turn outcome: the thread
    // must learn the window is closing in and keep running.
    expect(results).toMatchObject([
      {
        kind: "event",
        event: {
          kind: "rate-limit-window",
          window: "seven_day",
          status: "warning",
          utilization: 0.87,
          resetsAt: new Date(resetsAt).toISOString(),
        },
      },
    ]);
    expect(ctx.terminal).toBe(false);
  });

  it.each([
    {
      name: "result usage",
      message: {
        kind: "result",
        sessionId: claudeSessionId,
        outcome: "success",
        subtype: "success",
        stopReason: "end_turn",
        terminalReason: "completed",
        usage: { ...usage, outputTokens: Number.MAX_SAFE_INTEGER + 1 },
        permissionDenials: [],
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "stream-start usage",
      message: {
        kind: "stream-event",
        sessionId: claudeSessionId,
        event: {
          kind: "message-start",
          messageId: "sdk-message-private",
          model: "claude-sonnet",
          usage: { ...usage, inputTokens: 0.5 },
        },
      } satisfies ClaudeDecodedMessage,
    },
    {
      name: "stream-delta usage",
      message: {
        kind: "stream-event",
        sessionId: claudeSessionId,
        event: {
          kind: "message-delta",
          stopReason: null,
          usage: { ...usage, cacheReadInputTokens: -1 },
        },
      } satisfies ClaudeDecodedMessage,
    },
  ])("protocol-fails unsafe $name without terminal or sequence mutation", ({ message }) => {
    const ctx = context();

    const results = mapped(ctx, message);

    expect(results).toEqual([
      {
        kind: "failure",
        failure: { category: "protocol", message: "Claude returned invalid usage metadata." },
      },
    ]);
    expect(ctx.sequence).toBe(41);
    expect(ctx.terminal).toBe(false);
  });

  it("protocol-fails unsafe task usage without advancing task state", () => {
    const ctx = context();
    mapped(ctx, {
      kind: "task",
      sessionId: claudeSessionId,
      subtype: "task_started",
      taskId: "sdk-task-unsafe-usage",
      description: "Started",
    });
    const sequenceBefore = ctx.sequence;
    const stateBefore = ctx.taskIds.get("sdk-task-unsafe-usage");

    const results = mapped(ctx, {
      kind: "task",
      sessionId: claudeSessionId,
      subtype: "task_progress",
      taskId: "sdk-task-unsafe-usage",
      description: "Unsafe",
      usage: { totalTokens: Number.MAX_SAFE_INTEGER + 1, toolUses: 1, durationMs: 1 },
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: { category: "protocol", message: "Claude returned invalid usage metadata." },
      },
    ]);
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(ctx.taskIds.get("sdk-task-unsafe-usage")).toEqual(stateBefore);
  });

  it("carries Claude's own turn cost onto the usage event", () => {
    const ctx = context();

    const results = mapped(ctx, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "success",
      subtype: "success",
      stopReason: "end_turn",
      usage,
      totalCostUsd: 0.0421,
      permissionDenials: [],
    });

    // The price is Claude's figure. Octant holds no price list, so this is the
    // only way a cost can reach the thread at all.
    expect(results[0]).toMatchObject({
      kind: "event",
      event: { kind: "usage", inputTokens: 12, outputTokens: 7, costUsd: 0.0421 },
    });
  });

  it("maps interruption and successful completion as exactly one terminal transition", () => {
    const interruptedContext = context();
    const interrupted = mapped(interruptedContext, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "error",
      subtype: "error_during_execution",
      stopReason: null,
      terminalReason: "aborted_streaming",
      usage,
      permissionDenials: [],
    });

    expect(interrupted).toMatchObject([
      { kind: "event", event: { kind: "usage", inputTokens: 12, outputTokens: 7 } },
      {
        kind: "event",
        event: { kind: "interrupted", message: "Claude execution was interrupted." },
      },
    ]);

    const completedContext = context();
    const completed = mapped(completedContext, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "success",
      subtype: "success",
      stopReason: "end_turn",
      terminalReason: "completed",
      usage,
      permissionDenials: [],
    });
    const duplicate = mapped(completedContext, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "success",
      subtype: "success",
      stopReason: "end_turn",
      terminalReason: "completed",
      usage,
      permissionDenials: [],
    });

    expect(completed).toMatchObject([
      { kind: "event", event: { kind: "usage", inputTokens: 12, outputTokens: 7 } },
      {
        kind: "event",
        event: {
          kind: "completed",
          resumeCursor: { driverKind: "claude", value: claudeSessionId },
        },
      },
    ]);
    expect(duplicate).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned a duplicate terminal message.",
        },
      },
    ]);
  });

  it("completes a turn in which a tool was denied instead of calling it contradictory", () => {
    const ctx = context();
    const results = mapped(ctx, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "success",
      subtype: "success",
      stopReason: null,
      terminalReason: "completed",
      usage,
      permissionDenials: [{ toolName: "Bash", toolUseId: "sdk-denied" }],
    });

    // The person said no at the approval and the model finished without the
    // tool; that is an ordinary end, not a protocol failure.
    expect(
      results.map((result) => (result.kind === "event" ? result.event.kind : result.kind)),
    ).toEqual(["usage", "completed"]);
  });

  it.each([
    {
      name: "success subtype with error outcome",
      outcome: "error" as const,
      subtype: "success" as const,
      terminalReason: "completed",
      permissionDenials: [],
    },
    {
      name: "success with interruption reason",
      outcome: "success" as const,
      subtype: "success" as const,
      terminalReason: "aborted_streaming",
      permissionDenials: [],
    },
    {
      name: "max-turn subtype with budget reason",
      outcome: "error" as const,
      subtype: "error_max_turns" as const,
      terminalReason: "budget_exhausted",
      permissionDenials: [],
    },
    {
      name: "execution error with completed reason",
      outcome: "error" as const,
      subtype: "error_during_execution" as const,
      terminalReason: "completed",
      permissionDenials: [],
    },
    {
      name: "specialized error with permission denial",
      outcome: "error" as const,
      subtype: "error_max_budget_usd" as const,
      terminalReason: "budget_exhausted",
      permissionDenials: [{ toolName: "Bash", toolUseId: "sdk-denied" }],
    },
  ])("rejects contradictory terminal metadata: $name", (invalid) => {
    const ctx = context();

    const results = mapped(ctx, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: invalid.outcome,
      subtype: invalid.subtype,
      stopReason: null,
      terminalReason: invalid.terminalReason,
      usage,
      permissionDenials: invalid.permissionDenials,
    });

    expect(results).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned contradictory result metadata.",
        },
      },
    ]);
    expect(ctx.sequence).toBe(41);
    expect(ctx.terminal).toBe(false);
  });

  it("preserves partial output but maps a later provider error to failed, never completed", () => {
    const ctx = context();
    const partial = mapped(ctx, {
      kind: "stream-event",
      sessionId: claudeSessionId,
      event: { kind: "text-delta", index: 0, text: "Partial answer" },
    });
    const failure = mapped(ctx, {
      kind: "result",
      sessionId: claudeSessionId,
      outcome: "error",
      subtype: "error_during_execution",
      stopReason: null,
      terminalReason: "model_error",
      usage,
      permissionDenials: [],
    });

    expect(partial).toMatchObject([
      { kind: "event", event: { kind: "text-delta", text: "Partial answer" } },
    ]);
    expect(failure).toMatchObject([
      { kind: "event", event: { kind: "usage" } },
      {
        kind: "event",
        event: {
          kind: "failed",
          failure: {
            category: "provider-failed",
            message: "Claude execution failed.",
          },
        },
      },
    ]);
    expect(eventValues(failure).some((event) => event.kind === "completed")).toBe(false);
  });

  it("classifies mismatched and unknown active decoded messages as sanitized protocol failures", () => {
    const mismatched = mapped(context(), {
      kind: "status",
      sessionId: "wrong-private-session",
      status: "requesting",
    });
    const unknown = mapped(context(), {
      kind: "future-active-message",
      rawMessage: { secret: "raw-sdk-object-must-not-cross" },
    } as unknown as ClaudeDecodedMessage);

    expect(mismatched).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude message did not match the active session.",
        },
      },
    ]);
    expect(unknown).toEqual([
      {
        kind: "failure",
        failure: {
          category: "protocol",
          message: "Claude returned an unsupported decoded message.",
        },
      },
    ]);
    expect(JSON.stringify([mismatched, unknown])).not.toMatch(/wrong-private|raw-sdk-object/);
  });

  it("ignores only Task 4's validated ignored decoded message", () => {
    expect(mapped(context(), { kind: "ignored" })).toEqual([{ kind: "ignored" }]);
  });
});

describe("mapClaudeToolRequest", () => {
  it("creates a provider-neutral approval event and sanitized pending correlation record", () => {
    const result = mapClaudeToolRequest(context(), toolRequest());

    expect(result).toMatchObject({
      kind: "approval",
      request: {
        requestId: "request-1",
        providerSessionId: claudeSessionId,
        providerToolUseId: "sdk-tool-private",
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        event: {
          kind: "approval-request",
          requestId: "request-1",
          action: "Bash",
          description: "Bash · printf hello",
          instanceId,
          sessionId,
          sequence: 41,
          correlationId,
          occurredAt,
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /outside\/private|Raw title|Raw display|Raw description|sdk-request-private/,
    );
  });

  it("names the file a write is for, relative to the checkout, and nothing outside it", () => {
    const inside = mapClaudeToolRequest(
      context(),
      toolRequest({
        toolName: "Edit",
        input: { file_path: `${projectRoot}/src/app.ts`, old_string: "a", new_string: "b" },
      }),
    );
    expect(inside).toMatchObject({
      request: { event: { action: "Edit", description: "Edit · src/app.ts" } },
    });
    expect(JSON.stringify(inside)).not.toContain(projectRoot);

    const outside = mapClaudeToolRequest(
      context(),
      toolRequest({
        toolName: "Write",
        toolUseId: "sdk-tool-outside",
        input: { file_path: "/outside/private-must-not-cross.ts", content: "x" },
      }),
    );
    expect(outside).toMatchObject({
      request: { event: { description: "Claude requests permission to use Write." } },
    });
    expect(JSON.stringify(outside)).not.toContain("private-must-not-cross");
  });

  it("keeps a token-shaped literal out of the prompt while still naming the command", () => {
    const result = mapClaudeToolRequest(
      context(),
      toolRequest({
        input: {
          command:
            "curl -H 'Authorization: Bearer sk-ant-fixture-api-key-must-not-cross' https://x",
        },
      }),
    );
    const description =
      result.kind === "approval" && result.request.event.kind === "approval-request"
        ? result.request.event.description
        : undefined;
    expect(description?.startsWith("Bash · curl -H '")).toBe(true);
    expect(description).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("sk-ant-fixture-api-key-must-not-cross");
  });

  it.each(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"])(
    "keeps a GitHub credential with the %s prefix out of the prompt",
    (prefix) => {
      const token = `${prefix}${"A1b2C3d4".repeat(4)}`;
      const result = mapClaudeToolRequest(
        context(),
        toolRequest({ input: { command: `gh auth login --with-token <<< ${token}` } }),
      );
      const description =
        result.kind === "approval" && result.request.event.kind === "approval-request"
          ? result.request.event.description
          : undefined;
      expect(description).toContain("[redacted]");
      expect(JSON.stringify(result)).not.toContain(token);
    },
  );

  it("shows a shell command on one bounded line", () => {
    const long = `echo ${"x".repeat(200)}`;
    const result = mapClaudeToolRequest(
      context(),
      toolRequest({ input: { command: `git  status\n  --short ${long}` } }),
    );
    const description =
      result.kind === "approval" && result.request.event.kind === "approval-request"
        ? result.request.event.description
        : undefined;
    expect(description?.startsWith("Bash · git status --short echo xxx")).toBe(true);
    expect(description).not.toContain("\n");
    expect(Array.from(description ?? "").length).toBeLessThanOrEqual("Bash · ".length + 120);
    expect(description?.endsWith("…")).toBe(true);
  });

  it("maps one AskUserQuestion callback to a sanitized user-input request", () => {
    const result = mapClaudeToolRequest(
      context(),
      toolRequest({
        toolName: "AskUserQuestion",
        toolUseId: "sdk-question-private",
        input: {
          questions: [
            {
              header: "Choice",
              question: "Which safe option?",
              options: [
                { label: "One", description: "private option description must-not-cross" },
                { label: "Two", description: "private second description must-not-cross" },
              ],
              multiSelect: false,
              rawPrivate: "raw question input must-not-cross",
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({
      kind: "question",
      request: {
        requestId: "request-1",
        providerSessionId: claudeSessionId,
        providerToolUseId: "sdk-question-private",
        inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        event: {
          kind: "user-input-request",
          requestId: "request-1",
          prompt: "Which safe option?",
          options: ["One", "Two"],
        },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private option|raw question input/);
  });

  it("reuses one public request ID for an identical callback correlation tuple", () => {
    const ctx = context();
    const request = toolRequest();

    const first = mapClaudeToolRequest(ctx, request);
    const repeated = mapClaudeToolRequest(ctx, request);

    expect(first).toMatchObject({ kind: "approval", request: { requestId: "request-1" } });
    expect(repeated).toMatchObject({ kind: "approval", request: { requestId: "request-1" } });
    expect(ctx.requestIds).toHaveLength(1);
  });

  it("reuses one request ID when long Unicode callback tool names normalize identically", () => {
    const ctx = context();
    const firstToolName = `${"T".repeat(255)}😀first-private-suffix`;
    const repeatedToolName = `${"T".repeat(255)}😀second-private-suffix`;

    const first = mapClaudeToolRequest(ctx, toolRequest({ toolName: firstToolName }));
    const repeated = mapClaudeToolRequest(ctx, toolRequest({ toolName: repeatedToolName }));
    const correlation = ctx.requestIds.get("sdk-tool-private");

    expect(first).toMatchObject({ kind: "approval", request: { requestId: "request-1" } });
    expect(repeated).toMatchObject({ kind: "approval", request: { requestId: "request-1" } });
    expect(correlation?.toolName).toBe(`${"T".repeat(255)}…`);
    expect(Array.from(correlation?.toolName ?? "")).toHaveLength(256);
    expect(JSON.stringify([...ctx.requestIds.values()])).not.toMatch(
      /first-private|second-private/,
    );
  });

  it("protocol-fails a repeated callback with a changed normalized Unicode tool name", () => {
    const ctx = context();
    const firstToolName = `${"T".repeat(254)}😀first-private-suffix`;
    const changedToolName = `${"T".repeat(254)}🚀second-private-suffix`;
    mapClaudeToolRequest(ctx, toolRequest({ toolName: firstToolName }));
    const sequenceBefore = ctx.sequence;

    const result = mapClaudeToolRequest(ctx, toolRequest({ toolName: changedToolName }));
    const correlation = ctx.requestIds.get("sdk-tool-private");

    expect(result).toEqual({
      kind: "failure",
      failure: {
        category: "protocol",
        message: "Claude callback did not match its original correlation tuple.",
      },
    });
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(correlation?.toolName).toBe(`${"T".repeat(254)}😀…`);
    expect(JSON.stringify([...ctx.requestIds.values()])).not.toMatch(
      /first-private|second-private/,
    );
  });

  it.each([
    {
      name: "input digest",
      changed: toolRequest({ input: { command: "different private command" } }),
    },
    {
      name: "tool name",
      changed: toolRequest({ toolName: "Edit" }),
    },
    {
      name: "request kind",
      changed: toolRequest({
        toolName: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Continue?",
              options: [{ label: "Yes" }, { label: "No" }],
              multiSelect: false,
            },
          ],
        },
      }),
    },
  ])("protocol-fails a repeated callback with changed $name", ({ changed }) => {
    const ctx = context();
    mapClaudeToolRequest(ctx, toolRequest());
    const sequenceBefore = ctx.sequence;

    const result = mapClaudeToolRequest(ctx, changed);

    expect(result).toEqual({
      kind: "failure",
      failure: {
        category: "protocol",
        message: "Claude callback did not match its original correlation tuple.",
      },
    });
    expect(ctx.sequence).toBe(sequenceBefore);
    expect(ctx.requestIds).toHaveLength(1);
  });

  it("protocol-fails reuse of a callback correlation record across provider sessions", () => {
    const requestIds = new Map();
    mapClaudeToolRequest(context({ requestIds }), toolRequest());
    const changedSession = context({ requestIds, claudeSessionId: "different-sdk-session" });

    const result = mapClaudeToolRequest(changedSession, toolRequest());

    expect(result).toEqual({
      kind: "failure",
      failure: {
        category: "protocol",
        message: "Claude callback did not match its original correlation tuple.",
      },
    });
    expect(changedSession.sequence).toBe(41);
    expect(requestIds).toHaveLength(1);
  });

  it("never serializes raw prompt, command output, account, API key, transcript, or SDK object", () => {
    const secrets = [
      "fixture-command-output-must-not-cross",
      "fixture-account-must-not-cross",
      "sk-ant-fixture-api-key-must-not-cross",
      "/private/transcript-must-not-cross.jsonl",
      "fixture-sdk-object-must-not-cross",
    ];
    // The command itself is what the prompt shows; every other field the
    // runtime attaches to the input still stays out.
    const request = toolRequest({
      input: {
        command: "printf ok",
        output: "fixture-command-output-must-not-cross",
        account: "fixture-account-must-not-cross",
        apiKey: "sk-ant-fixture-api-key-must-not-cross",
        transcriptPath: "/private/transcript-must-not-cross.jsonl",
        sdkObject: { value: "fixture-sdk-object-must-not-cross" },
      },
    });
    const result = mapClaudeToolRequest(context(), request);
    const serialized = JSON.stringify(result);

    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });
});
