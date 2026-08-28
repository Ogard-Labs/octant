/**
 * Host-initiated marketplace and catalog HTTPS.
 *
 * Every skills.sh, npm registry, and GitHub catalog request goes through
 * {@link createMarketplaceFetch} so the User-Agent stays on one
 * minimum-necessary string (no app or runtime version) and an off preference
 * can suppress the request entirely — the same posture as update checks.
 */

/** Constrained User-Agent for every marketplace/catalog HTTPS request. */
export const MARKETPLACE_FETCH_USER_AGENT = "octant-skill-marketplace";

/**
 * Header names marketplace HTTPS is allowed to send. Anything else would
 * widen disclosure beyond the documented fetch posture.
 */
export const MARKETPLACE_FETCH_ALLOWED_HEADER_NAMES = ["accept", "user-agent"] as const;

export class MarketplaceFetchesDisabledError extends Error {
  override readonly name = "MarketplaceFetchesDisabledError";

  constructor(message = "Marketplace fetches are turned off in Settings.") {
    super(message);
  }
}

/**
 * Callable used for marketplace/catalog HTTPS. Narrower than `typeof fetch`
 * so Bun's `fetch.preconnect` (and similar function-object members) are not
 * required on wrappers or test doubles.
 */
export type MarketplaceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface MarketplaceFetchOptions {
  readonly fetch?: MarketplaceFetch;
  /** When false, no request leaves the host. Defaults to allowed. */
  readonly isAllowed?: () => boolean;
}

/**
 * Wrap `fetch` so marketplace callers cannot omit the constrained User-Agent
 * or contact a registry when the host preference is off.
 */
export function createMarketplaceFetch(options: MarketplaceFetchOptions = {}): MarketplaceFetch {
  const base = options.fetch ?? globalThis.fetch;
  const isAllowed = options.isAllowed ?? (() => true);
  return async (input, init) => {
    if (!isAllowed()) {
      throw new MarketplaceFetchesDisabledError();
    }
    const headers = marketplaceRequestHeaders(init?.headers);
    return base(input, {
      ...init,
      headers,
      ...(init?.redirect === undefined ? { redirect: "error" } : {}),
    });
  };
}

/**
 * Build request headers with the constrained User-Agent. Callers may set
 * `Accept`; every other name is dropped so the wire stay on the allowlist.
 */
export function marketplaceRequestHeaders(incoming?: HeadersInit): Record<string, string> {
  const source = new Headers(incoming);
  const accept = source.get("accept");
  const headers: Record<string, string> = {
    "user-agent": MARKETPLACE_FETCH_USER_AGENT,
  };
  if (accept !== null && accept.trim() !== "") {
    headers.accept = accept.trim();
  }
  return headers;
}

/** True when every header name is on the marketplace allowlist. */
export function marketplaceHeadersAreAllowlisted(headers: HeadersInit | undefined): boolean {
  const names = [...new Headers(headers).keys()].map((name) => name.toLowerCase());
  return names.every((name) =>
    (MARKETPLACE_FETCH_ALLOWED_HEADER_NAMES as ReadonlyArray<string>).includes(name),
  );
}
