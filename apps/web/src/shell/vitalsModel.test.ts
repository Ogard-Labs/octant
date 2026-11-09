import { describe, expect, it } from "vitest";
import type { HostResourceSnapshot } from "@octant/contracts/host-resources";
import {
  appendVitalsSample,
  formatBytes,
  formatRate,
  sparklinePoints,
  VITALS_HISTORY_LIMIT,
} from "./vitalsModel";

function sample(second: number): HostResourceSnapshot {
  return {
    cores: 8,
    cpuPercent: 10,
    memory: { usedBytes: 1, totalBytes: 2 },
    sampledAt: `2026-11-09T12:00:${String(second % 60).padStart(2, "0")}.000Z` as never,
  };
}

describe("vitals history", () => {
  it("adds no point when the host answers with a sample it already gave", () => {
    const one = appendVitalsSample([], sample(1));
    expect(appendVitalsSample(one, sample(1))).toHaveLength(1);
  });

  it("keeps only the newest window of samples", () => {
    let history: ReadonlyArray<HostResourceSnapshot> = [];
    for (let second = 0; second < VITALS_HISTORY_LIMIT + 5; second += 1) {
      history = appendVitalsSample(history, {
        ...sample(0),
        sampledAt: new Date(Date.UTC(2026, 10, 9, 12, 0, second)).toISOString() as never,
      });
    }
    expect(history).toHaveLength(VITALS_HISTORY_LIMIT);
  });

  it("formats rates and bytes with decimal units", () => {
    expect(formatBytes(12_100_000_000)).toBe("12.1G");
    expect(formatRate(843_000)).toBe("843K/s");
  });

  it("draws the newest sample at the right edge and the maximum at the top", () => {
    expect(sparklinePoints([100], 100, 59, 10)).toBe("59.0,0.0");
    expect(sparklinePoints([], 100, 59, 10)).toBe("");
  });
});
