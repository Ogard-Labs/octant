import type {
  MovedThreadReference,
  ThreadMoveDestinations,
  ThreadMoveThreadStatus,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadMoveClient } from "./threadMoveClient";

/** While a move runs or waits, its progress is read this often. */
const ACTIVE_POLL_MS = 1_000;
/** Otherwise often enough to notice an arrival's Activate anyway, or a failure. */
const IDLE_POLL_MS = 15_000;

export interface ThreadMoveState {
  readonly status: ThreadMoveThreadStatus | undefined;
  readonly destinations: ThreadMoveDestinations | undefined;
  readonly destinationsLoading: boolean;
  readonly destinationsFailed: boolean;
  readonly loadDestinations: () => void;
  readonly refresh: () => void;
}

/**
 * Where one thread stands in a move, read from its host while the Environment
 * shows it, and the member computers it could move to, read when the person
 * opens the Computer row.
 */
export function useThreadMove(
  client: ThreadMoveClient,
  thread: MovedThreadReference,
): ThreadMoveState {
  const [status, setStatus] = useState<ThreadMoveThreadStatus | undefined>(undefined);
  const [destinations, setDestinations] = useState<ThreadMoveDestinations | undefined>(undefined);
  const [destinationsLoading, setDestinationsLoading] = useState(false);
  const [destinationsFailed, setDestinationsFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const threadKey = `${thread.mode}:${thread.threadId}`;
  const current = useRef(threadKey);
  current.current = threadKey;
  // Read through a ref, so a new object naming the same thread does not
  // restart reading.
  const threadRef = useRef(thread);
  threadRef.current = thread;

  useEffect(() => {
    setStatus(undefined);
    setDestinations(undefined);
  }, [threadKey]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      let next: ThreadMoveThreadStatus | undefined;
      try {
        next = await client.status(threadRef.current);
      } catch {
        next = undefined;
      }
      if (stopped || current.current !== threadKey) return;
      if (next !== undefined) setStatus(next);
      const active = next?.sending !== undefined || next?.waiting !== undefined;
      timer = setTimeout(() => void read(), active ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, threadKey, tick]);

  const loadDestinations = useCallback(() => {
    setDestinationsLoading(true);
    setDestinationsFailed(false);
    client
      .destinations(threadRef.current)
      .then((listed) => {
        if (current.current === threadKey) setDestinations(listed);
      })
      .catch(() => {
        if (current.current === threadKey) setDestinationsFailed(true);
      })
      .finally(() => {
        if (current.current === threadKey) setDestinationsLoading(false);
      });
  }, [client, threadKey]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  return {
    status,
    destinations,
    destinationsLoading,
    destinationsFailed,
    loadDestinations,
    refresh,
  };
}
