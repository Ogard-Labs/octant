import { describe, expect, it } from "vitest";
import {
  completedThreadArchiveDue,
  decideCompleteThread,
  restAfterReport,
  restAfterReportFailure,
  unfinishedWorkRefusal,
  type ThreadRestLike,
  type ThreadUnfinishedWork,
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
  it("refuses to settle a thread whose side task or child run is not done, before it says anything of the thread's own turn", () => {
    const unfinishedWork = { kind: "side-task-working", title: "Fix the docs" } as const;
    expect(decideCompleteThread({ ...idle, lifecycle: "active", unfinishedWork })).toEqual({
      status: "refused",
      reason: "unfinished-work",
      work: unfinishedWork,
    });
    expect(
      decideCompleteThread({
        executing: true,
        awaitingInput: false,
        lifecycle: "active",
        unfinishedWork,
      }),
    ).toMatchObject({ reason: "unfinished-work" });
    expect(decideCompleteThread({ ...idle, lifecycle: "archived", unfinishedWork })).toEqual({
      status: "refused",
      reason: "archived",
    });
  });

  it("names the work that is not done in the sentence a person reads", () => {
    const sentence = (kind: ThreadUnfinishedWork["kind"], title = "Fix the docs") =>
      unfinishedWorkRefusal({ kind, title });
    expect(sentence("side-task-working")).toBe(
      "The side task “Fix the docs” is still working. Settle this thread once it is done.",
    );
    expect(sentence("side-task-attention")).toBe(
      "The side task “Fix the docs” needs you. Answer it before settling this thread.",
    );
    expect(sentence("side-task-report")).toBe(
      "The side task “Fix the docs” has a report on its way here. Settle this thread once it arrives.",
    );
    expect(sentence("child-run")).toBe(
      "The child run “Fix the docs” is still running. Settle this thread once it is done.",
    );
    // A run's task can be a whole prompt; the sentence keeps one short line of it.
    expect(sentence("child-run", `First line\n${"x".repeat(200)}`).length).toBeLessThan(200);
    expect(sentence("child-run", `First line\n${"x".repeat(200)}`)).not.toContain("\n");
  });

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
    // Twenty-three and a half hours rounds to a day, never to "24h".
    expect(snoozeWakeLabel("2026-09-08T09:30:00.000Z", now)).toBe("1d");
    expect(snoozeWakeLabel("2026-09-10T10:00:00.000Z", now)).toBe("3d");
    expect(snoozeWakeLabel(earlier, now)).toBe("now");
  });
});

describe("restAfterReportFailure", () => {
  const snooze = { until: "2026-08-01T08:00:00.000Z", at: "2026-07-31T08:00:00.000Z" };

  it("ends a person's snooze so the failure shows, and leaves a usage limit's own and a settle alone", () => {
    const limited = { id: "t", snooze: { ...snooze, origin: "usage-limit" } };
    expect(restAfterReportFailure({ id: "t", completedAt: now, snooze })).toEqual({
      id: "t",
      completedAt: now,
    });
    expect(restAfterReportFailure(limited)).toBe(limited);
  });
});

describe("restAfterReport", () => {
  const snooze = { until: "2026-08-01T08:00:00.000Z", at: "2026-07-31T08:00:00.000Z" };

  it("brings a settled thread back and leaves a person's snooze holding", () => {
    const never: ThreadRestLike & { readonly id: string } = { id: "t" };
    expect(restAfterReport({ id: "t", completedAt: now, snooze })).toEqual({ id: "t", snooze });
    expect(restAfterReport(never)).toEqual({ id: "t" });
  });

  it("keeps the thread hidden while the report's turn runs, and shows it once that turn needs the person", () => {
    const kept = restAfterReport({ id: "t", snooze });
    const at = "2026-07-31T09:00:00.000Z";
    expect(threadShelf(kept, { executing: true, awaitingInput: false, now: at })).toBe("snoozed");
    expect(threadShelf(kept, { executing: false, awaitingInput: false, now: at })).toBe("snoozed");
    expect(threadShelf(kept, { executing: false, awaitingInput: true, now: at })).toBe("active");
  });

  it("drops a snooze that already ended with the turn it was set during, so the report's turn does not hide the thread again", () => {
    expect(restAfterReport({ id: "t", snooze: { ...snooze, duringTurn: true } })).toEqual({
      id: "t",
    });
  });
});
