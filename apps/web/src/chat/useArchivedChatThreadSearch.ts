import type { ChatClient } from "@octant/client-runtime/chat-client";
import type { ChatThread } from "@octant/contracts/chat";
import { useEffect, useState } from "react";

/**
 * `idle` while nothing is asked for, then the state of the host's answer. It is
 * kept distinct from an empty result so the Thread Search overlay can never
 * print a pending or refused listing as "no archived threads".
 */
export type ArchivedChatThreadSearchStatus = "idle" | "loading" | "ready" | "unavailable";

export interface ArchivedChatThreadSearchOptions {
  readonly client: Pick<ChatClient, "search">;
  readonly query: string;
  /** False while the Chat search overlay is closed, so nothing is requested. */
  readonly enabled: boolean;
}

export interface ArchivedChatThreadSearch {
  readonly threads: ReadonlyArray<ChatThread>;
  readonly status: ArchivedChatThreadSearchStatus;
}

/**
 * Archived Chat threads for the Thread Search overlay.
 *
 * The Chat bootstrap is deliberately active-only because it feeds the sidebar,
 * so the overlay's Archived group has to come from the host's own
 * lifecycle-spanning thread search. This hook only relays that authorized
 * listing: it discovers nothing, keeps the archived rows the host returned, and
 * reports a pending or refused answer as such rather than as an empty group.
 */
export function useArchivedChatThreadSearch(
  options: ArchivedChatThreadSearchOptions,
): ArchivedChatThreadSearch {
  const { client, enabled } = options;
  const query = options.query.trim();
  const [threads, setThreads] = useState<ReadonlyArray<ChatThread>>([]);
  const [status, setStatus] = useState<ArchivedChatThreadSearchStatus>("idle");

  useEffect(() => {
    if (!enabled || query === "") {
      setThreads([]);
      setStatus("idle");
      return;
    }
    let current = true;
    setStatus("loading");
    void (async () => {
      try {
        const hits = await client.search(query);
        if (!current) return;
        setThreads(hits.filter((thread) => thread.lifecycle === "archived"));
        setStatus("ready");
      } catch {
        // An unreachable or refused listing contributes no rows and says so;
        // silently showing none would claim there are no archived threads.
        if (!current) return;
        setThreads([]);
        setStatus("unavailable");
      }
    })();
    return () => {
      current = false;
    };
  }, [client, enabled, query]);

  return { threads, status };
}
