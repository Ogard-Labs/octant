import { decodeUtcTimestamp } from "@octant/contracts";
import type { ProviderRateLimitWindow } from "@octant/contracts/context";
import { describe, expect, it } from "vitest";
import type { ComposerContextUsageFallback } from "./composerContextMeterScope";
import { composerLimitWindows } from "./composerLimitWindows";

const observedAt = decodeUtcTimestamp("2026-10-10T09:00:00.000Z");
const now = Date.parse("2026-10-10T09:00:00.000Z");

function snapshotWith(windows: ReadonlyArray<ProviderRateLimitWindow>) {
  return { serviceLimits: { rateLimitWindows: windows } };
}

function fallbackWith(
  limits: ComposerContextUsageFallback["limits"],
): ComposerContextUsageFallback {
  return { limits };
}

describe("composer limit windows", () => {
  it("shows the windows the provider reported, as the share left", () => {
    const rows = composerLimitWindows({
      now,
      snapshot: snapshotWith([
        { window: "five_hour", status: "allowed", utilization: 0.12, observedAt },
        { window: "seven_day", status: "allowed", utilization: 0.62, observedAt },
      ]),
    });

    expect(rows.map((row) => [row.short, row.percent, row.level])).toEqual([
      ["5h", 88, "ok"],
      ["Week", 38, "ok"],
    ]);
  });

  it("draws no bar for a window without a figure", () => {
    const rows = composerLimitWindows({
      now,
      snapshot: snapshotWith([{ window: "five_hour", status: "allowed", observedAt }]),
    });

    expect(rows).toEqual([]);
  });

  it("draws no bar for a window whose reset has passed, since its figure is from before it", () => {
    const rows = composerLimitWindows({
      now,
      snapshot: snapshotWith([
        {
          window: "five_hour",
          status: "warning",
          utilization: 0.85,
          resetsAt: decodeUtcTimestamp("2026-10-10T08:59:00.000Z"),
          observedAt,
        },
        {
          window: "seven_day",
          status: "allowed",
          utilization: 0.62,
          resetsAt: decodeUtcTimestamp("2026-10-12T00:00:00.000Z"),
          observedAt,
        },
      ]),
    });

    expect(rows.map((row) => row.short)).toEqual(["Week"]);
  });

  it("marks a window running low, and an exhausted one as spent", () => {
    const rows = composerLimitWindows({
      now,
      snapshot: snapshotWith([
        { window: "five_hour", status: "allowed", utilization: 0.85, observedAt },
        { window: "seven_day", status: "exhausted", utilization: 1, observedAt },
      ]),
    });

    expect(rows.map((row) => [row.percent, row.level])).toEqual([
      [15, "near"],
      [0, "spent"],
    ]);
  });

  it("answers from the Code thread's own report when the snapshot has no windows", () => {
    const rows = composerLimitWindows({
      now,
      snapshot: snapshotWith([]),
      fallback: fallbackWith([{ window: "primary_5h", status: "warning", utilization: 0.4 }]),
    });

    expect(rows.map((row) => [row.short, row.percent, row.level])).toEqual([["5h", 60, "near"]]);
  });

  it("names the provider's scope when it named one", () => {
    const rows = composerLimitWindows({
      now,
      fallback: fallbackWith([{ window: "gpt-5:seven_day", status: "allowed", utilization: 0.3 }]),
    });

    expect(rows[0]?.name).toBe("7-day limit, gpt-5");
  });

  it("draws nothing when no window was reported", () => {
    expect(composerLimitWindows({ now })).toEqual([]);
  });
});
