import { describe, expect, it } from "vitest";
import type { HomeActivityCustomization } from "@octant/contracts/code-home-activity";
import {
  activityRangeForCard,
  DEFAULT_HOME_ACTIVITY,
  isActivityCalendarDate,
  resolveActivityRange,
  type ActivityRange,
  type ActivityRangeResult,
  type ActivityWindow,
} from "./activityRangePolicy";

const UTC = "UTC";
const NEW_YORK = "America/New_York";
const SAO_PAULO = "America/Sao_Paulo";

const ms = (iso: string): number => Date.parse(iso);

function resolve(
  range: ActivityRange,
  nowIso = "2025-06-18T15:30:00.000Z",
  timeZone = UTC,
  weekStartsOn = 1,
): ActivityRangeResult {
  return resolveActivityRange({ range, nowMs: ms(nowIso), timeZone, weekStartsOn });
}

function covers(window: ActivityWindow, instantMs: number): boolean {
  return (window.startMs === null || instantMs >= window.startMs) && instantMs < window.endMs;
}

function ready(result: ActivityRangeResult): {
  readonly current: ActivityWindow;
  readonly comparison: ActivityWindow | null;
} {
  if (result.status !== "ready") throw new Error(`expected a ready window, got ${result.reason}`);
  return { current: result.current, comparison: result.comparison };
}

