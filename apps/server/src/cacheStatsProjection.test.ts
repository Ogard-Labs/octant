import { describe, expect, it } from "vitest";
import { CacheStatsProjection } from "./cacheStatsProjection";
import { CACHE_BACKOFF_FIRST_DELAY_MS } from "@octant/domain/cache-backoff-policy";

function projectionAt(clock: { ms: number }) {
  return new CacheStatsProjection({
    now: () => clock.ms,
    clock: () => new Date(clock.ms).toISOString(),
  });
}

describe("host cache statistics", () => {
  it("reports the hit ratio a reader can compare caches by", () => {
    const clock = { ms: 1_000 };
    const projection = projectionAt(clock);

    projection.recordHit("github-catalogue");
    projection.recordHit("github-catalogue");
    projection.recordMiss("github-catalogue");

    expect(projection.read()).toEqual([
      expect.objectContaining({
        key: "github-catalogue",
        hitCount: 2,
        missCount: 1,
        hitRatio: 2 / 3,
        failureStreak: 0,
      }),
    ]);
  });

  it("states a cache nobody has refreshed as never refreshed rather than fresh", () => {
    const clock = { ms: 5_000 };
    const projection = projectionAt(clock);

    projection.recordMiss("pull-request-list");

    const [stat] = projection.read();
    expect(stat?.lastRefreshAt).toBeUndefined();
    expect(stat?.stalenessMs).toBeUndefined();
    expect(stat?.hitRatio).toBe(0);
  });

  it("ages a refreshed cache so staleness is visible without another refresh", () => {
    const clock = { ms: 10_000 };
    const projection = projectionAt(clock);

    projection.recordRefreshSucceeded("pull-request-list");
    clock.ms += 45_000;

    const [stat] = projection.read();
    expect(stat?.lastRefreshAt).toBe(new Date(10_000).toISOString());
    expect(stat?.stalenessMs).toBe(45_000);
  });

  it("paces an unattended refresh after a failure and releases it when the delay passes", () => {
    const clock = { ms: 0 };
    const projection = projectionAt(clock);

    projection.recordRefreshFailed("github-catalogue");
    expect(projection.holdsUnattendedRefresh("github-catalogue")).toBe(true);
    expect(projection.read()[0]?.retryAt).toBe(
      new Date(CACHE_BACKOFF_FIRST_DELAY_MS).toISOString(),
    );

    clock.ms = CACHE_BACKOFF_FIRST_DELAY_MS;
    expect(projection.holdsUnattendedRefresh("github-catalogue")).toBe(false);
    expect(projection.read()[0]?.retryAt).toBeUndefined();
  });

  it("clears the failure streak once a refresh succeeds", () => {
    const clock = { ms: 0 };
    const projection = projectionAt(clock);

    projection.recordRefreshFailed("github-catalogue");
    projection.recordRefreshFailed("github-catalogue");
    expect(projection.read()[0]?.failureStreak).toBe(2);

    projection.recordRefreshSucceeded("github-catalogue");

    expect(projection.read()[0]?.failureStreak).toBe(0);
    expect(projection.holdsUnattendedRefresh("github-catalogue")).toBe(false);
  });
});
