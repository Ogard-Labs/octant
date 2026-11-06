import { describe, expect, it } from "vitest";
import {
  decodeSideChatDraftPrepared,
  decodeSideChatDraftReturnReferences,
  decodeSideChatSourceReceipt,
} from "./sideChatReturn";
import { decodeThreadMentionCommand } from "./threadMention";
const thread = "10000000-0000-4000-8000-000000000001";
const sidecar = "20000000-0000-4000-8000-000000000001";
const ref = {
  sidecarThreadId: sidecar,
  sourceThreadId: thread,
  sourceMode: "work",
  turnId: "30000000-0000-4000-8000-000000000001",
  attemptId: "40000000-0000-4000-8000-000000000001",
  answerDigest: "a".repeat(64),
};
describe("person-operated Side Chat draft reference contracts", () => {
  it("carries only bounded immutable reply/source identity, never a command or new authority", () => {
    expect(decodeSideChatDraftReturnReferences([ref])).toEqual([ref]);
    for (const field of [
      { send: true },
      { approve: true },
      { targetThreadId: sidecar },
      { text: "caller-authored source bytes" },
    ])
      expect(() => decodeSideChatDraftReturnReferences([{ ...ref, ...field }])).toThrow();
    expect(() =>
      decodeSideChatDraftReturnReferences(Array.from({ length: 5 }, () => ref)),
    ).toThrow();
  });
  it("keeps observed source versions and exact context digest without claiming atomic reads", () => {
    const receipt = {
      sourceThreadId: thread,
      sourceMode: "work",
      capturedAt: "2026-11-02T18:00:00.000Z",
      contextDigest: "b".repeat(64),
      threadVersionBefore: 3,
      threadVersionAfter: 5,
      versions: [{ kind: "aggregate", aggregateType: "work-turn", id: thread, version: 4 }],
      versionsTruncated: false,
      transcriptTruncated: true,
      omissions: ["Later file observations are not included."],
    };
    expect(decodeSideChatSourceReceipt(receipt)).toEqual(receipt);
    expect(() =>
      decodeSideChatSourceReceipt({
        ...receipt,
        versions: Array.from({ length: 129 }, () => receipt.versions[0]),
      }),
    ).toThrow();
  });
  it("prepares only the selected linked source reply and keeps the returned draft editable and unsent", () => {
    expect(
      decodeThreadMentionCommand({
        kind: "prepare-side-chat-return",
        requestId: thread,
        sidecarThreadId: sidecar,
        expectedSourceThreadId: thread,
        turnId: ref.turnId,
        attemptId: ref.attemptId,
      }),
    ).toBeDefined();
    expect(() =>
      decodeThreadMentionCommand({
        kind: "prepare-side-chat-return",
        requestId: thread,
        sidecarThreadId: sidecar,
        expectedSourceThreadId: thread,
        turnId: ref.turnId,
        attemptId: ref.attemptId,
        send: true,
      }),
    ).toThrow();
    expect(
      decodeSideChatDraftPrepared({
        kind: "side-chat-draft-prepared",
        reference: ref,
        destination: { threadId: thread, mode: "work", title: "Source", version: 5, busy: true },
        text: "Selected reply and provenance",
        omissions: ["Other replies omitted."],
      }),
    ).toBeDefined();
  });
});