describe("resolveActivityRange", () => {
  it("reads the same event as Yesterday and Last 24 hours in UTC but Today in New York just after a UTC midnight", () => {
    const nowIso = "2025-06-15T00:01:00.000Z";
    const event = ms("2025-06-14T23:59:00.000Z");

    const utcToday = ready(resolve({ kind: "today" }, nowIso, UTC)).current;
    const utcYesterday = ready(resolve({ kind: "yesterday" }, nowIso, UTC)).current;
    const utcLast24 = ready(resolve({ kind: "last-24-hours" }, nowIso, UTC)).current;
    const nyToday = ready(resolve({ kind: "today" }, nowIso, NEW_YORK)).current;

    expect(utcToday).toEqual({ startMs: ms("2025-06-15T00:00:00.000Z"), endMs: ms(nowIso) });
    expect(covers(utcToday, event)).toBe(false);
    expect(covers(utcYesterday, event)).toBe(true);
    expect(covers(utcLast24, event)).toBe(true);
    expect(nyToday).toEqual({ startMs: ms("2025-06-14T04:00:00.000Z"), endMs: ms(nowIso) });
    expect(covers(nyToday, event)).toBe(true);
  });

  it("resolves all nine ranges into precise windows at one instant", () => {
    const nowIso = "2025-06-18T15:30:00.000Z";
    const cases: ReadonlyArray<{
      readonly range: ActivityRange;
      readonly current: ActivityWindow;
      readonly comparison: ActivityWindow | null;
    }> = [
      {
        range: { kind: "today" },
        current: { startMs: ms("2025-06-18T00:00:00.000Z"), endMs: ms(nowIso) },
        comparison: {
          startMs: ms("2025-06-17T00:00:00.000Z"),
          endMs: ms("2025-06-17T15:30:00.000Z"),
        },
      },
      {
        range: { kind: "last-24-hours" },
        current: { startMs: ms("2025-06-17T15:30:00.000Z"), endMs: ms(nowIso) },
        comparison: {
          startMs: ms("2025-06-16T15:30:00.000Z"),
          endMs: ms("2025-06-17T15:30:00.000Z"),
        },
      },
      {
        range: { kind: "yesterday" },
        current: { startMs: ms("2025-06-17T00:00:00.000Z"), endMs: ms("2025-06-18T00:00:00.000Z") },
        comparison: {
          startMs: ms("2025-06-16T00:00:00.000Z"),
          endMs: ms("2025-06-17T00:00:00.000Z"),
        },
      },
      {
        range: { kind: "this-week" },
        current: { startMs: ms("2025-06-16T00:00:00.000Z"), endMs: ms(nowIso) },
        comparison: {
          startMs: ms("2025-06-09T00:00:00.000Z"),
          endMs: ms("2025-06-11T15:30:00.000Z"),
        },
      },
      {
        range: { kind: "this-month" },
        current: { startMs: ms("2025-06-01T00:00:00.000Z"), endMs: ms(nowIso) },
        comparison: {
          startMs: ms("2025-05-01T00:00:00.000Z"),
          endMs: ms("2025-05-18T15:30:00.000Z"),
        },
      },
      {
        range: { kind: "last-month" },
        current: { startMs: ms("2025-05-01T00:00:00.000Z"), endMs: ms("2025-06-01T00:00:00.000Z") },
        comparison: {
          startMs: ms("2025-04-01T00:00:00.000Z"),
          endMs: ms("2025-05-01T00:00:00.000Z"),
        },
      },
      {
        range: { kind: "this-year" },
        current: { startMs: ms("2025-01-01T00:00:00.000Z"), endMs: ms(nowIso) },
        comparison: {
          startMs: ms("2024-01-01T00:00:00.000Z"),
          endMs: ms("2024-06-17T15:30:00.000Z"),
        },
      },
      {
        range: { kind: "total" },
        current: { startMs: null, endMs: ms(nowIso) },
        comparison: null,
      },
      {
        range: { kind: "custom", startDate: "2025-06-10", endDate: "2025-06-12" },
        current: { startMs: ms("2025-06-10T00:00:00.000Z"), endMs: ms("2025-06-13T00:00:00.000Z") },
        comparison: {
          startMs: ms("2025-06-07T00:00:00.000Z"),
          endMs: ms("2025-06-10T00:00:00.000Z"),
        },
      },
    ];

    for (const entry of cases) {
      expect(ready(resolve(entry.range, nowIso)), `range ${entry.range.kind}`).toEqual({
        current: entry.current,
        comparison: entry.comparison,
      });
    }
  });

  it("measures a spring-forward civil day as 23 hours and a fall-back day as 25, while Last 24 hours stays exact", () => {
    const springYesterday = ready(
      resolve({ kind: "yesterday" }, "2025-03-10T15:00:00.000Z", NEW_YORK),
    ).current;
    expect(springYesterday).toEqual({
      startMs: ms("2025-03-09T05:00:00.000Z"),
      endMs: ms("2025-03-10T04:00:00.000Z"),
    });
    expect(springYesterday.endMs - (springYesterday.startMs ?? 0)).toBe(23 * 3_600_000);

    const fallYesterday = ready(
      resolve({ kind: "yesterday" }, "2025-11-03T15:00:00.000Z", NEW_YORK),
    ).current;
    expect(fallYesterday).toEqual({
      startMs: ms("2025-11-02T04:00:00.000Z"),
      endMs: ms("2025-11-03T05:00:00.000Z"),
    });
    expect(fallYesterday.endMs - (fallYesterday.startMs ?? 0)).toBe(25 * 3_600_000);

    const rolling = ready(
      resolve({ kind: "last-24-hours" }, "2025-03-10T15:00:00.000Z", NEW_YORK),
    ).current;
    expect(rolling).toEqual({
      startMs: ms("2025-03-09T15:00:00.000Z"),
      endMs: ms("2025-03-10T15:00:00.000Z"),
    });
  });

  it("compares week-to-date against the same wall time in the previous week across a daylight-saving change", () => {
    const result = ready(resolve({ kind: "this-week" }, "2025-03-12T13:30:00.000Z", NEW_YORK, 0));
    expect(result.current).toEqual({
      startMs: ms("2025-03-09T05:00:00.000Z"),
      endMs: ms("2025-03-12T13:30:00.000Z"),
    });
    expect(result.comparison).toEqual({
      startMs: ms("2025-03-02T05:00:00.000Z"),
      endMs: ms("2025-03-05T14:30:00.000Z"),
    });
  });

  it("compares day-to-date against the same wall time yesterday across a daylight-saving change", () => {
    const result = ready(resolve({ kind: "today" }, "2025-03-09T13:30:00.000Z", NEW_YORK));
    expect(result.current).toEqual({
      startMs: ms("2025-03-09T05:00:00.000Z"),
      endMs: ms("2025-03-09T13:30:00.000Z"),
    });
    expect(result.comparison).toEqual({
      startMs: ms("2025-03-08T05:00:00.000Z"),
      endMs: ms("2025-03-08T14:30:00.000Z"),
    });
  });

  it("caps the month-to-date comparison at the previous month's end", () => {
    const result = ready(resolve({ kind: "this-month" }, "2025-03-31T20:00:00.000Z"));
    expect(result.comparison).toEqual({
      startMs: ms("2025-02-01T00:00:00.000Z"),
      endMs: ms("2025-03-01T00:00:00.000Z"),
    });
  });

  it("rolls previous periods over month and year boundaries", () => {
    const nowIso = "2025-01-15T12:00:00.000Z";

    expect(ready(resolve({ kind: "this-month" }, nowIso)).comparison).toEqual({
      startMs: ms("2024-12-01T00:00:00.000Z"),
      endMs: ms("2024-12-15T12:00:00.000Z"),
    });
    expect(ready(resolve({ kind: "last-month" }, nowIso))).toEqual({
      current: { startMs: ms("2024-12-01T00:00:00.000Z"), endMs: ms("2025-01-01T00:00:00.000Z") },
      comparison: {
        startMs: ms("2024-11-01T00:00:00.000Z"),
        endMs: ms("2024-12-01T00:00:00.000Z"),
      },
    });
    expect(ready(resolve({ kind: "this-year" }, nowIso)).comparison).toEqual({
      startMs: ms("2024-01-01T00:00:00.000Z"),
      endMs: ms("2024-01-15T12:00:00.000Z"),
    });
  });

  it("starts the week on the configured weekday", () => {
    const saturdayStart = ready(resolve({ kind: "this-week" }, "2025-06-18T15:30:00.000Z", UTC, 6));
    expect(saturdayStart.current).toEqual({
      startMs: ms("2025-06-14T00:00:00.000Z"),
      endMs: ms("2025-06-18T15:30:00.000Z"),
    });
    expect(saturdayStart.comparison).toEqual({
      startMs: ms("2025-06-07T00:00:00.000Z"),
      endMs: ms("2025-06-11T15:30:00.000Z"),
    });

    const sundayStart = ready(resolve({ kind: "this-week" }, "2025-06-15T10:00:00.000Z", UTC, 0));
    expect(sundayStart.current).toEqual({
      startMs: ms("2025-06-15T00:00:00.000Z"),
      endMs: ms("2025-06-15T10:00:00.000Z"),
    });
    expect(sundayStart.comparison).toEqual({
      startMs: ms("2025-06-08T00:00:00.000Z"),
      endMs: ms("2025-06-08T10:00:00.000Z"),
    });
  });

  it("resolves a one-day custom range across a month boundary", () => {
    const result = ready(
      resolve({ kind: "custom", startDate: "2025-03-01", endDate: "2025-03-01" }),
    );
    expect(result.current).toEqual({
      startMs: ms("2025-03-01T00:00:00.000Z"),
      endMs: ms("2025-03-02T00:00:00.000Z"),
    });
    expect(result.comparison).toEqual({
      startMs: ms("2025-02-28T00:00:00.000Z"),
      endMs: ms("2025-03-01T00:00:00.000Z"),
    });
  });

  it("refuses a custom range whose end precedes its start", () => {
    expect(resolve({ kind: "custom", startDate: "2025-06-10", endDate: "2025-06-09" })).toEqual({
      status: "refused",
      reason: "reversed-custom-range",
    });
  });

  it.each([
    { startDate: "2025-02-30", endDate: "2025-03-01" },
    { startDate: "2025-06-01", endDate: "2025-06-31" },
    { startDate: "2025-13-01", endDate: "2025-13-02" },
    { startDate: "0000-01-01", endDate: "2025-01-02" },
    { startDate: "2025-6-10", endDate: "2025-06-12" },
    { startDate: "2025-06-10", endDate: "2025-06-1" },
    { startDate: "06/10/2025", endDate: "2025-06-12" },
    { startDate: "not-a-date", endDate: "2025-06-12" },
  ])("refuses the impossible or malformed custom dates $startDate – $endDate", (dates) => {
    expect(resolve({ kind: "custom", ...dates })).toEqual({
      status: "refused",
      reason: "invalid-custom-date",
    });
  });

  it("refuses an unreadable clock", () => {
    for (const nowMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      ms("2025-06-18T15:30:00.000Z") + 0.5,
      ms("0001-01-01T00:00:00.000Z") - 1,
      ms("+010000-01-01T00:00:00.000Z"),
    ]) {
      expect(
        resolveActivityRange({ range: { kind: "today" }, nowMs, timeZone: UTC, weekStartsOn: 1 }),
      ).toEqual({ status: "refused", reason: "invalid-clock" });
    }
  });

  it("accepts instants at the edges of the supported range", () => {
    for (const nowIso of ["0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z"]) {
      expect(
        resolveActivityRange({
          range: { kind: "total" },
          nowMs: ms(nowIso),
          timeZone: UTC,
          weekStartsOn: 1,
        }).status,
      ).toBe("ready");
    }
  });

  it("omits the comparison when the previous civil period falls before year 1", () => {
    const yesterday = ready(resolve({ kind: "yesterday" }, "0001-01-02T12:00:00.000Z"));
    expect(yesterday.current).toEqual({
      startMs: ms("0001-01-01T00:00:00.000Z"),
      endMs: ms("0001-01-02T00:00:00.000Z"),
    });
    expect(yesterday.comparison).toBeNull();

    const custom = ready(
      resolve({ kind: "custom", startDate: "0001-01-01", endDate: "0001-01-01" }),
    );
    expect(custom.current).toEqual({
      startMs: ms("0001-01-01T00:00:00.000Z"),
      endMs: ms("0001-01-02T00:00:00.000Z"),
    });
    expect(custom.comparison).toBeNull();
  });

  it("resolves a custom range ending on the last day of year 9999 into year 10000", () => {
    const result = ready(
      resolve({ kind: "custom", startDate: "9999-12-31", endDate: "9999-12-31" }),
    );
    expect(result.current).toEqual({
      startMs: ms("9999-12-31T00:00:00.000Z"),
      endMs: ms("+010000-01-01T00:00:00.000Z"),
    });
    expect(result.comparison).toEqual({
      startMs: ms("9999-12-30T00:00:00.000Z"),
      endMs: ms("9999-12-31T00:00:00.000Z"),
    });
  });

  it("recognises only strict Gregorian calendar dates", () => {
    for (const value of ["2025-06-10", "2024-02-29", "9999-12-31", "0001-01-01"]) {
      expect(isActivityCalendarDate(value)).toBe(true);
    }
    for (const value of [
      "2025-02-30",
      "2025-06-31",
      "2023-02-29",
      "0000-01-01",
      "2025-13-01",
      "2025-00-10",
      "2025-06-00",
      "2025-6-10",
      "2025-06-1x",
      " 2025-06-10",
      "",
    ]) {
      expect(isActivityCalendarDate(value)).toBe(false);
    }
  });

  it("refuses a time zone the runtime cannot format", () => {
    for (const timeZone of ["Mars/Olympus_Mons", "", "not a zone"]) {
      expect(
        resolveActivityRange({
          range: { kind: "today" },
          nowMs: ms("2025-06-18T15:30:00.000Z"),
          timeZone,
          weekStartsOn: 1,
        }),
      ).toEqual({ status: "refused", reason: "invalid-time-zone" });
    }
  });

  it("refuses a week start outside Sunday through Saturday", () => {
    for (const weekStartsOn of [-1, 7, 1.5, Number.NaN]) {
      expect(
        resolveActivityRange({
          range: { kind: "this-week" },
          nowMs: ms("2025-06-18T15:30:00.000Z"),
          timeZone: UTC,
          weekStartsOn,
        }),
      ).toEqual({ status: "refused", reason: "invalid-week-start" });
    }
  });

  it("returns no comparison while still at the period's first instant", () => {
    expect(
      ready(resolve({ kind: "this-week" }, "2025-06-16T00:00:00.000Z", UTC, 1)).comparison,
    ).toBeNull();
    expect(ready(resolve({ kind: "today" }, "2025-06-18T00:00:00.000Z")).comparison).toBeNull();
  });

  it("resolves an ambiguous comparison wall time to the earlier instant of the fold", () => {
    const result = ready(resolve({ kind: "today" }, "2025-11-03T06:30:00.000Z", NEW_YORK));
    expect(result.comparison).toEqual({
      startMs: ms("2025-11-02T04:00:00.000Z"),
      endMs: ms("2025-11-02T05:30:00.000Z"),
    });
  });

  it("resolves a skipped comparison wall time to the first valid instant after the gap", () => {
    const result = ready(resolve({ kind: "today" }, "2025-03-10T06:30:00.000Z", NEW_YORK));
    expect(result.comparison).toEqual({
      startMs: ms("2025-03-09T05:00:00.000Z"),
      endMs: ms("2025-03-09T07:00:00.000Z"),
    });
  });

  it("starts a civil day at its first real instant when a transition skips local midnight", () => {
    const result = ready(resolve({ kind: "yesterday" }, "2018-11-05T12:00:00.000Z", SAO_PAULO));
    expect(result.current).toEqual({
      startMs: ms("2018-11-04T03:00:00.000Z"),
      endMs: ms("2018-11-05T02:00:00.000Z"),
    });
  });

  it("opens a day whose skipped midnight is only now arriving without a comparison", () => {
    // Sao Paulo's 2018 spring-forward erased 00:00–01:00 on 4 November, so
    // the day's first real instant is 01:00 local; one hour of wall time has
    // elapsed on the clock but none of the day has actually passed.
    const result = ready(resolve({ kind: "today" }, "2018-11-04T03:00:00.000Z", SAO_PAULO));
    expect(result.current).toEqual({
      startMs: ms("2018-11-04T03:00:00.000Z"),
      endMs: ms("2018-11-04T03:00:00.000Z"),
    });
    expect(result.comparison).toBeNull();
  });
});

