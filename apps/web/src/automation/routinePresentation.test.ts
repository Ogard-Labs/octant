import type { AutomationTrigger } from "@octant/contracts/automation";
import { describe, expect, it } from "vitest";
import {
  routineCadence,
  routineCadenceLabel,
  routineHasCompleted,
  routineNextRunLabel,
  routineScheduleLabel,
  routineScheduleLine,
} from "./routinePresentation";

const utc = { timeZone: "UTC" } as const;
const now = "2026-08-18T08:00:00.000Z";

const daily = {
  kind: "interval",
  anchorAt: "2026-08-01T09:00:00.000Z",
  intervalMinutes: 1_440,
} as AutomationTrigger;

describe("saying what a routine does", () => {
  it("says when a daily routine runs, not just that it is daily", () => {
    expect(routineScheduleLabel(daily, utc)).toBe("Every day at 9:00");
  });

  it("does not claim a time of day for something that runs many times a day", () => {
    expect(
      routineScheduleLabel(
        {
          kind: "interval",
          anchorAt: "2026-08-01T09:00:00.000Z",
          intervalMinutes: 30,
        } as AutomationTrigger,
        utc,
      ),
    ).toBe("Every 30 minutes");
  });

  it("names the day sets people actually mean", () => {
    const weekly = (weekdays: ReadonlyArray<number>) =>
      routineScheduleLabel(
        {
          kind: "weekly-local",
          weekdays,
          localTime: "09:00",
          timeZone: "UTC",
        } as AutomationTrigger,
        utc,
      );

    expect(weekly([1, 2, 3, 4, 5])).toBe("Weekdays at 9:00");
    expect(weekly([6, 7])).toBe("Weekends at 9:00");
    expect(weekly([1, 2, 3, 4, 5, 6, 7])).toBe("Every day at 9:00");
    expect(weekly([2, 4])).toBe("Weekly on Tue, Thu at 9:00");
  });

  it("says when a one-time routine fires", () => {
    expect(
      routineScheduleLabel(
        { kind: "once", scheduledAt: "2026-08-20T17:00:00.000Z" } as AutomationTrigger,
        utc,
      ),
    ).toBe("Once on Aug 20 at 17:00");
  });

  it("separates one-time from recurring", () => {
    expect(routineCadence({ kind: "once", scheduledAt: now } as AutomationTrigger)).toBe(
      "one-time",
    );
    expect(routineCadence(daily)).toBe("recurring");
    expect(routineCadenceLabel("recurring")).toBe("Recurring");
  });
});

describe("saying when a routine next runs", () => {
  it.each([
    ["2026-08-18T08:20:00.000Z", "Next run in 20 minutes"],
    ["2026-08-18T09:00:00.000Z", "Next run today at 9:00"],
    ["2026-08-19T09:00:00.000Z", "Next run tomorrow at 9:00"],
    ["2026-08-21T09:00:00.000Z", "Next run on Friday at 9:00"],
    ["2026-09-10T09:00:00.000Z", "Next run on Sep 10 at 9:00"],
  ])("describes %s as %s", (nextDueAt, expected) => {
    expect(routineNextRunLabel(nextDueAt, now, utc)).toBe(expected);
  });

  it("counts days on the calendar rather than by elapsed time", () => {
    // Twenty minutes later is tomorrow to a person, and the row has to agree.
    expect(routineNextRunLabel("2026-08-19T00:10:00.000Z", "2026-08-18T23:50:00.000Z", utc)).toBe(
      "Next run in 20 minutes",
    );
    expect(routineNextRunLabel("2026-08-19T07:00:00.000Z", "2026-08-18T23:50:00.000Z", utc)).toBe(
      "Next run tomorrow at 7:00",
    );
  });

  it("says plainly when nothing is scheduled, and when it is already due", () => {
    expect(routineNextRunLabel(null, now, utc)).toBe("Not scheduled");
    expect(routineNextRunLabel("2026-08-18T07:59:00.000Z", now, utc)).toBe("Next run due now");
  });

  it("reads as one line on a row", () => {
    expect(routineScheduleLine(daily, "2026-08-19T09:00:00.000Z", now, utc)).toBe(
      "Every day at 9:00 · Next run tomorrow at 9:00",
    );
  });
});

describe("knowing when a one-shot is finished", () => {
  it("treats a fired one-time routine as completed and a pending one as not", () => {
    const once = { kind: "once", scheduledAt: "2026-08-20T17:00:00.000Z" } as AutomationTrigger;

    expect(routineHasCompleted(once, null)).toBe(true);
    expect(routineHasCompleted(once, "2026-08-20T17:00:00.000Z")).toBe(false);
  });

  it("never treats a recurring routine as completed, even between runs", () => {
    expect(routineHasCompleted(daily, null)).toBe(false);
  });
});
