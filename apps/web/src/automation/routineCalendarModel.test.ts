import { decodeAutomationTrigger } from "@octant/contracts/automation";
import { describe, expect, it } from "vitest";
import { automationSummaryFixture } from "./automationTestFixtures";
import { buildRoutineCalendarMonth, stepRoutineCalendarMonth } from "./routineCalendarModel";

const AUGUST = "2026-08-18T12:00:00.000Z";

function days(month: ReturnType<typeof buildRoutineCalendarMonth>) {
  return month.weeks.flat();
}

function entriesOn(month: ReturnType<typeof buildRoutineCalendarMonth>, date: string) {
  return days(month).find((day) => day.date === date)?.entries ?? [];
}

describe("a month of a routine's future", () => {
  it("lands a weekly routine on each of its weekdays at its local time", () => {
    const month = buildRoutineCalendarMonth({
      routines: [
        automationSummaryFixture({
          displayName: "Monday summary",
          trigger: decodeAutomationTrigger({
            kind: "weekly-local",
            weekdays: [1],
            localTime: "09:00",
            timeZone: "UTC",
          }),
        }),
      ],
      month: AUGUST,
      now: AUGUST,
      timeZone: "UTC",
    });

    const mondays = days(month).filter((day) => day.entries.length > 0);
    // The grid begins on the Monday before the first, and that day runs too:
    // a routine does not stop existing because the month boundary fell there.
    expect(mondays.map((day) => day.date)).toEqual([
      "2026-07-27",
      "2026-08-03",
      "2026-08-10",
      "2026-08-17",
      "2026-08-24",
      "2026-08-31",
    ]);
    expect(mondays[0]?.entries[0]?.label).toBe("9:00");
  });

  it("says the cadence instead of burying a day under a routine that runs all day", () => {
    const month = buildRoutineCalendarMonth({
      routines: [
        automationSummaryFixture({
          displayName: "Inbox sweep",
          trigger: decodeAutomationTrigger({
            kind: "interval",
            intervalMinutes: 15,
            anchorAt: "2026-08-17T00:00:00.000Z",
          }),
        }),
      ],
      month: AUGUST,
      now: AUGUST,
      timeZone: "UTC",
    });

    expect(entriesOn(month, "2026-08-18")).toHaveLength(1);
    expect(entriesOn(month, "2026-08-18")[0]?.label).toBe("Every 15 minutes");
    // It had not started yet on the sixteenth, so the day stays empty.
    expect(entriesOn(month, "2026-08-16")).toHaveLength(0);
  });

  it("draws nothing for a routine that is not enabled", () => {
    const month = buildRoutineCalendarMonth({
      routines: [automationSummaryFixture({ lifecycle: "paused" })],
      month: AUGUST,
      now: AUGUST,
      timeZone: "UTC",
    });

    expect(days(month).every((day) => day.entries.length === 0)).toBe(true);
  });

  it("puts a routine on the day the reader's own zone says it runs", () => {
    const routine = automationSummaryFixture({
      displayName: "Late run",
      trigger: decodeAutomationTrigger({ kind: "once", scheduledAt: "2026-08-19T02:00:00.000Z" }),
    });

    const utc = buildRoutineCalendarMonth({
      routines: [routine],
      month: AUGUST,
      now: AUGUST,
      timeZone: "UTC",
    });
    const newYork = buildRoutineCalendarMonth({
      routines: [routine],
      month: AUGUST,
      now: AUGUST,
      timeZone: "America/New_York",
    });

    expect(entriesOn(utc, "2026-08-19")).toHaveLength(1);
    // 02:00 UTC is the evening of the day before in New York.
    expect(entriesOn(newYork, "2026-08-18")).toHaveLength(1);
    expect(entriesOn(newYork, "2026-08-19")).toHaveLength(0);
  });

  it("marks today and keeps a six-week grid so the layout never jumps", () => {
    const month = buildRoutineCalendarMonth({
      routines: [],
      month: AUGUST,
      now: AUGUST,
      timeZone: "UTC",
    });

    expect(month.label).toBe("August 2026");
    expect(month.weeks).toHaveLength(6);
    expect(month.weeks.every((week) => week.length === 7)).toBe(true);
    expect(
      days(month)
        .filter((day) => day.isToday)
        .map((day) => day.date),
    ).toEqual(["2026-08-18"]);
    expect(days(month).filter((day) => day.inMonth)).toHaveLength(31);
  });

  it("keeps a daily routine on its local hour across a clock change", () => {
    const month = buildRoutineCalendarMonth({
      routines: [
        automationSummaryFixture({
          displayName: "Standup",
          trigger: decodeAutomationTrigger({
            kind: "weekly-local",
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            localTime: "09:00",
            timeZone: "America/New_York",
          }),
        }),
      ],
      month: "2026-11-05T12:00:00.000Z",
      now: "2026-11-05T12:00:00.000Z",
      timeZone: "America/New_York",
    });

    // The United States moves its clocks back on the first Sunday of November.
    expect(entriesOn(month, "2026-11-01")[0]?.label).toBe("9:00");
    expect(entriesOn(month, "2026-11-02")[0]?.label).toBe("9:00");
    expect(entriesOn(month, "2026-11-02")[0]?.at).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("stepping between months", () => {
  it("lands in the next month even from a day the next month does not have", () => {
    const next = stepRoutineCalendarMonth("2026-01-31T12:00:00.000Z", 1, "UTC");

    expect(
      buildRoutineCalendarMonth({ routines: [], month: next, now: next, timeZone: "UTC" }).label,
    ).toBe("February 2026");
  });

  it("crosses the year in both directions", () => {
    const back = stepRoutineCalendarMonth("2026-01-15T12:00:00.000Z", -1, "UTC");
    const forward = stepRoutineCalendarMonth("2026-12-15T12:00:00.000Z", 1, "UTC");

    expect(back.slice(0, 7)).toBe("2025-12");
    expect(forward.slice(0, 7)).toBe("2027-01");
  });
});
