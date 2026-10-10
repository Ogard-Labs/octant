import {
  CorrelationId,
  UtcTimestamp,
  decodeProviderInstanceId,
  decodeProviderRuntimeEvent,
  decodeProviderSessionId,
} from "@octant/contracts";
import type { Event } from "@opencode-ai/sdk/v2/types";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { adaptBetaOpenCodeEvent } from "./openCodeDriver";
import {
  mapOpenCodeEvent,
  type OpenCodeEvent,
  type OpenCodeEventContext,
} from "./openCodeEventMapper";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000071");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000072");
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "80000000-0000-4000-8000-000000000073",
);
const occurredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-15T08:00:00.000Z");

function context(sequenceStart = 41): OpenCodeEventContext {
  return { instanceId, sessionId, correlationId, occurredAt, sequenceStart };
}

function official<T extends Event>(event: T): T {
  return event;
}

function mapped(event: OpenCodeEvent, sequenceStart = 41) {
  return mapOpenCodeEvent(context(sequenceStart), event).map((runtimeEvent) =>
    decodeProviderRuntimeEvent(runtimeEvent),
  );
}

describe("mapOpenCodeEvent", () => {
  it.each([
    {
      name: "text delta",
      event: official({
        id: "event-text",
        type: "session.next.text.delta",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          textID: "text-1",
          delta: "Hello",
        },
      }),
      expected: { kind: "text-delta", text: "Hello" },
    },
    {
      name: "reasoning delta",
      event: official({
        id: "event-reasoning",
        type: "session.next.reasoning.delta",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          reasoningID: "reasoning-1",
          delta: "Considering the request",
        },
      }),
      expected: { kind: "reasoning-delta", text: "Considering the request" },
    },
    {
      name: "tool start",
      event: official({
        id: "event-tool-start",
        type: "session.next.tool.called",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          callID: "call-1",
          tool: "read_file",
          input: { privateInput: "must-not-cross" },
          provider: { executed: true, metadata: { privateProvider: { value: "hidden" } } },
        },
      }),
      expected: { kind: "tool-start", toolCallId: "call-1", toolName: "read_file" },
    },
    {
      name: "tool progress",
      event: official({
        id: "event-tool-progress",
        type: "session.next.tool.progress",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          callID: "call-1",
          structured: { privateProgress: "must-not-cross" },
          content: [{ type: "text", text: "raw-progress-must-not-cross" }],
        },
      }),
      expected: { kind: "tool-progress", toolCallId: "call-1", message: "Tool is running." },
    },
    {
      name: "tool success",
      event: official({
        id: "event-tool-success",
        type: "session.next.tool.success",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          callID: "call-1",
          structured: { privateResult: "must-not-cross" },
          content: [{ type: "text", text: "raw-result-must-not-cross" }],
          result: { privateResult: "must-not-cross" },
          provider: { executed: true, metadata: { privateProvider: { value: "hidden" } } },
        },
      }),
      expected: { kind: "tool-success", toolCallId: "call-1", summary: "Tool completed." },
    },
    {
      name: "tool failure",
      event: official({
        id: "event-tool-failed",
        type: "session.next.tool.failed",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          callID: "call-1",
          error: { type: "unknown", message: "raw-provider-error-must-not-cross" },
          result: { privateResult: "must-not-cross" },
          provider: { executed: true, metadata: { privateProvider: { value: "hidden" } } },
        },
      }),
      expected: { kind: "tool-failure", toolCallId: "call-1", message: "Tool failed." },
    },
    {
      name: "step usage",
      event: official({
        id: "event-step-ended",
        type: "session.next.step.ended",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          finish: "stop",
          cost: 0,
          tokens: { input: 12, output: 7, reasoning: 3, cache: { read: 2, write: 1 } },
          snapshot: "private-snapshot-must-not-cross",
        },
      }),
      expected: {
        kind: "usage",
        // 12 uncached plus 2 read from the cache and 1 written to it.
        inputTokens: 15,
        outputTokens: 7,
        reasoningTokens: 3,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        costUsd: 0,
      },
    },
    {
      name: "file edit",
      event: official({
        id: "event-file-edited",
        type: "file.edited",
        properties: { file: "src/main.ts" },
      }),
      expected: { kind: "file-change", path: "src/main.ts", change: "modified" },
    },
    {
      name: "session diff",
      event: official({
        id: "event-diff",
        type: "session.diff",
        properties: {
          sessionID: "provider-session",
          diff: [
            {
              file: "src/main.ts",
              patch: "@@ -1 +1 @@\n-old\n+new",
              additions: 1,
              deletions: 1,
              status: "modified",
            },
          ],
        },
      }),
      expected: { kind: "diff", diff: "src/main.ts\n@@ -1 +1 @@\n-old\n+new" },
    },
    {
      name: "legacy permission question",
      event: official({
        id: "event-permission",
        type: "permission.asked",
        properties: {
          id: "permission-1",
          sessionID: "provider-session",
          permission: "write",
          patterns: ["private-pattern-must-not-cross"],
          metadata: { privateMetadata: "must-not-cross" },
          always: [],
        },
      }),
      expected: {
        kind: "approval-request",
        requestId: "permission-1",
        action: "write",
        description: "Approval is required for this action.",
      },
    },
    {
      name: "v2 permission question",
      event: official({
        id: "event-permission-v2",
        type: "permission.v2.asked",
        properties: {
          id: "permission-2",
          sessionID: "provider-session",
          action: "edit",
          resources: ["private-resource-must-not-cross"],
          metadata: { privateMetadata: "must-not-cross" },
        },
      }),
      expected: {
        kind: "approval-request",
        requestId: "permission-2",
        action: "edit",
        description: "Approval is required for this action.",
      },
    },
    {
      name: "legacy user question",
      event: official({
        id: "event-question",
        type: "question.asked",
        properties: {
          id: "question-1",
          sessionID: "provider-session",
          questions: [
            {
              header: "Choose",
              question: "Which option?",
              options: [{ label: "Option 1", description: "The plain text one" }],
            },
          ],
        },
      }),
      expected: {
        kind: "user-input-request",
        requestId: "question-1",
        prompt: "Which option?",
        options: [{ label: "Option 1", description: "The plain text one" }],
      },
    },
    {
      name: "v2 user question",
      event: official({
        id: "event-question-v2",
        type: "question.v2.asked",
        properties: {
          id: "question-2",
          sessionID: "provider-session",
          questions: [
            {
              header: "Choose",
              question: "Continue?",
              options: [{ label: "Yes", description: "Go ahead now" }],
            },
          ],
        },
      }),
      expected: {
        kind: "user-input-request",
        requestId: "question-2",
        prompt: "Continue?",
        options: [{ label: "Yes", description: "Go ahead now" }],
      },
    },
    {
      name: "session idle",
      event: official({
        id: "event-idle",
        type: "session.idle",
        properties: { sessionID: "provider-session" },
      }),
      expected: {
        kind: "completed",
        resumeCursor: { driverKind: "opencode", value: "provider-session" },
      },
    },
  ])("maps $name into a strict normalized event", ({ event, expected }) => {
    const [result] = mapped(event);

    expect(result).toMatchObject({
      ...expected,
      instanceId,
      sessionId,
      correlationId,
      occurredAt,
      sequence: 41,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /providerID|metadata|must-not-cross|private-provider-name/i,
    );
  });

  it("reports nothing for a retry status, so every mode keeps the turn running", () => {
    expect(
      mapped(
        official({
          id: "event-retry",
          type: "session.status",
          properties: {
            sessionID: "provider-session",
            status: {
              type: "retry",
              attempt: 2,
              message: "raw-retry-message-must-not-cross",
              next: 2,
              action: {
                reason: "private",
                provider: "private-provider-name-must-not-cross",
                title: "private",
                message: "private",
                label: "private",
              },
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("allocates contiguous stable sequences for todo progress", () => {
    const results = mapped(
      official({
        id: "event-todos",
        type: "todo.updated",
        properties: {
          sessionID: "provider-session",
          todos: [
            { content: "Inspect types", status: "in_progress", priority: "high" },
            { content: "Write mapper", status: "completed", priority: "medium" },
          ],
        },
      }),
      7,
    );

    expect(results).toMatchObject([
      {
        kind: "task-progress",
        sequence: 7,
        taskId: "task-1",
        status: "in-progress",
        summary: "Inspect types",
      },
      {
        kind: "task-progress",
        sequence: 8,
        taskId: "task-2",
        status: "completed",
        summary: "Write mapper",
      },
    ]);
  });

  it("does not consume a sequence when an invalid todo is ignored", () => {
    const results = mapped(
      official({
        id: "event-todos-with-empty-entry",
        type: "todo.updated",
        properties: {
          sessionID: "provider-session",
          todos: [
            { content: "   ", status: "pending", priority: "low" },
            { content: "Keep sequence contiguous", status: "in_progress", priority: "high" },
          ],
        },
      }),
      7,
    );

    expect(results).toMatchObject([
      { kind: "task-progress", sequence: 7, taskId: "task-2", status: "in-progress" },
    ]);
  });

  it.each([
    {
      name: "a multi-select question",
      event: official({
        id: "event-question-multiple",
        type: "question.asked",
        properties: {
          id: "question-multiple",
          sessionID: "provider-session",
          questions: [
            {
              header: "Choose",
              question: "Raw multi-select question must-not-cross?",
              options: [{ label: "Raw option must-not-cross", description: "private" }],
              multiple: true,
            },
          ],
        },
      }),
    },
  ])("fails closed for $name without truncating provider data", ({ event }) => {
    const results = mapped(event);

    expect(results).toMatchObject([
      {
        kind: "failed",
        failure: {
          category: "unsupported",
          message:
            "This provider question format is not supported. Ask one single-select question at a time.",
        },
      },
    ]);
    expect(results).not.toContainEqual(expect.objectContaining({ kind: "user-input-request" }));
    expect(JSON.stringify(results)).not.toMatch(/must-not-cross|metadata|providerID/i);
  });

  it("maps a multi-question set into one event per question, each with its place", () => {
    const results = mapped(
      official({
        id: "event-question-groups",
        type: "question.v2.asked",
        properties: {
          id: "question-groups",
          sessionID: "provider-session",
          questions: [
            {
              header: "First",
              question: "How should I proceed?",
              options: [
                {
                  label: "Dequeue, push, re-queue",
                  description: "Leave the queue, push the fix, re-enter it.",
                },
                { label: "Let it merge", description: "Keep the fix as a follow-up." },
              ],
            },
            {
              header: "Second",
              question: "Mark the review threads resolved?",
              options: [{ label: "Resolve verified", description: "Note each thread briefly." }],
            },
          ],
        },
      }),
    );

    expect(results).toMatchObject([
      {
        kind: "user-input-request",
        requestId: "question-groups",
        prompt: "How should I proceed?",
        options: [
          {
            label: "Dequeue, push, re-queue",
            description: "Leave the queue, push the fix, re-enter it.",
          },
          { label: "Let it merge", description: "Keep the fix as a follow-up." },
        ],
        questionIndex: 1,
        questionCount: 2,
      },
      {
        kind: "user-input-request",
        requestId: "question-groups",
        prompt: "Mark the review threads resolved?",
        options: [{ label: "Resolve verified", description: "Note each thread briefly." }],
        questionIndex: 2,
        questionCount: 2,
      },
    ]);
    expect(results).toHaveLength(2);
  });

  it("refuses a question set with an unanswerable blank item", () => {
    const results = mapOpenCodeEvent(
      context(),
      official({
        id: "malformed-set",
        type: "question.v2.asked",
        properties: {
          id: "question-set",
          sessionID: "provider-session",
          questions: [
            {
              header: "First",
              question: "First?",
              options: [{ label: "Yes", description: "Continue" }],
            },
            {
              header: "Second",
              question: "   ",
              options: [{ label: "Yes", description: "Continue" }],
            },
          ],
        },
      }),
    );
    expect(results).toMatchObject([{ kind: "failed", failure: { category: "unsupported" } }]);
  });

  it("maps an idle status to completion with an opaque resume cursor", () => {
    expect(
      mapped(
        official({
          id: "event-status-idle",
          type: "session.status",
          properties: { sessionID: "provider-session", status: { type: "idle" } },
        }),
      ),
    ).toMatchObject([
      {
        kind: "completed",
        sequence: 41,
        resumeCursor: { driverKind: "opencode", value: "provider-session" },
      },
    ]);
  });

  it.each([
    {
      name: "authentication error",
      event: official({
        id: "event-auth-error",
        type: "session.error",
        properties: {
          sessionID: "provider-session",
          error: {
            name: "ProviderAuthError",
            data: {
              providerID: "private-provider-name-must-not-cross",
              message: "raw-auth-error-must-not-cross",
            },
          },
        },
      }),
      expected: {
        kind: "failed",
        failure: {
          category: "unauthenticated",
          message: "Provider authentication is required.",
        },
      },
    },
    {
      name: "provider error",
      event: official({
        id: "event-provider-error",
        type: "session.error",
        properties: {
          sessionID: "provider-session",
          error: {
            name: "APIError",
            data: {
              message: "raw-provider-error-must-not-cross",
              isRetryable: false,
              responseBody: "raw-provider-body-must-not-cross",
              metadata: { privateMetadata: "must-not-cross" },
            },
          },
        },
      }),
      expected: {
        kind: "failed",
        failure: { category: "provider-failed", message: "Provider execution failed." },
      },
    },
    {
      name: "HTTP authentication error",
      event: official({
        id: "event-http-auth-error",
        type: "session.error",
        properties: {
          sessionID: "provider-session",
          error: {
            name: "APIError",
            data: {
              message: "raw-http-auth-error-must-not-cross",
              statusCode: 401,
              isRetryable: false,
              responseBody: "raw-provider-body-must-not-cross",
            },
          },
        },
      }),
      expected: {
        kind: "failed",
        failure: {
          category: "unauthenticated",
          message: "Provider authentication is required.",
        },
      },
    },
    {
      name: "aborted error",
      event: official({
        id: "event-aborted",
        type: "session.error",
        properties: {
          sessionID: "provider-session",
          error: {
            name: "MessageAbortedError",
            data: { message: "raw-abort-reason-must-not-cross" },
          },
        },
      }),
      expected: { kind: "interrupted", message: "Provider execution was interrupted." },
    },
  ])("classifies $name without leaking its source", ({ event, expected }) => {
    const [result] = mapped(event);

    expect(result).toMatchObject(expected);
    expect(JSON.stringify(result)).not.toMatch(
      /providerID|metadata|must-not-cross|private-provider-name/i,
    );
  });

  it.each([
    official({ id: "event-plugin", type: "plugin.added", properties: { id: "plugin-1" } }),
    official({
      id: "event-tui",
      type: "tui.toast.show",
      properties: { title: "private", message: "must-not-cross", variant: "error" },
    }),
    official({ id: "event-global", type: "global.disposed", properties: {} }),
  ])("explicitly ignores unrelated global, TUI, and plugin events", (event) => {
    expect(mapped(event)).toEqual([]);
  });

  it("ignores empty provider deltas and empty collections without consuming a sequence", () => {
    expect(
      mapped(
        official({
          id: "event-empty-text",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "provider-session",
            assistantMessageID: "message-1",
            textID: "text-1",
            delta: "",
          },
        }),
      ),
    ).toEqual([]);
    expect(
      mapped(
        official({
          id: "event-empty-todos",
          type: "todo.updated",
          properties: { sessionID: "provider-session", todos: [] },
        }),
      ),
    ).toEqual([]);
  });

  it("preserves meaningful whitespace in streamed text", () => {
    expect(
      mapped(
        official({
          id: "event-spaced-text",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "provider-session",
            assistantMessageID: "message-1",
            textID: "text-1",
            delta: " hello ",
          },
        }),
      ),
    ).toMatchObject([{ kind: "text-delta", text: " hello " }]);
  });

  it("carries a length finish onto the completed event and leaves an ordinary finish unstated", () => {
    const stopMemory: { current: "max-tokens" | "content-filter" | undefined } = {
      current: undefined,
    };
    const limited = mapOpenCodeEvent(
      { ...context(), stopMemory },
      official({
        id: "event-step-length",
        type: "session.next.step.ended",
        properties: {
          timestamp: 1,
          sessionID: "provider-session",
          assistantMessageID: "message-1",
          finish: "length",
          cost: 0,
          tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      }),
    );
    const completed = mapOpenCodeEvent(
      { ...context(42), stopMemory },
      official({
        id: "event-idle",
        type: "session.idle",
        properties: { sessionID: "provider-session" },
      }),
    );
    expect(limited[0]).toMatchObject({ kind: "usage" });
    expect(completed[0]).toMatchObject({ kind: "completed", stopReason: "max-tokens" });

    const ordinary = mapOpenCodeEvent(
      context(),
      official({
        id: "event-idle-plain",
        type: "session.idle",
        properties: { sessionID: "provider-session" },
      }),
    );
    expect(ordinary[0]).not.toHaveProperty("stopReason");
  });
});

describe("OpenCode 2.0.22 events", () => {
  const sessionID = "ses_2022";
  const assistantMessageID = "msg_2022";
  const tokens = { input: 5, output: 7, reasoning: 1, cache: { read: 2, write: 0 } };

  /** Adapts one event as the 2.0.22 stream sends it, then maps it. */
  function adaptAndMap(
    type: string,
    data: Record<string, unknown>,
    calls = new Map<string, string>(),
  ): ReturnType<typeof mapped> | "ignored" {
    const adapted = adaptBetaOpenCodeEvent({ type, data: { sessionID, ...data } }, calls);
    return adapted === undefined ? "ignored" : mapped(adapted);
  }

  it("streams text and reasoning deltas", () => {
    expect(
      adaptAndMap("session.text.delta", { assistantMessageID, ordinal: 0, delta: "hi" }),
    ).toMatchObject([{ kind: "text-delta", text: "hi" }]);
    expect(
      adaptAndMap("session.reasoning.delta", { assistantMessageID, ordinal: 0, delta: "think" }),
    ).toMatchObject([{ kind: "reasoning-delta", text: "think" }]);
  });

  it("reports a tool call by the name its input announced, then its outcome", () => {
    const calls = new Map<string, string>();
    const call = { assistantMessageID, id: "call_1" };
    expect(
      adaptAndMap("session.tool.input.started", { ...call, name: "octant-x_octant_echo" }, calls),
    ).toBe("ignored");
    expect(adaptAndMap("session.tool.input.ended", { ...call, text: "{}" }, calls)).toBe("ignored");
    expect(
      adaptAndMap("session.tool.called", { ...call, input: {}, executed: false }, calls),
    ).toMatchObject([
      { kind: "tool-start", toolCallId: "call_1", toolName: "octant-x_octant_echo" },
    ]);
    expect(adaptAndMap("session.tool.progress", { ...call, metadata: {} }, calls)).toMatchObject([
      { kind: "tool-progress", toolCallId: "call_1" },
    ]);
    expect(
      adaptAndMap(
        "session.tool.success",
        { ...call, content: [{ type: "text", text: "ok" }], executed: false },
        calls,
      ),
    ).toMatchObject([{ kind: "tool-success", toolCallId: "call_1" }]);
    expect(
      adaptAndMap(
        "session.tool.failed",
        { ...call, error: { message: "no" }, executed: false },
        calls,
      ),
    ).toMatchObject([{ kind: "tool-failure", toolCallId: "call_1" }]);
  });

  it("ignores a tool update that names no call", () => {
    for (const type of ["session.tool.progress", "session.tool.success", "session.tool.failed"]) {
      expect(adaptAndMap(type, { assistantMessageID, executed: false })).toBe("ignored");
    }
  });

  it("refuses a tool call whose name was never announced", () => {
    expect(() =>
      adaptAndMap("session.tool.called", { assistantMessageID, id: "call_2", input: {} }),
    ).toThrow("Unsupported provider event.");
  });

  it("reports step usage and a failed step", () => {
    expect(
      adaptAndMap("session.step.ended", {
        assistantMessageID,
        finish: "tool-calls",
        rawFinish: "tool_calls",
        cost: 0.5,
        tokens,
      }),
    ).toMatchObject([
      {
        kind: "usage",
        inputTokens: 7,
        outputTokens: 7,
        reasoningTokens: 1,
        cacheReadInputTokens: 2,
        costUsd: 0.5,
      },
    ]);
    expect(
      adaptAndMap("session.step.failed", { assistantMessageID, error: { message: "boom" } }),
    ).toMatchObject([{ kind: "failed", failure: { category: "provider-failed" } }]);
  });

  it("ends the turn from the execution outcome", () => {
    expect(adaptAndMap("session.execution.succeeded", {})).toMatchObject([
      { kind: "completed", resumeCursor: { driverKind: "opencode", value: sessionID } },
    ]);
    expect(adaptAndMap("session.execution.failed", { error: { message: "x" } })).toMatchObject([
      { kind: "failed", failure: { category: "provider-failed" } },
    ]);
    expect(adaptAndMap("session.execution.interrupted", { reason: "user" })).toMatchObject([
      { kind: "interrupted" },
    ]);
  });

  it.each(["superseded", "inactivity"])(
    "keeps an interruption OpenCode itself chose (%s) an ordinary interruption",
    (reason) => {
      expect(adaptAndMap("session.execution.interrupted", { reason })).toMatchObject([
        { kind: "interrupted" },
      ]);
    },
  );

  it("holds a turn OpenCode's own shutdown cut off for a person to check, naming why", () => {
    expect(adaptAndMap("session.execution.interrupted", { reason: "shutdown" })).toEqual([
      expect.objectContaining({
        kind: "waiting",
        message: "OpenCode shut down while this turn was running. Check what it did, then resume.",
      }),
    ]);
  });

  it("keeps a turn running through a scheduled retry instead of ending it as waiting", () => {
    expect(
      adaptAndMap("session.retry.scheduled", {
        assistantMessageID,
        attempt: 1,
        at: 1,
        error: { message: "rate limited" },
      }),
    ).toEqual([]);
  });

  it.each([
    ["session.inbox.enqueued", { inboxID: "m", item: {} }],
    ["session.inbox.delivered", { inboxID: "m" }],
    ["session.inbox.cancelled", { inboxID: "m" }],
    ["session.inbox.delivery.changed", { inboxID: "m", delivery: "steer" }],
    ["session.execution.started", {}],
    ["session.instructions.updated", { delta: {} }],
    ["session.usage.updated", { cost: 0, tokens }],
    ["session.usage.recorded", { cost: 0, tokens }],
    ["session.renamed", { title: "t" }],
    ["session.agent.selected", { agent: "build" }],
    ["session.model.selected", { model: { id: "m", providerID: "p" } }],
    ["session.step.started", { assistantMessageID, started: 1 }],
    ["session.step.streamed", { assistantMessageID }],
    ["session.text.started", { assistantMessageID, ordinal: 0 }],
    ["session.text.ended", { assistantMessageID, ordinal: 0, text: "hi" }],
    ["session.reasoning.started", { assistantMessageID, ordinal: 0 }],
    ["session.reasoning.ended", { assistantMessageID, ordinal: 0, text: "t" }],
    ["session.tool.input.delta", { assistantMessageID, id: "call_1", delta: "{" }],
    ["session.compaction.started", { reason: "auto", recent: "" }],
    ["session.compaction.delta", { text: "" }],
  ] as const)("records %s as bookkeeping with no runtime event", (type, data) => {
    expect(adaptAndMap(type, data)).toBe("ignored");
  });

  it("passes a finished compaction on, for the driver to note, with no runtime event of its own", () => {
    expect(adaptAndMap("session.compaction.ended", { reason: "auto" })).toEqual([]);
  });

  it("fails closed on an event this mapping does not know", () => {
    expect(() => adaptAndMap("session.skill.activated", { skill: "x" })).toThrow(
      "Unsupported provider event.",
    );
    expect(() => adaptAndMap("session.future.event", {})).toThrow("Unsupported provider event.");
  });
});
