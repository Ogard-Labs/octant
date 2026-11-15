import type { ChatTranscriptSearch } from "@octant/contracts/chat";
import type {
  CodeTranscriptSearch,
  WorkTranscriptSearch,
} from "@octant/contracts/thread-transcript-search";
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

export function chatTranscriptAnswer(result: ChatTranscriptSearch): TranscriptSearchAnswer {
  return {
    truncated: result.truncated,
    hits: result.hits.map((hit) =>
      contentHit({ ...hit, threadId: String(hit.threadId), turnId: String(hit.turnId) }),
    ),
  };
}

export function workTranscriptAnswer(result: WorkTranscriptSearch): TranscriptSearchAnswer {
  return {
    truncated: result.truncated,
    hits: result.hits.map((hit) =>
      contentHit({ ...hit, threadId: String(hit.threadId), turnId: String(hit.turnId) }),
    ),
  };
}

/** A Code hit names its provider turn by operation, which is what the row deep-links to. */
export function codeTranscriptAnswer(result: CodeTranscriptSearch): TranscriptSearchAnswer {
  return {
    truncated: result.truncated,
    hits: result.hits.map((hit) =>
      contentHit({ ...hit, threadId: String(hit.threadId), turnId: String(hit.operationId) }),
    ),
  };
}

function contentHit(hit: {
  readonly threadId: string;
  readonly title: string;
  readonly projectId?: string | undefined;
  readonly lifecycle: "active" | "archived";
  readonly turnId: string;
  readonly snippet: string;
  readonly matchRanges?:
    | ReadonlyArray<{ readonly start: number; readonly end: number }>
    | undefined;
}): ThreadSearchContentHit {
  return {
    threadId: hit.threadId,
    title: hit.title,
    ...(hit.projectId === undefined ? {} : { projectId: String(hit.projectId) }),
    lifecycle: hit.lifecycle,
    turnId: hit.turnId,
    snippet: hit.snippet,
    ...(hit.matchRanges === undefined || hit.matchRanges.length === 0
      ? {}
      : { matchRanges: hit.matchRanges }),
  };
}
