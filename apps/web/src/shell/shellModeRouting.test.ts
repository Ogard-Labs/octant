import { describe, expect, it } from "vitest";
import { codeThreadActivity, threadRest } from "./shellModeRouting";

describe("codeThreadActivity", () => {
  it("lights working while a turn executes, then returns to attention and unread when settled", () => {
    expect(codeThreadActivity({ lifecycle: "active", executing: true, followUp: true })).toBe(
      "working",
    );
    expect(codeThreadActivity({ lifecycle: "active", followUp: true })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "waiting" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "interrupted" })).toBe("attention");
    expect(codeThreadActivity({ lifecycle: "active", unread: true })).toBe("unread");
    expect(codeThreadActivity({ lifecycle: "active" })).toBe("idle");
    expect(codeThreadActivity({ lifecycle: "archived" })).toBe("idle");
  });
});

describe("threadRest", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");
  const snooze = { until: "2026-09-08T09:00:00.000Z", at: "2026-09-07T09:00:00.000Z" };

  it("files a snoozed row with its wake countdown and a completed row under Completed", () => {
    expect(threadRest({ snooze }, { now, awaitingInput: false })).toEqual({
      shelf: "snoozed",
      wakeLabel: "23h",
    });
    expect(
      threadRest({ completedAt: "2026-09-01T00:00:00.000Z" }, { now, awaitingInput: false }),
    ).toEqual({ shelf: "completed" });
    expect(threadRest({}, { now, awaitingInput: false })).toEqual({});
  });

  it("reads a row that says working as a running turn, for Chat and Work rows without an executing flag", () => {
    const duringTurn = { ...snooze, duringTurn: true };
    expect(
      threadRest({ snooze: duringTurn, activity: "working" }, { now, awaitingInput: false }),
    ).toEqual({ shelf: "snoozed", wakeLabel: "23h" });
    expect(threadRest({ snooze: duringTurn }, { now, awaitingInput: false })).toEqual({
      woke: true,
    });
  });

  it("wakes a snoozed row only when the host says the thread waits on the person", () => {
    expect(threadRest({ snooze }, { now, awaitingInput: true })).toEqual({ woke: true });
    // A row that says it needs attention for any other reason — a follow-up
    // mark, a resting Code lifecycle — stays where the person put it.
    expect(threadRest({ snooze, activity: "attention" }, { now, awaitingInput: false })).toEqual({
      shelf: "snoozed",
      wakeLabel: "23h",
    });
    expect(threadRest({ snooze, executing: false }, { now, awaitingInput: false })).toEqual({
      shelf: "snoozed",
      wakeLabel: "23h",
    });
  });
});
