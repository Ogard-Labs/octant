import { decodeHostAnswer, ThreadSearch, type ThreadSearchScope } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadSearchClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability?: string;
}

/**
 * One search across modes. A refusal means this window may not read the host's
 * threads; `unavailable` covers a host that could not answer, so a caller can
 * say so instead of showing an empty result as if nothing matched.
 */
export type ThreadSearchRead =
  | { readonly status: "ready"; readonly search: ThreadSearch }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

export interface ThreadSearchClient {
  /** `signal` cancels the request; a cancelled read answers `unavailable`. */
  search(query: string, scope: ThreadSearchScope, signal?: AbortSignal): Promise<ThreadSearchRead>;
}

export function createThreadSearchClient(options: ThreadSearchClientOptions): ThreadSearchClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async search(query, scope, signal) {
      const url = new URL("/api/search", options.baseUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("scope", scope);
      const headers: Record<string, string> = {};
      if (options.windowCapability !== undefined && options.windowCapability.length > 0) {
        headers["x-octant-window-capability"] = options.windowCapability;
      }
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        return { status: "unavailable" };
      }
      if (response.status === 401 || response.status === 403) return { status: "refused" };
      if (!response.ok) return { status: "unavailable" };
      try {
        return { status: "ready", search: decodeHostAnswer(ThreadSearch)(await response.json()) };
      } catch {
        return { status: "unavailable" };
      }
    },
  };
}
