import { decodeUtcTimestamp } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  automationTotalsLine,
  compactSpan,
  nextRunCell,
  runStripCells,
  runStripSummary,
} from "./automationTable";

const NOW = "2026-11-17T12:00:00.000Z";
const at = (hoursAgo: number) =>
  decodeUtcTimestamp(new Date(Date.parse(NOW) - hoursAgo * 3_600_000).toISOString());
const weekly = {
  kind: "weekly-local",
  weekdays: [1],
  localTime: "09:00",
  timeZone: "UTC",
} as const;

describe("the run strip", () => {
  it("always draws seven cells with the newest run in the last one", () => {
    const cells = runStripCells([
      { lifecycle: "failed", at: at(48) },
      { lifecycle: "completed", at: at(24) },
    ]);
    expect(cells).toHaveLength(7);
    expect(cells.slice(0, 5).every((cell) => cell.tone === "empty")).toBe(true);
    expect(cells[5]?.tone).toBe("failure");
    expect(cells[6]?.tone).toBe("success");
  });

  it("says what the cells show in words", () => {
    expect(runStripSummary(undefined)).toBe("No runs yet");
    expect(
      runStripSummary([
        { lifecycle: "completed", at: at(3) },
        { lifecycle: "interrupted", at: at(2) },
        { lifecycle: "completed", at: at(1) },
      ]),
    ).toBe("Last 3 runs: 2 completed, 1 failed");
  });
});

describe("the next run cell", () => {
  it("names the day and time of a scheduled run and how far off it is", () => {
    const cell = nextRunCell(
      {
        lifecycle: "enabled",
        trigger: weekly as never,
        nextDueAt: decodeUtcTimestamp("2026-11-18T09:55:00.000Z"),
      },
      NOW,
      { timeZone: "UTC" },
    );
    expect(cell.primary).toBe("Wed 09:55");
    expect(cell.secondary).toBe("in 21h 55m");
  });

  it("says Paused and when it last ran, instead of a time it will not run at", () => {
    const cell = nextRunCell(
      {
        lifecycle: "paused",
        trigger: weekly as never,
        nextDueAt: null,
        recentRuns: [{ lifecycle: "completed", at: at(50 * 24) }],
      },
      NOW,
    );
    expect(cell).toEqual({ primary: "Paused", secondary: "last 50d ago", tone: "paused" });
  });
});

describe("a finished one-time routine", () => {
  it("says Done and when it last ran", () => {
    const cell = nextRunCell(
      {
        lifecycle: "enabled",
        trigger: { kind: "once", scheduledAt: at(72) } as never,
        nextDueAt: null,
        recentRuns: [{ lifecycle: "completed", at: at(72) }],
      },
      NOW,
    );
    expect(cell).toEqual({ primary: "Done", secondary: "last 3d ago", tone: "quiet" });
  });
});

describe("the totals line", () => {
  it("reads enabled, runs and the share that succeeded", () => {
    expect(
      automationTotalsLine({
        automations: 100,
        enabled: 25,
        windowDays: 30,
        runs: 299,
        succeeded: 149,
      }),
    ).toBe("25 of 100 enabled · 299 runs in 30 days · 49.8% succeeded");
  });

  it("leaves out the share when nothing ran", () => {
    expect(
      automationTotalsLine({ automations: 2, enabled: 1, windowDays: 30, runs: 0, succeeded: 0 }),
    ).toBe("1 of 2 enabled · 0 runs in 30 days");
  });

  it("writes short spans the way a table cell has room for", () => {
    expect(compactSpan(30_000)).toBe("now");
    expect(compactSpan(12 * 60_000)).toBe("12m");
    expect(compactSpan((2 * 24 + 8) * 3_600_000)).toBe("2d 8h");
  });
});
