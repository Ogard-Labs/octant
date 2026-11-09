import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVENT_LOOP_LAG_MS,
  eventLoopLagThresholdFromEnvironment,
  readEventLoopLagCounters,
  startEventLoopLagDetector,
  takeEventLoopLagWindow,
} from "./eventLoopLag";

function harness(thresholdMs: number) {
  let clock = 0;
  let tick: () => void = () => undefined;
  let unrefCalls = 0;
  const lines: Array<string> = [];
  const stop = startEventLoopLagDetector({
    thresholdMs,
    intervalMs: 50,
    now: () => clock,
    log: (line) => lines.push(line),
    setTimer: (callback) => {
      tick = callback;
      return {
        unref: () => {
          unrefCalls += 1;
        },
      };
    },
  });
  return {
    lines,
    stop,
    unrefCalls: () => unrefCalls,
    fire: (atMs: number) => {
      clock = atMs;
      tick();
    },
  };
}

describe("event loop lag detector", () => {
  it("logs and counts a late tick once, and ignores on-time ticks", () => {
    const before = readEventLoopLagCounters();
    const h = harness(100);
    h.fire(55);
    expect(h.lines).toEqual([]);
    h.fire(405);
    expect(h.lines).toHaveLength(1);
    const after = readEventLoopLagCounters();
    expect(after.count).toBe(before.count + 1);
    expect(after.worstMs).toBeGreaterThanOrEqual(300);
  });

  it("hands each host-health window only the stalls since the last one, keeping the lifetime tally", () => {
    takeEventLoopLagWindow();
    const before = readEventLoopLagCounters();
    const h = harness(100);
    h.fire(405);

    expect(takeEventLoopLagWindow()).toEqual({ count: 1, worstMs: 355 });
    expect(takeEventLoopLagWindow()).toEqual({ count: 0, worstMs: 0 });
    expect(readEventLoopLagCounters().count).toBe(before.count + 1);
    h.stop();
  });

  it("does not keep the process alive", () => {
    const h = harness(100);
    expect(h.unrefCalls()).toBe(1);
  });

  it("reads its threshold from the variable with a default", () => {
    expect(eventLoopLagThresholdFromEnvironment({})).toBe(DEFAULT_EVENT_LOOP_LAG_MS);
    expect(eventLoopLagThresholdFromEnvironment({ OCTANT_EVENT_LOOP_LAG_MS: "250" })).toBe(250);
  });
});
