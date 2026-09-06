import { describe, expect, it } from "vitest";
import { codeThreadActivity, codeThreadRest } from "./shellModeRouting";

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

describe("codeThreadRest", () => {
  const now = new Date("2026-09-07T10:00:00.000Z");
  const snooze = { until: "2026-09-08T09:00:00.000Z", at: "2026-09-07T09:00:00.000Z" };

  it("files a snoozed row with its wake countdown and a completed row under Completed", () => {
    expect(codeThreadRest({ lifecycle: "active", snooze }, { now, awaitingInput: false })).toEqual({
      shelf: "snoozed",
      wakeLabel: "23h",
    });
    expect(
      codeThreadRest(
        { lifecycle: "active", completedAt: "2026-09-01T00:00:00.000Z" },
        { now, awaitingInput: false },
      ),
    ).toEqual({ shelf: "completed" });
    expect(codeThreadRest({ lifecycle: "active" }, { now, awaitingInput: false })).toEqual({});
  });

  it("wakes a snoozed row that needs the person, but leaves a follow-up mark alone", () => {
    expect(codeThreadRest({ lifecycle: "active", snooze }, { now, awaitingInput: true })).toEqual({
      woke: true,
    });
    expect(codeThreadRest({ lifecycle: "waiting", snooze }, { now, awaitingInput: false })).toEqual(
      { woke: true },
    );
    expect(
      codeThreadRest(
        { lifecycle: "active", snooze, executing: false },
        { now, awaitingInput: false },
      ),
    ).toEqual({ shelf: "snoozed", wakeLabel: "23h" });
  });
});
