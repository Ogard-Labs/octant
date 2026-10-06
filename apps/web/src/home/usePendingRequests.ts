import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useCallback, useEffect, useState } from "react";

/**
 * What can change the list without a change-feed signal: the shell settings
 * (a disabled mode is never asked) and the window workspace (which Projects
 * this window can answer for). Each is only compared, never read.
 */
export interface PendingRequestFreshness {
  /** Bumps on the Machine change feed's Chat, Work, and Code navigation topics. */
  readonly feedRevision: number;
  readonly settings: unknown;
  readonly workspace: unknown;
}

export type PendingRequestRead =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly requests: ReadonlyArray<PendingRequest>;
      /** Counts completed reads, so a caller can tell a fresh answer from the last one. */
      readonly read: number;
    };

/**
 * Every approval and question this window can answer, read when the card
 * mounts and again when the feed or the shell says something changed: never on
 * a timer. A refused read keeps the last answer, so the card keeps showing
 * what the host last said. `refresh` re-reads at once, which is how a row
 * leaves after it is answered.
 */
export function usePendingRequests(
  client: PendingRequestClient | undefined,
  freshness: PendingRequestFreshness,
): { readonly read: PendingRequestRead; readonly refresh: () => void } {
  const [read, setRead] = useState<PendingRequestRead>({ status: "loading" });
  const [nudge, setNudge] = useState(0);
  const { feedRevision, settings, workspace } = freshness;
  useEffect(() => {
    if (client === undefined) {
      setRead({ status: "loading" });
      return;
    }
    const controller = new AbortController();
    client.list(controller.signal).then(
      (list) => {
        if (controller.signal.aborted) return;
        setRead((current) => ({
          status: "ready",
          requests: list.requests,
          read: current.status === "ready" ? current.read + 1 : 1,
        }));
      },
      () => {
        // A read the host refuses says nothing new; keep what is on screen.
      },
    );
    return () => controller.abort();
  }, [client, feedRevision, nudge, settings, workspace]);
  const refresh = useCallback(() => setNudge((current) => current + 1), []);
  return { read, refresh };
}
