import type { ThreadSearchRead } from "@octant/client-runtime/thread-search-client";
import { useEffect, useState } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import type { ThreadSearchContentHit } from "./threadSearchViewModel";

export type TranscriptSearchStatus = "idle" | "loading" | "ready" | "unavailable";

export interface TranscriptSearchAnswer {
  readonly hits: ReadonlyArray<ThreadSearchContentHit>;
  readonly truncated: boolean;
}

export interface TranscriptSearchOptions {
  /**
   * The current mode's host message search. A new function means a new mode,
   * so the previous mode's hits stop painting until it answers.
   */
  readonly search: (query: string) => Promise<TranscriptSearchAnswer>;
  readonly query: string;
  /** False while the Search overlay is closed, so nothing is requested. */
  readonly enabled: boolean;
}

export interface TranscriptSearchListing extends TranscriptSearchAnswer {
  readonly status: TranscriptSearchStatus;
}

interface Answered extends TranscriptSearchAnswer {
  readonly query: string;
  readonly search: TranscriptSearchOptions["search"];
  readonly status: "ready" | "unavailable";
}

/**
 * Message-body hits for the Thread Search overlay, in whichever mode it
 * searches.
 *
 * The renderer never greps its own cache: every content row comes from the
 * host's authenticated transcript-search route for that mode, which already
 * applied host and Project listing authority.
 */
export function useTranscriptSearch(options: TranscriptSearchOptions): TranscriptSearchListing {
  const { search, enabled } = options;
  const query = options.query.trim();
  const debouncedQuery = useDebouncedValue(query, 120);
  // What the stored hits answer. Until it names the current debounced query
  // and search, prior results must not paint for the new text or mode,
  // including the render after debounce catches up but before the effect runs.
  const [answered, setAnswered] = useState<Answered | undefined>(undefined);

  useEffect(() => {
    if (!enabled || debouncedQuery === "") {
      setAnswered(undefined);
      return;
    }
    let current = true;
    void (async () => {
      try {
        const result = await search(debouncedQuery);
        if (!current) return;
        setAnswered({ ...result, query: debouncedQuery, search, status: "ready" });
      } catch {
        if (!current) return;
        setAnswered({
          hits: [],
          truncated: false,
          query: debouncedQuery,
          search,
          status: "unavailable",
        });
      }
    })();
    return () => {
      current = false;
    };
  }, [search, enabled, debouncedQuery]);

  if (!enabled || query === "") return { hits: [], truncated: false, status: "idle" };
  const fresh =
    query === debouncedQuery &&
    answered !== undefined &&
    answered.query === debouncedQuery &&
    answered.search === search;
  if (!fresh) return { hits: [], truncated: false, status: "loading" };
  return { hits: answered.hits, truncated: answered.truncated, status: answered.status };
}

/**
 * The host's search across modes as overlay hits. A refused or failed read
 * throws, so the overlay says message search is unavailable rather than
 * showing an empty result as if nothing matched.
 */
export function threadSearchAnswer(read: ThreadSearchRead): TranscriptSearchAnswer {
  if (read.status !== "ready") throw new Error(`Search is ${read.status}.`);
  return {
    truncated: read.search.truncated,
    hits: read.search.hits.map((hit): ThreadSearchContentHit => {
      const turnId = hit.mode === "code" ? hit.operationId : hit.turnId;
      return {
        mode: hit.mode,
        threadId: String(hit.threadId),
        title: hit.title,
        ...(hit.projectId === undefined ? {} : { projectId: String(hit.projectId) }),
        lifecycle: hit.lifecycle,
        ...(turnId === undefined ? {} : { turnId: String(turnId) }),
        field: hit.field,
        ...(hit.canvasId === undefined ? {} : { canvasId: String(hit.canvasId) }),
        ...(hit.canvasTitle === undefined ? {} : { canvasTitle: hit.canvasTitle }),
        snippet: hit.snippet,
        updatedAt: hit.updatedAt,
        ...(hit.matchRanges === undefined || hit.matchRanges.length === 0
          ? {}
          : { matchRanges: hit.matchRanges }),
      };
    }),
  };
}
