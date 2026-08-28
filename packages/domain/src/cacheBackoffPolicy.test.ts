import { describe, expect, it } from "vitest";
import {
  CACHE_BACKOFF_CEILING_MS,
  CACHE_BACKOFF_FIRST_DELAY_MS,
  cacheBackoffDelayMs,
  cacheBackoffHolds,
  extendCacheBackoff,
} from "./cacheBackoffPolicy";

describe("cache backoff policy", () => {
  it("imposes no wait while no failure has been observed", () => {
    expect(cacheBackoffDelayMs(0)).toBe(0);
    expect(cacheBackoffHolds(undefined, 1_000)).toBe(false);
  });

  it("doubles the wait for each consecutive failure", () => {
    expect(cacheBackoffDelayMs(1)).toBe(CACHE_BACKOFF_FIRST_DELAY_MS);
    expect(cacheBackoffDelayMs(2)).toBe(CACHE_BACKOFF_FIRST_DELAY_MS * 2);
    expect(cacheBackoffDelayMs(3)).toBe(CACHE_BACKOFF_FIRST_DELAY_MS * 4);
  });

  it("never waits longer than a quarter of an hour", () => {
    expect(cacheBackoffDelayMs(6)).toBe(CACHE_BACKOFF_CEILING_MS);
    expect(cacheBackoffDelayMs(50)).toBe(CACHE_BACKOFF_CEILING_MS);
    expect(cacheBackoffDelayMs(Number.MAX_SAFE_INTEGER)).toBe(CACHE_BACKOFF_CEILING_MS);
  });

  it("counts the streak and schedules the next attempt from the failure", () => {
    const first = extendCacheBackoff(undefined, 1_000);
    expect(first).toEqual({
      failureStreak: 1,
      retryAt: 1_000 + CACHE_BACKOFF_FIRST_DELAY_MS,
    });

    const second = extendCacheBackoff(first, 2_000);
    expect(second).toEqual({
      failureStreak: 2,
      retryAt: 2_000 + CACHE_BACKOFF_FIRST_DELAY_MS * 2,
    });
  });

  it("holds reads back only until the scheduled attempt", () => {
    const backoff = extendCacheBackoff(undefined, 0);
    expect(cacheBackoffHolds(backoff, CACHE_BACKOFF_FIRST_DELAY_MS - 1)).toBe(true);
    expect(cacheBackoffHolds(backoff, CACHE_BACKOFF_FIRST_DELAY_MS)).toBe(false);
  });
});
