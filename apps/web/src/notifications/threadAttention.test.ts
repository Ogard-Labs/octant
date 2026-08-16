import { describe, expect, it } from "vitest";
import {
  EMPTY_THREAD_ATTENTION,
  evaluateThreadAttention,
  type ThreadAttentionSignal,
} from "./threadAttention";

const finished: ThreadAttentionSignal = {
  threadId: "thread-a",
  reason: "turn-finished",
  title: "Rewrite the diff pane",
};
const asked: ThreadAttentionSignal = {
  threadId: "thread-b",
  reason: "question-asked",
  title: "Queue the next message",
};

describe("thread attention", () => {
  it("announces each newly raised signal exactly once", () => {
    const first = evaluateThreadAttention(
      { signals: [finished, asked], windowFocused: false },
      EMPTY_THREAD_ATTENTION,
    );
    expect(first.announce).toEqual([finished, asked]);
    expect(first.badgeCount).toBe(2);

    const second = evaluateThreadAttention(
      { signals: [finished, asked], windowFocused: false },
      first.raised,
    );
    expect(second.announce).toEqual([]);
    expect(second.badgeCount).toBe(2);
  });

  it("re-announces a signal that cleared and came back", () => {
    const raised = evaluateThreadAttention(
      { signals: [finished], windowFocused: false },
      EMPTY_THREAD_ATTENTION,
    );
    const cleared = evaluateThreadAttention({ signals: [], windowFocused: false }, raised.raised);
    expect(cleared.badgeCount).toBe(0);
    const again = evaluateThreadAttention(
      { signals: [finished], windowFocused: false },
      cleared.raised,
    );
    expect(again.announce).toEqual([finished]);
  });

  it("stays quiet for the thread the user is watching in a focused window", () => {
    const watched = evaluateThreadAttention(
      { signals: [finished, asked], watchedThreadId: "thread-a", windowFocused: true },
      EMPTY_THREAD_ATTENTION,
    );
    expect(watched.announce).toEqual([asked]);
    expect(watched.badgeCount).toBe(1);
  });

  it("badges but does not re-banner a signal the user already watched", () => {
    const watched = evaluateThreadAttention(
      { signals: [finished], watchedThreadId: "thread-a", windowFocused: true },
      EMPTY_THREAD_ATTENTION,
    );
    const blurred = evaluateThreadAttention(
      { signals: [finished], watchedThreadId: "thread-a", windowFocused: false },
      watched.raised,
    );
    expect(blurred.announce).toEqual([]);
    expect(blurred.badgeCount).toBe(1);
  });

  it("badges a thread once even when it raises several signals", () => {
    const outcome = evaluateThreadAttention(
      {
        signals: [finished, { ...asked, threadId: "thread-a" }],
        windowFocused: false,
      },
      EMPTY_THREAD_ATTENTION,
    );
    expect(outcome.badgeCount).toBe(1);
    expect(outcome.announce).toHaveLength(2);
  });
});
