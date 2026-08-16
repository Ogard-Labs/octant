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
import { mapOpenCodeEvent, type OpenCodeEventContext } from "./openCodeEventMapper";

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

function mapped(event: Event, sequenceStart = 41) {
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
      expected: { kind: "usage", inputTokens: 12, outputTokens: 7 },
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
              options: [{ label: "Option 1", description: "private-description-must-not-cross" }],
            },
          ],
        },
      }),
      expected: {
        kind: "user-input-request",
        requestId: "question-1",
        prompt: "Which option?",
        options: ["Option 1"],
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
              options: [{ label: "Yes", description: "private-description-must-not-cross" }],
            },
          ],
        },
      }),
      expected: {
        kind: "user-input-request",
        requestId: "question-2",
        prompt: "Continue?",
        options: ["Yes"],
      },
    },
    {
      name: "retry status",
      event: official({
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
      expected: { kind: "waiting", message: "Provider is retrying." },
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
      name: "more than one question group",
      event: official({
        id: "event-question-groups",
        type: "question.v2.asked",
        properties: {
          id: "question-groups",
          sessionID: "provider-session",
          questions: [
            {
              header: "First",
              question: "First raw question must-not-cross?",
              options: [{ label: "First raw option must-not-cross", description: "private" }],
            },
            {
              header: "Second",
              question: "Second raw question must-not-cross?",
              options: [{ label: "Second raw option must-not-cross", description: "private" }],
            },
          ],
        },
      }),
    },
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
});
