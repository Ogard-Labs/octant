import { MAX_HOST_HEALTH_POINTS, type HostHealthSample } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { hostHealthPoints } from "./hostHealthPolicy";

function sample(minute: number, overrides: Partial<HostHealthSample> = {}): HostHealthSample {
  return {
    sampledAt: new Date(Date.UTC(2026, 10, 7, 10, 0) + minute * 60_000).toISOString(),
    windowMs: 60_000,
    processStartedAt: "2026-11-07T09:00:00.000Z",
    rssBytes: 100,
    heapUsedBytes: 50,
    databaseBytes: 1_000,
    eventLoopLagCount: 1,
    eventLoopLagWorstMs: 120,
    slowStatementCount: 0,
    slowStatementWorstMs: 0,
    latency: [{ key: "rpc", count: 10, p50Ms: 5, p95Ms: 20, maxMs: 30 }],
    ...overrides,
  } as HostHealthSample;
}

describe("host health points", () => {
  it("returns minutes as recorded, oldest first, when they fit", () => {
    const points = hostHealthPoints([sample(2), sample(1)], undefined);

    expect(points.resolution).toBe("minute");
    expect(points.samples.map((point) => point.sampledAt.slice(11, 16))).toEqual([
      "10:01",
      "10:02",
    ]);
  });

  it("rolls an hour up by summing what it counted and keeping the worst it measured", () => {
    const points = hostHealthPoints(
      [
        sample(1, { rssBytes: 300, eventLoopLagWorstMs: 900 }),
        sample(2, {
          processStartedAt: "2026-11-07T10:01:30.000Z",
          latency: [{ key: "rpc", count: 5, p50Ms: 8, p95Ms: 400, maxMs: 700 }],
        }),
        sample(61),
      ],
      "hour",
    );

    expect(points.samples).toHaveLength(2);
    expect(points.samples[0]).toMatchObject({
      sampledAt: "2026-11-07T10:00:00.000Z",
      windowMs: 120_000,
      rssBytes: 300,
      eventLoopLagCount: 2,
      eventLoopLagWorstMs: 900,
      processStartedAt: "2026-11-07T10:01:30.000Z",
      latency: [{ key: "rpc", count: 15, p50Ms: 8, p95Ms: 400, maxMs: 700 }],
    });
  });

  it("counts every restart, even two inside one rolled-up hour", () => {
    const points = hostHealthPoints(
      [
        sample(1),
        sample(10, { processStartedAt: "2026-11-07T10:09:00.000Z" }),
        sample(20, { processStartedAt: "2026-11-07T10:19:00.000Z" }),
      ],
      "hour",
    );

    expect(points.samples).toHaveLength(1);
    expect(points.processStarts).toEqual([
      "2026-11-07T09:00:00.000Z",
      "2026-11-07T10:09:00.000Z",
      "2026-11-07T10:19:00.000Z",
    ]);
  });

  it("switches to hours on its own when the minutes would not fit in one read", () => {
    const minutes = Array.from({ length: MAX_HOST_HEALTH_POINTS + 1 }, (_unused, index) =>
      sample(index),
    );

    const points = hostHealthPoints(minutes, undefined);

    expect(points.resolution).toBe("hour");
    expect(points.samples.length).toBeLessThanOrEqual(MAX_HOST_HEALTH_POINTS);
  });
});
