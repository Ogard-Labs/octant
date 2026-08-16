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
  mapAcpNotification,
  mapAcpPermissionRequest,
  type AcpEventContext,
} from "./acpEventMapper";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000301");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000302");
const correlationId = Schema.decodeUnknownSync(CorrelationId)(
  "80000000-0000-4000-8000-000000000303",
);
const occurredAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-17T10:00:00.000Z");

function context(overrides: Partial<AcpEventContext> = {}): AcpEventContext {
  let request = 0;
  return {
    instanceId,
    sessionId,
    correlationId,
    occurredAt,
    sourceSessionId: "acp-session-1",
    displayName: "Fixture Agent",
    sequence: 1,
    terminal: false,
    tools: new Map(),
    requestIds: new Map(),
    makeRequestId: () => `request-${++request}`,
    ...overrides,
  };
}

function event(result: ReturnType<typeof mapAcpNotification>) {
  expect(result).toHaveLength(1);
  const first = result[0];
  expect(first?.kind).toBe("event");
  if (first?.kind !== "event") throw new Error("Expected event");
  return decodeProviderRuntimeEvent(first.event);
}

describe("ACP event normalization", () => {
  it("maps stable message and thought chunks without provider payload retention", () => {
    const ctx = context();
    expect(
      event(
        mapAcpNotification(ctx, {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Hello" },
              private: "must-not-cross",
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "text-delta", text: "Hello", sequence: 1 });
    expect(
      event(
        mapAcpNotification(ctx, {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Checking" },
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "reasoning-delta", text: "Checking", sequence: 2 });
  });

  it("maps ordered tool lifecycle and rejects contradictory ordering", () => {
    const ctx = context();
    expect(
      event(
        mapAcpNotification(ctx, {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "provider-tool-1",
              title: "Read file",
              status: "in_progress",
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "tool-start", toolCallId: "tool-1", toolName: "Read file" });
    expect(
      event(
        mapAcpNotification(ctx, {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "provider-tool-1",
              status: "completed",
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "tool-success", toolCallId: "tool-1" });
    expect(
      mapAcpNotification(ctx, {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "acp-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "provider-tool-1",
            status: "completed",
          },
        },
      }),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Fixture Agent repeated a terminal tool update.",
        },
      },
    ]);
  });

  it("maps plan entries conservatively and ignores config metadata", () => {
    const ctx = context();
    expect(
      mapAcpNotification(ctx, {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "acp-session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Inspect", status: "pending" },
              { content: "Implement", status: "in_progress" },
            ],
          },
        },
      }).map((result) => (result.kind === "event" ? result.event.kind : result.kind)),
    ).toEqual(["task-progress", "task-progress"]);
    expect(
      mapAcpNotification(ctx, {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "acp-session-1",
          update: { sessionUpdate: "config_option_update", configOptions: [] },
        },
      }),
    ).toEqual([{ kind: "ignored" }]);
  });

  it("fails closed on a mismatched source session", () => {
    expect(
      mapAcpNotification(context(), {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "other-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "private" },
          },
        },
      }),
    ).toEqual([
      {
        kind: "protocol-failure",
        failure: {
          category: "protocol",
          message: "Fixture Agent update did not match the active session.",
        },
      },
    ]);
  });

  it("maps side effects to approvals and q0 options to a single-select question", () => {
    const approval = mapAcpPermissionRequest(context(), {
      kind: "request",
      id: "provider-request-1",
      method: "session/request_permission",
      params: {
        sessionId: "acp-session-1",
        toolCall: { toolCallId: "tool-1", title: "Write file", kind: "edit" },
        options: [
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    expect(approval).toMatchObject({
      kind: "approval",
      requestId: "request-1",
      providerRequestId: "provider-request-1",
      allowOptionId: "allow_once",
      event: { kind: "approval-request", action: "edit", description: "Write file" },
    });

    const question = mapAcpPermissionRequest(context(), {
      kind: "request",
      id: "provider-question-1",
      method: "session/request_permission",
      params: {
        sessionId: "acp-session-1",
        toolCall: { toolCallId: "question-1", title: "Choose a target" },
        options: [
          { optionId: "q0_opt_0", name: "A", kind: "allow_once" },
          { optionId: "q0_opt_1", name: "B", kind: "allow_once" },
          { optionId: "q0_skip", name: "Skip", kind: "reject_once" },
        ],
      },
    });
    expect(question).toMatchObject({
      kind: "question",
      requestId: "request-1",
      event: { kind: "user-input-request", prompt: "Choose a target", options: ["A", "B"] },
    });
  });
});
