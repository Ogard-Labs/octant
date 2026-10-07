import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest, PendingRequestList } from "@octant/contracts/pending-requests";
import { useCallback, useEffect, useRef, useState } from "react";

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
 * what the host last said. `refresh` re-reads, which is how a row leaves after
 * it is answered.
 *
 * Signals are coalesced: at most one read is in flight, and any number of
 * signals that arrive meanwhile become one more read once it lands. A
 * streaming Chat reply moves the navigation topic on every delta, and each
 * host read walks the Work requests and replays Code operation streams, so
 * starting a read per signal would make the host repeat that work for every
 * token while the start screen is open.
 */
export function usePendingRequests(
  client: PendingRequestClient | undefined,
  freshness: PendingRequestFreshness,
): { readonly read: PendingRequestRead; readonly refresh: () => void } {
  const [read, setRead] = useState<PendingRequestRead>({ status: "loading" });
  const [nudge, setNudge] = useState(0);
  const queue = useRef<ReadQueue | undefined>(undefined);
  const { feedRevision, settings, workspace } = freshness;
  useEffect(() => {
    if (client === undefined) {
      queue.current = undefined;
      setRead({ status: "loading" });
      return;
    }
    const controller = new AbortController();
    queue.current = createReadQueue(client, controller.signal, (list) =>
      setRead((current) => ({
        status: "ready",
        requests: list.requests,
        read: current.status === "ready" ? current.read + 1 : 1,
      })),
    );
    return () => {
      controller.abort();
      queue.current = undefined;
    };
  }, [client]);
  useEffect(() => {
    queue.current?.request();
  }, [client, feedRevision, nudge, settings, workspace]);
  const refresh = useCallback(() => setNudge((current) => current + 1), []);
  return { read, refresh };
}

interface ReadQueue {
  /** Read now, or once more after the read in flight lands. */
  readonly request: () => void;
}

function createReadQueue(
  client: PendingRequestClient,
  signal: AbortSignal,
  landed: (list: PendingRequestList) => void,
): ReadQueue {
  let inFlight = false;
  let pending = false;
  const run = () => {
    inFlight = true;
    pending = false;
    client
      .list(signal)
      .then(
        (list) => {
          if (!signal.aborted) landed(list);
        },
        () => {
          // A read the host refuses says nothing new; keep what is on screen.
        },
      )
      .finally(() => {
        inFlight = false;
        if (pending && !signal.aborted) run();
      });
  };
  return {
    request: () => {
      if (inFlight) pending = true;
      else run();
    },
  };
}
