import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useCallback, useEffect, useRef, useState } from "react";

const NO_REQUESTS: ReadonlyArray<PendingRequest> = [];

/**
 * The approvals and questions this window can answer, read on demand.
 *
 * Nothing here polls or runs on a timer: the caller asks for a read when a
 * surface opens. Starting a read empties the list, and a read that fails
 * leaves it empty, because a row that may already have been answered is worse
 * than a missing one: a stale row stays selectable and only earns a refusal.
 * A newer read replaces one still in flight, so a slow answer never
 * overwrites a fresh one.
 * `client` is undefined off a local host, where the list is never read.
 */
export function usePendingRequests(client: PendingRequestClient | undefined): {
  readonly requests: ReadonlyArray<PendingRequest>;
  readonly refresh: () => void;
} {
  const [requests, setRequests] = useState<ReadonlyArray<PendingRequest>>(NO_REQUESTS);
  const inFlight = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(() => {
    inFlight.current?.abort();
    if (client === undefined) {
      inFlight.current = undefined;
      setRequests(NO_REQUESTS);
      return;
    }
    const controller = new AbortController();
    inFlight.current = controller;
    setRequests(NO_REQUESTS);
    client
      .list(controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setRequests(list.requests);
      })
      .catch(() => {
        if (!controller.signal.aborted) setRequests(NO_REQUESTS);
      });
  }, [client]);

  useEffect(() => () => inFlight.current?.abort(), []);

  return { requests, refresh };
}
