import { describe, expect, it } from "vitest";
import {
  AGENT_MESSAGE_AGGREGATE,
  AGENT_MESSAGE_EVENT_NAMES,
  decodeAgentMessageAcknowledged,
  decodeAgentMessageDelivered,
  decodeAgentMessageRefused,
  decodeAgentMessageSent,
  MAX_AGENT_MESSAGE_BODY_BYTES,
} from "./agentMessage";

const bodyReference = { contentReference: "msg-body-01", byteLength: 128 };
const occurredAt = "2026-09-10T12:00:00.000Z";

const sent = {
  kind: "message-sent",
  messageId: "10000000-0000-4000-8000-000000000001",
  correlationId: "20000000-0000-4000-8000-000000000001",
  senderThreadId: "chat-0000-0000-4000-8000-000000000001",
  recipientThreadId: "code-0000-0000-4000-8000-000000000002",
  bodyReference,
  occurredAt,
};

describe("the agent message contract", () => {
  it("decodes the four journaled payloads on the agent-message aggregate", () => {
    expect(AGENT_MESSAGE_AGGREGATE).toBe("agent-message");
    expect(AGENT_MESSAGE_EVENT_NAMES).toEqual({
      sent: "agent.message-sent@1",
      delivered: "agent.message-delivered@1",
      refused: "agent.message-refused@1",
      acknowledged: "agent.message-acknowledged@1",
    });
    expect(decodeAgentMessageSent(sent).recipientRunId).toBeUndefined();
    expect(
      decodeAgentMessageDelivered({
        kind: "message-delivered",
        messageId: sent.messageId,
        correlationId: sent.correlationId,
        recipientThreadId: sent.recipientThreadId,
        bodyReference,
        occurredAt,
      }).messageId,
    ).toBe(sent.messageId);
    expect(
      decodeAgentMessageRefused({
        kind: "message-refused",
        messageId: sent.messageId,
        correlationId: sent.correlationId,
        refuseReason: "unauthorized",
        occurredAt,
      }).refuseReason,
    ).toBe("unauthorized");
    expect(
      decodeAgentMessageAcknowledged({
        kind: "message-acknowledged",
        messageId: sent.messageId,
        correlationId: sent.correlationId,
        occurredAt,
      }).messageId,
    ).toBe(sent.messageId);
  });

  it("refuses an oversized body length the host could never have stored", () => {
    expect(() =>
      decodeAgentMessageSent({
        ...sent,
        bodyReference: { ...bodyReference, byteLength: MAX_AGENT_MESSAGE_BODY_BYTES + 1 },
      }),
    ).toThrow();
  });

  it("refuses a body reference that could name a host path or URL", () => {
    for (const contentReference of ["../../etc/passwd", "file:///etc/passwd", "https://o/s"]) {
      expect(() =>
        decodeAgentMessageSent({
          ...sent,
          bodyReference: { ...bodyReference, contentReference },
        }),
      ).toThrow();
    }
  });

  it("refuses an endpoint id that could smuggle a path or scheme", () => {
    expect(() =>
      decodeAgentMessageSent({ ...sent, recipientThreadId: "../../threads/secret" }),
    ).toThrow();
  });

  it("refuses a refuse reason the record does not define", () => {
    expect(() =>
      decodeAgentMessageRefused({
        kind: "message-refused",
        messageId: sent.messageId,
        correlationId: sent.correlationId,
        refuseReason: "busy",
        occurredAt,
      }),
    ).toThrow();
  });
});
