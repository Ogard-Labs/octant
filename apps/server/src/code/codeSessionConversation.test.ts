import { decodeCodeThreadId, type CodeConversationPage } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { readCodeSessionConversation } from "./codeSessionConversation";

const threadId = decodeCodeThreadId("11111111-1111-4111-8111-111111111111");
const evidence = (contentId: string) => ({ contentId, digest: "d", byteLength: 1 }) as never;

function turn(index: number, status: string, assistant: ReadonlyArray<string>) {
  return {
    operationId: `00000000-0000-4000-8000-00000000000${String(index)}`,
    status,
    prompt: evidence(`prompt-${String(index)}`),
    assistant: assistant.map(evidence),
  };
}

describe("reading a Code thread's conversation for a summary", () => {
  it("reads prompts and finished replies across pages, oldest first, leaving unfinished replies out", () => {
    const pages = [
      { turns: [turn(1, "completed", ["reply-1a", "reply-1b"])], nextCursor: 1, hasMore: true },
      { turns: [turn(2, "running", ["reply-2"])], nextCursor: 2, hasMore: false },
    ];
    const text: Record<string, string> = {
      "prompt-1": "Add the index.",
      "reply-1a": "Added ",
      "reply-1b": "it.",
      "prompt-2": "Now the migration.",
      "reply-2": "Working…",
    };
    const asked: Array<number> = [];
    const messages = readCodeSessionConversation(threadId, {
      conversation: (input) => {
        asked.push(input.afterCursor);
        return pages[asked.length - 1] as unknown as CodeConversationPage;
      },
      readEvidence: (reference) => text[String(reference.contentId)],
    });
    expect(asked).toEqual([0, 1]);
    expect(messages?.map((message) => [message.role, message.content])).toEqual([
      ["user", "Add the index."],
      ["assistant", "Added it."],
      ["user", "Now the migration."],
    ]);
    // A reply is known by its last part, so a retried reply reads as another.
    expect(messages?.[1]?.source).toEqual({
      kind: "message",
      referenceId: `${String(messages?.[1]?.exchangeKey)}:assistant:reply-1b`,
    });
    expect(messages?.[1]?.exchangeKey).toBe(messages?.[0]?.exchangeKey);
  });

  it("tells two turns with the same text apart", () => {
    const page = {
      turns: [turn(1, "completed", ["same"]), turn(2, "completed", ["same"])],
      nextCursor: 2,
      hasMore: false,
    };
    const messages = readCodeSessionConversation(threadId, {
      conversation: () => page as unknown as CodeConversationPage,
      readEvidence: () => "continue",
    });
    const sources = new Set(messages?.map((message) => message.source.referenceId));
    expect(sources.size).toBe(4);
  });

  it("reads nothing for a thread too long to read whole, or one the store refuses", () => {
    const endless = { turns: [turn(1, "completed", ["r"])], nextCursor: 0, hasMore: true };
    let cursor = 0;
    expect(
      readCodeSessionConversation(threadId, {
        conversation: () => {
          cursor += 1;
          return { ...endless, nextCursor: cursor } as unknown as CodeConversationPage;
        },
        readEvidence: () => "text",
      }),
    ).toBeUndefined();
    expect(
      readCodeSessionConversation(threadId, {
        conversation: () => {
          throw new Error("scan bound");
        },
        readEvidence: () => "text",
      }),
    ).toBeUndefined();
  });
});
