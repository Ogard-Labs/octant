import { describe, expect, it } from "vitest";
import { ProcessAuthorityClock } from "./processAuthorityClock";

describe("ProcessAuthorityClock", () => {
  it("starts a fresh authority epoch after a long shutdown instead of recovering durable time", () => {
    const twoMonthsMs = 60 * 24 * 60 * 60 * 1_000;
    let wallClockMs = Date.UTC(2026, 0, 1);
    let elapsedSinceBootMs = 10_000;
    const firstProcess = new ProcessAuthorityClock({
      wallClock: () => wallClockMs,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    expect(firstProcess.nowMs()).toBe(wallClockMs);

    wallClockMs += twoMonthsMs;
    elapsedSinceBootMs = 250;
    const restarted = new ProcessAuthorityClock({
      wallClock: () => wallClockMs,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });

    expect(restarted.nowMs()).toBe(wallClockMs);
    expect(restarted.postureKind()).toBe("ok");
  });

  it("expires process-local authority from suspend-aware elapsed time, not wall-clock changes", () => {
    let wallClockMs = Date.UTC(2026, 0, 1);
    let elapsedSinceBootMs = 1_000;
    const clock = new ProcessAuthorityClock({
      wallClock: () => wallClockMs,
      suspendAwareElapsedSource: () => elapsedSinceBootMs,
    });
    const startedAt = wallClockMs;
    expect(clock.nowMs()).toBe(startedAt);

    wallClockMs += 365 * 24 * 60 * 60 * 1_000;
    elapsedSinceBootMs += 5_000;
    expect(clock.nowMs()).toBe(startedAt + 5_000);

    wallClockMs = 0;
    elapsedSinceBootMs += 2_000;
    expect(clock.clamp(wallClockMs)).toBe(startedAt + 7_000);
    expect(clock.postureKind()).toBe("ok");
  });
});
