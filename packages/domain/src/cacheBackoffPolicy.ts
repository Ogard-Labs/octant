/**
 * Retry pacing for a cache whose refresh depends on an external service.
 *
 * A cache that keeps asking a failing service on every read turns one outage
 * into a request storm and, for a rate-limited account, keeps the account
 * limited for longer than the original burst. The streak therefore paces the
 * refresh a read would otherwise trigger; it never paces a refresh the user
 * asked for, because a person watching a stale view must be able to try again.
 */

/**
 * Longest wait a streak may impose. Beyond a quarter hour a retry is no longer
 * pacing an outage, it is refusing to notice that the service came back.
 */
export const CACHE_BACKOFF_CEILING_MS = 15 * 60 * 1000;

/** First wait after a single failure, doubling with each further failure. */
export const CACHE_BACKOFF_FIRST_DELAY_MS = 30 * 1000;

export interface CacheBackoff {
  /** Consecutive failed refreshes; a success clears the streak entirely. */
  readonly failureStreak: number;
  /** Epoch milliseconds before which only a user-asked refresh may reach the service. */
  readonly retryAt: number;
}

export function cacheBackoffDelayMs(failureStreak: number): number {
  if (!Number.isSafeInteger(failureStreak) || failureStreak <= 0) return 0;
  const exponent = Math.min(failureStreak - 1, 32);
  return Math.min(CACHE_BACKOFF_FIRST_DELAY_MS * 2 ** exponent, CACHE_BACKOFF_CEILING_MS);
}

export function extendCacheBackoff(previous: CacheBackoff | undefined, now: number): CacheBackoff {
  const failureStreak = (previous?.failureStreak ?? 0) + 1;
  return { failureStreak, retryAt: now + cacheBackoffDelayMs(failureStreak) };
}

export function cacheBackoffHolds(backoff: CacheBackoff | undefined, now: number): boolean {
  return backoff !== undefined && now < backoff.retryAt;
}
