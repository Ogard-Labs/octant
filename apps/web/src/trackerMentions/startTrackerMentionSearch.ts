import {
  createTrackerMentionSearchClient,
  type SearchTrackerMentions,
} from "@octant/client-runtime/tracker-mention-search-client";
import type { TrackerMentionCandidate } from "@octant/contracts/tracker-mention-search";
import { decodeMentionableThreadId, decodeProjectId } from "@octant/contracts";
import { rememberTrackerMentionFacts } from "./trackerMentionFacts";

/** How long typing rests before the `#` list asks the trackers. */
const SEARCH_DEBOUNCE_MS = 300;

export interface TrackerMentionSearchInput {
  readonly query: string;
  /** Injected search; otherwise built from the loopback server URL. */
  readonly search?: SearchTrackerMentions | undefined;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  /** The composer's own thread, or else the Project a new thread would start in. */
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly onFound: (candidates: ReadonlyArray<TrackerMentionCandidate>) => void;
}

/**
 * One search of the `#` token once typing rests. The returned call abandons it,
 * so a later token is never answered with an earlier one's rows.
 */
export function startTrackerMentionSearch(input: TrackerMentionSearchInput): () => void {
  const search =
    input.search ??
    (input.serverUrl === undefined || input.windowCapability === undefined
      ? undefined
      : createTrackerMentionSearchClient({
          baseUrl: input.serverUrl,
          fetch: globalThis.fetch,
          windowCapability: input.windowCapability,
        }));
  const controller = new AbortController();
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const found = await search?.(
          {
            query: input.query,
            ...(input.threadId === undefined
              ? input.projectId === undefined
                ? {}
                : { projectId: decodeProjectId(input.projectId) }
              : { readerThreadId: decodeMentionableThreadId(input.threadId) }),
          },
          controller.signal,
        );
        if (found === undefined || controller.signal.aborted) return;
        rememberTrackerMentionFacts(found);
        input.onFound(found);
      } catch {
        // A search that failed offers nothing; the text stays as typed.
      }
    })();
  }, SEARCH_DEBOUNCE_MS);
  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
