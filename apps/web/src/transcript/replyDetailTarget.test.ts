import { describe, expect, it } from "vitest";
import { replyDetailThreadInFront } from "./replyDetailTarget";

const threads = {
  chatThreadId: "chat-1",
  workThreadId: undefined,
  codeThreadId: "code-1",
} as const;

describe("the thread Reply detail acts on", () => {
  it("is the active pane's thread of the active mode while that thread is on screen", () => {
    expect(replyDetailThreadInFront({ ...threads, activeMode: "chat", covered: false })).toEqual({
      mode: "chat",
      threadId: "chat-1",
    });
    expect(replyDetailThreadInFront({ ...threads, activeMode: "code", covered: false })).toEqual({
      mode: "code",
      threadId: "code-1",
    });
  });

  it("is none while Settings, Review, or another page covers the thread", () => {
    expect(replyDetailThreadInFront({ ...threads, activeMode: "chat", covered: true })).toBe(
      undefined,
    );
  });

  it("is none when the active pane holds no thread", () => {
    expect(replyDetailThreadInFront({ ...threads, activeMode: "work", covered: false })).toBe(
      undefined,
    );
  });
});
