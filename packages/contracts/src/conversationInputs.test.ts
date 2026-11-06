import { describe, expect, it } from "vitest";
import {
  decodeConversationInputManifest,
  decodeConversationInputReference,
} from "./conversationInputs";

const input = {
  source: {
    mode: "chat",
    threadId: "11111111-1111-4111-8111-111111111111",
    attachmentId: "22222222-2222-4222-8222-222222222222",
  },
  displayName: "Original document.pdf",
  mediaType: "application/pdf",
  byteLength: 1024,
  digest: "a".repeat(64),
};

describe("conversation input receipts", () => {
  it("requires immutable source identity and a reason for every omitted input", () => {
    expect(decodeConversationInputReference(input).source).toEqual(input.source);
    expect(() => decodeConversationInputReference({ ...input, digest: "not-a-digest" })).toThrow();
    expect(() =>
      decodeConversationInputManifest({
        version: 1,
        purpose: "child-delegation",
        items: [{ status: "omitted", input }],
      }),
    ).toThrow();
    expect(
      decodeConversationInputManifest({
        version: 1,
        purpose: "child-delegation",
        items: [{ status: "omitted", input, reason: "person-excluded" }],
      }).items,
    ).toHaveLength(1);
  });
  it("bounds the admitted manifest and refuses caller-supplied paths and bytes", () => {
    expect(() => decodeConversationInputReference({ ...input, path: "/private/secret" })).toThrow();
    expect(() => decodeConversationInputReference({ ...input, bytes: [1] })).toThrow();
    expect(() =>
      decodeConversationInputManifest({
        version: 1,
        purpose: "provider-switch",
        items: Array.from({ length: 9 }, () => ({ status: "included", input })),
      }),
    ).toThrow();
  });
});
