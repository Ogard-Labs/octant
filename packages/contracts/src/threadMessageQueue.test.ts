import { describe, expect, it } from "vitest";
import {
  decodeThreadMessageQueueCommand,
  decodeThreadMessageQueuePayload,
} from "./threadMessageQueue";

const command = {
  kind: "enqueue",
  requestId: "11111111-1111-4111-8111-111111111111",
  scope: { mode: "chat", threadId: "22222222-2222-4222-8222-222222222222" },
  expectedVersion: 0,
  messageId: "33333333-3333-4333-8333-333333333333",
  payload: { mode: "chat", prompt: "Keep this reply\n" },
};
describe("durable thread message queue contract", () => {
  it("keeps raw text and requires the payload to belong to the addressed mode", () => {
    expect(decodeThreadMessageQueueCommand(command)).toEqual(command);
    expect(() =>
      decodeThreadMessageQueueCommand({
        ...command,
        payload: { mode: "code", prompt: "Wrong mode" },
      }),
    ).toThrow();
  });
  it("refuses transient authority and edits that replace context selections", () => {
    expect(() =>
      decodeThreadMessageQueuePayload({
        mode: "code",
        prompt: "Reply",
        authority: { fullAccess: true },
      }),
    ).toThrow();
    expect(() =>
      decodeThreadMessageQueueCommand({
        kind: "edit",
        requestId: command.requestId,
        scope: command.scope,
        expectedVersion: 1,
        messageId: command.messageId,
        prompt: "Edited",
        attachmentIds: [],
      }),
    ).toThrow();
  });
  it("accepts attachment-only Chat messages and refuses empty messages without context", () => {
    const payload = {
      mode: "chat",
      prompt: "",
      attachmentIds: ["44444444-4444-4444-8444-444444444444"],
    };
    expect(decodeThreadMessageQueuePayload(payload)).toEqual(payload);
    expect(() => decodeThreadMessageQueuePayload({ mode: "chat", prompt: "" })).toThrow();
    expect(() => decodeThreadMessageQueuePayload({ ...payload, mode: "work" })).toThrow();
  });
  it("bounds text before a queue command reaches storage", () => {
    expect(() =>
      decodeThreadMessageQueuePayload({ mode: "work", prompt: "x".repeat(200001) }),
    ).toThrow();
    expect(
      decodeThreadMessageQueuePayload({ mode: "work", prompt: "x".repeat(200000) }).prompt,
    ).toHaveLength(200000);
  });
});
