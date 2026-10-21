import type { ShareConfig } from "./config.ts";
import type { RateLimiter } from "./rateLimit.ts";
import type { ShareStore } from "./store.ts";

/** What every handler needs, fixed once both listeners are bound. */
export interface ServiceContext {
  readonly config: ShareConfig;
  readonly store: ShareStore;
  readonly limiter: RateLimiter;
  readonly publicOrigin: string;
  readonly usercontentOrigin: string;
}

/** Response headers that keep any answer out of caches, indexes, and referrers. */
export const PRIVATE_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
};

export function isHttps(origin: string): boolean {
  return origin.startsWith("https://");
}
