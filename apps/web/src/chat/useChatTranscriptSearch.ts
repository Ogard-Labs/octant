import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { ChatTranscriptSearchHit } from "@octant/contracts/chat";
import { useEffect, useState } from "react";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import type { ThreadSearchContentHit } from "../shell/threadSearchViewModel";

export type ChatTranscriptSearchStatus = "idle" | "loading" | "ready" | "unavailable";

export interface ChatTranscriptSearchOptions {
  readonly client: Pick<ChatClient, "searchTranscript">;
  readonly query: string;
  /** False while the Chat search overlay is closed, so nothing is requested. */
  readonly enabled: boolean;
}

export interface ChatTranscriptSearchListing {
  readonly hits: ReadonlyArray<ThreadSearchContentHit>;
  readonly truncated: boolean;
  readonly status: ChatTranscriptSearchStatus;
}

/**
 * Message-body hits for the Thread Search overlay.
 *
 * The renderer never greps its own cache: every content row comes from the
 * host's authenticated transcript-search route, which already applied
 * mode/host/project listing authority.
 */
export function useChatTranscriptSearch(
  options: ChatTranscriptSearchOptions,
): ChatTranscriptSearchListing {
  const { client, enabled } = options;
  const query = options.query.trim();
  const debouncedQuery = useDebouncedValue(query, 120);
  const [hits, setHits] = useState<ReadonlyArray<ThreadSearchContentHit>>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<ChatTranscriptSearchStatus>("idle");
  // The query the stored hits/truncated/status answer. Until this equals the
  // current debounced query, prior results must not paint for the new text —
  // including the render after debounce catches up but before the effect runs.
  const [resultQuery, setResultQuery] = useState("");

  useEffect(() => {
    if (!enabled || debouncedQuery === "") {
      setHits([]);
      setTruncated(false);
      setStatus("idle");
      setResultQuery("");
      return;
    }
    let current = true;
    setStatus("loading");
    void (async () => {
      try {
        const result = await client.searchTranscript(debouncedQuery);
        if (!current) return;
        setHits(result.hits.map(toContentHit));
        setTruncated(result.truncated);
        setStatus("ready");
        setResultQuery(debouncedQuery);
      } catch {
        if (!current) return;
        setHits([]);
        setTruncated(false);
        setStatus("unavailable");
        setResultQuery(debouncedQuery);
      }
    })();
    return () => {
      current = false;
    };
  }, [client, enabled, debouncedQuery]);

  const queryPending = enabled && query !== "" && query !== debouncedQuery;
  const resultsStale = resultQuery !== debouncedQuery;
  const suppressHits = queryPending || resultsStale;

  return {
    hits: suppressHits ? [] : hits,
    truncated: suppressHits ? false : truncated,
    status: queryPending || (enabled && debouncedQuery !== "" && resultsStale) ? "loading" : status,
  };
}

function toContentHit(hit: ChatTranscriptSearchHit): ThreadSearchContentHit {
  return {
    threadId: String(hit.threadId),
    title: hit.title,
    ...(hit.projectId === undefined ? {} : { projectId: String(hit.projectId) }),
    lifecycle: hit.lifecycle,
    turnId: String(hit.turnId),
    snippet: hit.snippet,
    ...(hit.matchRanges === undefined || hit.matchRanges.length === 0
      ? {}
      : { matchRanges: hit.matchRanges }),
  };
}