describe("activityRangeForCard", () => {
  it("reads a store with no recorded choices as this week from GitHub", () => {
    expect(DEFAULT_HOME_ACTIVITY).toEqual({
      sharedRange: { kind: "this-week" },
      source: "github",
      pins: [],
    });
    expect(activityRangeForCard(DEFAULT_HOME_ACTIVITY, "runs")).toEqual({
      kind: "this-week",
    });
  });

  it("returns the shared range for every card the person did not pin", () => {
    const settings: HomeActivityCustomization = {
      sharedRange: { kind: "last-month" },
      source: "octant",
      pins: [{ card: "runs", range: { kind: "today" } }],
    };
    expect(activityRangeForCard(settings, "prs-merged")).toEqual({ kind: "last-month" });
    expect(activityRangeForCard(settings, "issues-closed")).toEqual({ kind: "last-month" });
    expect(activityRangeForCard(settings, "releases-published")).toEqual({
      kind: "last-month",
    });
  });

  it("returns a card's own pinned range", () => {
    const settings: HomeActivityCustomization = {
      sharedRange: { kind: "this-week" },
      source: "github",
      pins: [
        {
          card: "issues-closed",
          range: { kind: "custom", startDate: "2026-08-01", endDate: "2026-08-14" },
        },
      ],
    };
    expect(activityRangeForCard(settings, "issues-closed")).toEqual({
      kind: "custom",
      startDate: "2026-08-01",
      endDate: "2026-08-14",
    });
  });
});
