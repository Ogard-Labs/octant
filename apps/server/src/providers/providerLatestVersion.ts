import {
  MARKETPLACE_FETCH_USER_AGENT,
  createMarketplaceFetch,
  createMarketplaceRequestSignal,
  type MarketplaceFetch,
} from "../extensions/marketplaceRequestSignal";
import { readBoundedResponseBody } from "../extensions/boundedResponseBody";
import { NPM_VERSION_PATTERN } from "../extensions/npmRegistry";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const MAX_DIST_TAGS_BYTES = 16 * 1024;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
/** A failed lookup is retried within the hour, not on every Settings visit. */
const MISS_TTL_MS = 60 * 60 * 1000;

export interface ProviderLatestVersionOptions {
  readonly fetch?: MarketplaceFetch;
  /** False when the person turned marketplace fetches off; then nothing leaves the host. */
  readonly isAllowed?: () => boolean;
  readonly now?: () => number;
}

/**
 * Reads a CLI's newest release from its npm `latest` dist-tag. The request is a
 * plain GET for the package name: no task data, instance or account identifier,
 * and only the constrained marketplace User-Agent. Results are cached for a day
 * and every failure (offline, refused, malformed) answers `undefined`.
 */
export function createProviderLatestVersionCheck(
  options: ProviderLatestVersionOptions = {},
): (packageName: string) => Promise<string | undefined> {
  const fetchImpl = createMarketplaceFetch({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.isAllowed === undefined ? {} : { isAllowed: options.isAllowed }),
  });
  const now = options.now ?? Date.now;
  const cache = new Map<
    string,
    { readonly version: string | undefined; readonly expires: number }
  >();
  const lookup = async (packageName: string): Promise<string | undefined> => {
    const request = createMarketplaceRequestSignal(undefined, 10_000);
    try {
      const response = await fetchImpl(`${NPM_REGISTRY_URL}/-/package/${packageName}/dist-tags`, {
        headers: { accept: "application/json", "user-agent": MARKETPLACE_FETCH_USER_AGENT },
        signal: request.signal,
      });
      if (!response.ok) return undefined;
      const bytes = await readBoundedResponseBody(
        response,
        MAX_DIST_TAGS_BYTES,
        "npm dist-tags are too large.",
      );
      const tags: unknown = JSON.parse(new TextDecoder().decode(bytes));
      const latest =
        typeof tags === "object" && tags !== null && "latest" in tags ? tags.latest : undefined;
      return typeof latest === "string" && NPM_VERSION_PATTERN.test(latest) ? latest : undefined;
    } catch {
      return undefined;
    } finally {
      request.dispose();
    }
  };
  return async (packageName) => {
    const cached = cache.get(packageName);
    if (cached !== undefined && cached.expires > now()) return cached.version;
    // A turned-off preference is not cached: turning it back on checks at once.
    if (options.isAllowed?.() === false) return undefined;
    const version = await lookup(packageName);
    cache.set(packageName, {
      version,
      expires: now() + (version === undefined ? MISS_TTL_MS : FOUND_TTL_MS),
    });
    return version;
  };
}
