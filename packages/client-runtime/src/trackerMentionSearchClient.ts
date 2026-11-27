import {
  decodeTrackerMentionSearchResponse,
  type TrackerMentionCandidate,
  type TrackerMentionSearchRequest,
} from "@octant/contracts/tracker-mention-search";
import { parseTrackerMentionQuery } from "@octant/domain/tracker-mention-policy";
import { bindFetchPort } from "./bindFetchPort";

export interface TrackerMentionSearchClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export type SearchTrackerMentions = (
  request: TrackerMentionSearchRequest,
  signal?: AbortSignal,
) => Promise<ReadonlyArray<TrackerMentionCandidate>>;

/**
 * The pull requests and issues the `#` list offers beside threads. A token that
 * asks a tracker for nothing is answered here without a request, and a refusal
 * or an unreachable host offers none.
 */
export function createTrackerMentionSearchClient(
  options: TrackerMentionSearchClientOptions,
): SearchTrackerMentions {
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/thread-mentions/trackers", options.baseUrl);
  // The window capability travels with the request, so it stays on this machine.
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);

  return async (request, signal) => {
    if (!loopback || parseTrackerMentionQuery(request.query) === undefined) return [];
    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(request),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) return [];
    return decodeTrackerMentionSearchResponse(await response.json()).candidates;
  };
}
