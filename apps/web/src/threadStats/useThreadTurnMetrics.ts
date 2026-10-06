import type { UsageClient } from "@octant/client-runtime/usage-client";
import type { TurnMetricsSummary } from "@octant/contracts";
import { useEffect, useRef, useState } from "react";

/**
 * How long the thread's own movement must settle before its figures are read
 * again. A running Code turn moves the revision on every event; the figures
 * only change when a turn ends, so one read after the burst is enough.
 */
const SETTLE_MS = 800;

export interface UseThreadTurnMetricsOptions {
  readonly client: Pick<UsageClient, "query">;
  readonly threadId: string | undefined;
  /** Changes whenever the thread's own turns have moved on. */
  readonly revision?: number | undefined;
}

/**
 * The turns of one thread, on any provider, as the host recorded them. Absent
 * until the host answers and whenever it has no turn for the thread; a read
 * that fails keeps the last answer, because a quiet line that blinks out on a
 * dropped request would say more than the failure deserves.
 */
export function useThreadTurnMetrics(
  options: UseThreadTurnMetricsOptions,
): TurnMetricsSummary | undefined {
  const { client, threadId, revision } = options;
  const [summary, setSummary] = useState<TurnMetricsSummary | undefined>(undefined);
  const forThread = useRef<string | undefined>(undefined);
  const scheduledFor = useRef<string | undefined>(undefined);
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    forThread.current = threadId;
    setSummary(undefined);
  }, [threadId]);

  useEffect(() => {
    if (threadId === undefined) return;
    const mine = ++generation.current;
    // A thread just opened is read at once; only its later movement is settled.
    const delay = scheduledFor.current === threadId ? SETTLE_MS : 0;
    scheduledFor.current = threadId;
    const timer = setTimeout(() => {
      void client
        .query({ filter: { subjectAggregateId: threadId }, limit: 1 })
        .then((response) => {
          if (generation.current !== mine || forThread.current !== threadId) return;
          setSummary(response.turnMetrics);
        })
        .catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [client, revision, threadId]);

  return summary;
}
