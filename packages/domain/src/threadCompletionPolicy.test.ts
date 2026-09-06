import { describe, expect, it } from "vitest";
import {
  completedThreadArchiveDue,
  decideCompleteThread,
  decideSnoozeThread,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadShelf,
  threadWoke,
} from "./threadCompletionPolicy";

const now = "2026-09-07T10:00:00.000Z";
const later = "2026-09-08T09:00:00.000Z";
const earlier = "2026-09-07T09:00:00.000Z";
const idle = { executing: false, awaitingInput: false };

describe("threadShelf", () => {
  it("files a thread in play as active and a completed one under Completed", () => {
    expect(threadShelf({}, { ...idle, now })).toBe("active");
    expect(threadShelf({ completedAt: earlier }, { ...idle, now })).toBe("completed");
  });

  it("hides a snoozed thread until its wake time passes", () => {
    const snooze = { until: later, at: earlier };
    expect(threadShelf({ snooze }, { ...idle, now })).toBe("snoozed");
    expect(threadShelf({ snooze }, { ...idle, now: later })).toBe("active");
    expect(threadWoke({ snooze }, { ...idle, now: later })).toBe(true);
    expect(threadWoke({ snooze }, { ...idle, now })).toBe(false);
  });

  it("wakes a snoozed thread early when the agent is waiting on the person", () => {
    const snooze = { until: later, at: earlier };
    expect(threadShelf({ snooze }, { executing: false, awaitingInput: true, now })).toBe("active");
    expect(threadWoke({ snooze }, { executing: false, awaitingInput: true, now })).toBe(true);
  });

  it("wakes a thread snoozed mid-turn when that turn ends, but not one snoozed while idle", () => {
    const duringTurn = { until: later, at: earlier, duringTurn: true };
    expect(
      threadShelf({ snooze: duringTurn }, { executing: true, awaitingInput: false, now }),
    ).toBe("snoozed");
    expect(threadShelf({ snooze: duringTurn }, { ...idle, now })).toBe("active");
    expect(threadShelf({ snooze: { until: later, at: earlier } }, { ...idle, now })).toBe(
      "snoozed",
    );
  });

  it("never hides a thread behind a wake time it cannot read", () => {
    expect(threadShelf({ snooze: { until: "not a time", at: earlier } }, { ...idle, now })).toBe(
      "active",
    );
  });
});

describe("decideCompleteThread", () => {
  it("refuses while a turn runs or the thread waits on the person, and on an archived thread", () => {
    expect(decideCompleteThread({ ...idle, lifecycle: "active" })).toEqual({ status: "ok" });
    expect(
      decideCompleteThread({ executing: true, awaitingInput: false, lifecycle: "active" }),
    ).toEqual({ status: "refused", reason: "executing" });
    expect(
      decideCompleteThread({ executing: false, awaitingInput: true, lifecycle: "active" }),
    ).toEqual({ status: "refused", reason: "awaiting-input" });
    expect(decideCompleteThread({ ...idle, lifecycle: "archived" })).toEqual({
      status: "refused",
      reason: "archived",
    });
  });
});

describe("decideSnoozeThread", () => {
  it("allows a running thread but refuses one waiting on the person", () => {
    expect(
      decideSnoozeThread({ lifecycle: "active", awaitingInput: false, until: later, now }),
    ).toEqual({ status: "ok" });
    expect(
      decideSnoozeThread({ lifecycle: "active", awaitingInput: true, until: later, now }),
    ).toEqual({ status: "refused", reason: "awaiting-input" });
  });

  it("refuses a wake time that is not in the future", () => {
    expect(
      decideSnoozeThread({ lifecycle: "active", awaitingInput: false, until: earlier, now }),
    ).toEqual({ status: "refused", reason: "wake-time-not-in-future" });
    expect(
      decideSnoozeThread({ lifecycle: "active", awaitingInput: false, until: now, now }),
    ).toEqual({ status: "refused", reason: "wake-time-not-in-future" });
    expect(
      decideSnoozeThread({ lifecycle: "active", awaitingInput: false, until: "soon", now }),
    ).toEqual({ status: "refused", reason: "wake-time-not-in-future" });
  });
});

describe("completedThreadArchiveDue", () => {
  it("is due once the completion is as old as the window, and never when the timer is off", () => {
    const completedAt = "2026-09-01T10:00:00.000Z";
    expect(
      completedThreadArchiveDue({
        lifecycle: "active",
        completedAt,
        afterDays: 7,
        now: "2026-09-08T10:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      completedThreadArchiveDue({
        lifecycle: "active",
        completedAt,
        afterDays: 7,
        now: "2026-09-08T09:59:59.000Z",
      }),
    ).toBe(false);
    expect(
      completedThreadArchiveDue({
        lifecycle: "active",
        completedAt,
        afterDays: null,
        now: "2027-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("skips threads that are not completed, already archived, or carry an unreadable time", () => {
    expect(
      completedThreadArchiveDue({ lifecycle: "active", completedAt: undefined, afterDays: 1, now }),
    ).toBe(false);
    expect(
      completedThreadArchiveDue({
        lifecycle: "archived",
        completedAt: earlier,
        afterDays: 0.5,
        now,
      }),
    ).toBe(false);
    expect(
      completedThreadArchiveDue({
        lifecycle: "active",
        completedAt: "yesterday",
        afterDays: 1,
        now,
      }),
    ).toBe(false);
  });
});

describe("resolveSnoozePresets", () => {
  it("offers the evening only while it is more than an hour away", () => {
    const morning = new Date(2026, 8, 9, 10, 0, 0); // Wednesday
    const ids = resolveSnoozePresets(morning).map((preset) => preset.id);
    expect(ids).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    const lateAfternoon = new Date(2026, 8, 9, 17, 30, 0);
    expect(resolveSnoozePresets(lateAfternoon).map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "tomorrow",
      "next-week",
    ]);
  });

  it("lands tomorrow and next week on nine in the morning and folds them on a Sunday", () => {
    const sunday = new Date(2026, 8, 13, 20, 0, 0);
    const presets = resolveSnoozePresets(sunday);
    expect(presets.map((preset) => preset.id)).toEqual(["hour", "three-hours", "tomorrow"]);
    const tomorrow = presets.find((preset) => preset.id === "tomorrow");
    expect(new Date(tomorrow!.until).getHours()).toBe(9);
    expect(new Date(tomorrow!.until).getDay()).toBe(1);
  });
});

describe("snoozeWakeLabel", () => {
  it("reads in the coarsest true unit and never says zero", () => {
    expect(snoozeWakeLabel("2026-09-07T10:00:30.000Z", now)).toBe("1m");
    expect(snoozeWakeLabel("2026-09-07T10:45:00.000Z", now)).toBe("45m");
    expect(snoozeWakeLabel("2026-09-07T12:30:00.000Z", now)).toBe("3h");
    expect(snoozeWakeLabel("2026-09-07T11:02:00.000Z", now)).toBe("1h");
    expect(snoozeWakeLabel("2026-09-09T09:00:00.000Z", now)).toBe("2d");
    expect(snoozeWakeLabel("2026-09-10T10:00:00.000Z", now)).toBe("3d");
    expect(snoozeWakeLabel(earlier, now)).toBe("now");
  });
});
