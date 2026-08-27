import type { UsageCacheStat, UtcTimestamp } from "@octant/contracts";
import { UtcTimestamp as UtcTimestampSchema } from "@octant/contracts";
import {
  cacheBackoffHolds,
  extendCacheBackoff,
  type CacheBackoff,
} from "@octant/domain/cache-backoff-policy";
import { Schema } from "effect";

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestampSchema);

/**
 * Caches whose read facts the usage dashboard reports, with the words a reader
 * sees. The key is the stable contract id; the label may be reworded.
 */
const CACHE_LABELS = {
  "pull-request-list": "Project pull requests",
  "pull-request-detail": "Pull-request review detail",
  "github-catalogue": "GitHub catalogue",
  "usage-project-resolution": "Usage Project resolution",
} as const;

export type ObservedCache = keyof typeof CACHE_LABELS;

/** What a cache owner reports; the caches never read their own statistics. */
export interface CacheStatsRecorder {
  recordHit(cache: ObservedCache): void;
  recordMiss(cache: ObservedCache): void;
  recordRefreshSucceeded(cache: ObservedCache): void;
  recordRefreshFailed(cache: ObservedCache): void;
  /** True while a refresh nobody asked for is being paced after failures. */
  holdsUnattendedRefresh(cache: ObservedCache): boolean;
}

interface CacheReading {
  hitCount: number;
  missCount: number;
  lastRefreshAt: UtcTimestamp | undefined;
  lastRefreshAtMs: number | undefined;
  backoff: CacheBackoff | undefined;
}

/**
 * Read model of how the host's own caches are behaving.
 *
 * These are operational observations of a running process, not domain facts: a
 * cache read is not something the user did, it happens on nearly every request,
 * and it carries no meaning once the process that served it is gone. They are
 * therefore counted in memory and reported alongside the usage query rather
 * than journalled, and they start again from zero at each host start — the
 * dashboard says so, so a reader never mistakes a restart for a cold cache.
 */
export class CacheStatsProjection implements CacheStatsRecorder {
  readonly #now: () => number;
  readonly #clock: () => string;
  readonly #readings = new Map<ObservedCache, CacheReading>();

  constructor(options?: { readonly now?: () => number; readonly clock?: () => string }) {
    this.#now = options?.now ?? Date.now;
    this.#clock = options?.clock ?? (() => new Date().toISOString());
  }

  recordHit(cache: ObservedCache): void {
    this.#reading(cache).hitCount += 1;
  }

  recordMiss(cache: ObservedCache): void {
    this.#reading(cache).missCount += 1;
  }

  recordRefreshSucceeded(cache: ObservedCache): void {
    const reading = this.#reading(cache);
    reading.lastRefreshAt = decodeUtcTimestamp(this.#clock());
    reading.lastRefreshAtMs = this.#now();
    reading.backoff = undefined;
  }

  recordRefreshFailed(cache: ObservedCache): void {
    const reading = this.#reading(cache);
    reading.backoff = extendCacheBackoff(reading.backoff, this.#now());
  }

  holdsUnattendedRefresh(cache: ObservedCache): boolean {
    return cacheBackoffHolds(this.#readings.get(cache)?.backoff, this.#now());
  }

  /** Facts for every cache read or refreshed since this host started. */
  read(): ReadonlyArray<UsageCacheStat> {
    const now = this.#now();
    const stats: UsageCacheStat[] = [];
    for (const [cache, reading] of this.#readings) {
      const reads = reading.hitCount + reading.missCount;
      stats.push({
        key: cache,
        label: CACHE_LABELS[cache],
        hitCount: reading.hitCount,
        missCount: reading.missCount,
        ...(reads === 0 ? {} : { hitRatio: reading.hitCount / reads }),
        ...(reading.lastRefreshAt === undefined ? {} : { lastRefreshAt: reading.lastRefreshAt }),
        ...(reading.lastRefreshAtMs === undefined
          ? {}
          : { stalenessMs: Math.max(0, Math.round(now - reading.lastRefreshAtMs)) }),
        failureStreak: reading.backoff?.failureStreak ?? 0,
        ...(reading.backoff === undefined || now >= reading.backoff.retryAt
          ? {}
          : { retryAt: decodeUtcTimestamp(new Date(reading.backoff.retryAt).toISOString()) }),
      });
    }
    return stats;
  }

  #reading(cache: ObservedCache): CacheReading {
    const existing = this.#readings.get(cache);
    if (existing !== undefined) return existing;
    const created: CacheReading = {
      hitCount: 0,
      missCount: 0,
      lastRefreshAt: undefined,
      lastRefreshAtMs: undefined,
      backoff: undefined,
    };
    this.#readings.set(cache, created);
    return created;
  }
}
