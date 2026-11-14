import { describe, expect, it } from "vitest";
import {
  MAX_THREAD_RECAP_EXCERPT_LENGTH,
  decodeMentionableThreadId,
  type ThreadMentionTranscriptEntry,
} from "@octant/contracts";
import { recapThread } from "./threadRecap";

const threadId = decodeMentionableThreadId("7f6c1d1e-3b0a-4c43-9d55-1c2f0f7e8a01");

function entry(
  role: ThreadMentionTranscriptEntry["role"],
  text: string,
  minute: number,
): ThreadMentionTranscriptEntry {
  return {
    role,
    text,
    occurredAt:
      `2026-11-14T10:${String(minute).padStart(2, "0")}:00.000Z` as ThreadMentionTranscriptEntry["occurredAt"],
  };
}

describe("thread recap", () => {
  it("names what was asked, the last result, and the message it reads through", () => {
    const recap = recapThread({
      threadId,
      mode: "code",
      title: "Fix the picker",
      transcript: [
        entry("user", "Why is the model picker empty?", 1),
        entry("assistant", "The directory was never registered.", 2),
        entry("user", `Register it and add a test. ${"x".repeat(400)}`, 3),
        entry("assistant", "Registered the directory\nand added a picker test.", 4),
      ],
      truncated: false,
      notes: 2,
    });

    expect(recap).toMatchObject({
      title: "Fix the picker",
      asks: 2,
      replies: 2,
      firstAsk: "Why is the model picker empty?",
      latestReply: "Registered the directory and added a picker test.",
      awaitingReply: false,
      throughAt: "2026-11-14T10:04:00.000Z",
      truncated: false,
      notes: 2,
    });
    expect(recap.latestAsk?.length).toBe(MAX_THREAD_RECAP_EXCERPT_LENGTH);
    expect(recap.latestAsk?.endsWith("…")).toBe(true);
  });

  it("says when the person's newest message is still waiting for a reply", () => {
    const recap = recapThread({
      threadId,
      mode: "chat",
      title: "Trip",
      transcript: [entry("user", "Plan a day in Lyon", 1)],
      truncated: true,
      notes: 0,
    });

    expect(recap).toMatchObject({ asks: 1, replies: 0, awaitingReply: true, truncated: true });
    expect(recap.latestReply).toBeUndefined();
  });
});
