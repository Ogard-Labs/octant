import { createRemoteProductFetch } from "@octant/client-runtime";
import { createCodeClient } from "@octant/client-runtime/code-client";
import {
  mergeAllHostsReadModels,
  refreshAllHostsReadModels,
  type FederatedReadItem,
  type HostReadModelCache,
} from "@octant/client-runtime/host-federation-merged-reads";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { pairedComputerReadItems } from "@octant/client-runtime/paired-computer-reads";
import { createPendingRequestClient } from "@octant/client-runtime/pending-request-client";
import { useEffect, useRef, useState } from "react";
import { scheduleVisibleInterval } from "../polling/documentVisibility";

/** Often enough that a thread started elsewhere shows up while the person looks, rarely enough for a paired session. */
const REFRESH_MS = 15_000;

// As for the paired computer's Code surface: the session owns the destination,
// so the base URL only shapes the path, and no window capability leaves here.
const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";

/**
 * Every paired computer's Code threads and asks, for this window's lists
 * (maintainer request, 2026-11-19). This computer's own rows come from its own
 * controllers, so only paired computers are read. A computer that stops
 * answering keeps its last rows, marked stale and read-only, and one host's
 * failure never clears another's.
 */
export function usePairedComputerReads(input: {
  readonly transports: HostFederationTransports | undefined;
  readonly cache: HostReadModelCache | undefined;
  readonly onChange?: () => void;
  /**
   * Called as each refresh starts, before any computer answers, so a reader
   * that asks each computer on its own does not wait for the slowest one.
   */
  readonly onRefreshStarted?: () => void;
}): ReadonlyArray<FederatedReadItem> {
  const { transports, cache, onChange } = input;
  const onRefreshStarted = useRef(input.onRefreshStarted);
  onRefreshStarted.current = input.onRefreshStarted;
  const [items, setItems] = useState<ReadonlyArray<FederatedReadItem>>([]);
  useEffect(() => {
    if (transports === undefined || cache === undefined) return;
    let running = false;
    let stopped = false;
    const refresh = async () => {
      onRefreshStarted.current?.();
      if (running) return;
      running = true;
      try {
        await refreshAllHostsReadModels({
          transports,
          cache,
          fetchContribution: async (slot) => {
            if (slot.kind !== "remote" || slot.bridge === undefined) return [];
            const port = {
              baseUrl: REMOTE_CLIENT_BASE_URL,
              fetch: createRemoteProductFetch({ bridge: slot.bridge }),
              windowCapability: "",
            };
            const [navigation, pendingRequests] = await Promise.all([
              createCodeClient({ ...port, threadEvents: "poll" }).navigation(),
              createPendingRequestClient(port)
                .list()
                .catch(() => undefined),
            ]);
            return pairedComputerReadItems({
              hostId: String(slot.hostId),
              navigation,
              pendingRequests,
            });
          },
        });
        if (!stopped) {
          setItems(mergeAllHostsReadModels(cache.list()).items);
          onChange?.();
        }
      } finally {
        running = false;
      }
    };
    const stop = scheduleVisibleInterval(() => void refresh(), REFRESH_MS, {
      runImmediately: true,
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [transports, cache, onChange]);
  return items;
}

/** A count of refreshes started, read where it is needed rather than rendered from the shell. */
export interface RefreshTicks {
  readonly tick: () => void;
  readonly read: () => number;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createRefreshTicks(): RefreshTicks {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    tick: () => {
      count += 1;
      for (const listener of listeners) listener();
    },
    read: () => count,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
