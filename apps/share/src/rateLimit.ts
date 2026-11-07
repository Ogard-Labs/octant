import type { Clock } from "./store.ts";

const WINDOW_MS = 60_000;

/** Calls per client address per minute. A password limit is per address and link. */
export const RATE_LIMITS = {
  create: 10,
  owner: 60,
  view: 120,
  password: 5,
  report: 5,
} as const;

export type RateBucket = keyof typeof RATE_LIMITS;

interface Window {
  readonly start: number;
  readonly count: number;
}

/**
 * Fixed-window counters held in memory for the current window only. They are
 * never written to disk or logged, so the service learns no more about a
 * client than the minute it is counting.
 */
export class RateLimiter {
  readonly #clock: Clock;
  readonly #windows = new Map<string, Window>();
  #lastPrune = 0;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Counts one call and answers whether it is within the bucket's limit. */
  allow(bucket: RateBucket, client: string, scope = ""): boolean {
    const now = this.#clock();
    this.#prune(now);
    const key = `${bucket}\u0000${client}\u0000${scope}`;
    const current = this.#windows.get(key);
    const window: Window =
      current === undefined || now - current.start >= WINDOW_MS
        ? { start: now, count: 0 }
        : current;
    this.#windows.set(key, { start: window.start, count: window.count + 1 });
    return window.count + 1 <= RATE_LIMITS[bucket];
  }

  #prune(now: number): void {
    if (now - this.#lastPrune < WINDOW_MS) return;
    this.#lastPrune = now;
    for (const [key, window] of this.#windows) {
      if (now - window.start >= WINDOW_MS) this.#windows.delete(key);
    }
  }
}

/**
 * The address a call counts against. `X-Forwarded-For` is a claim any caller
 * can make, so it is read only when the operator says a proxy they control
 * sets it.
 */
export function clientAddress(
  request: Request,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded !== undefined && forwarded !== "") return forwarded;
  }
  return socketAddress ?? "unknown";
}
