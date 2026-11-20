import type { FinishedReceiptClient } from "@octant/client-runtime/finished-receipt-client";
import type { ThreadFinishedReceipt } from "@octant/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  THREAD_ACTIVITY_RECOVERY_MS,
  useThreadActivityRevision,
} from "../polling/ThreadActivityRevisions";
import { samePollingData } from "../polling/samePollingData";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

const NO_RECEIPTS: ReadonlyArray<ThreadFinishedReceipt> = [];

const FinishedReceiptsContext = createContext<ReadonlyArray<ThreadFinishedReceipt>>(NO_RECEIPTS);

export interface FinishedReceiptProviderProps {
  readonly client?: Pick<FinishedReceiptClient, "receipts"> | undefined;
  readonly threadId?: string | undefined;
  readonly refreshIntervalMs?: number;
  readonly children: ReactNode;
}

/**
 * Loads a thread's host-built finished receipts once for the pane, so inline
 * turn cards share one read and stay in sync with journal commits.
 */
export function FinishedReceiptProvider(props: FinishedReceiptProviderProps) {
  const { client, threadId } = props;
  const [receipts, setReceipts] = useState<ReadonlyArray<ThreadFinishedReceipt>>(NO_RECEIPTS);
  const requestGeneration = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (client === undefined || threadId === undefined) return;
      const generation = ++requestGeneration.current;
      try {
        const next = await client.receipts(threadId, signal);
        if (signal?.aborted !== true && requestGeneration.current === generation) {
          setReceipts((current) => (samePollingData(current, next) ? current : next));
        }
      } catch {
        // Keep the last known receipts until a fresh host read succeeds.
      }
    },
    [client, threadId],
  );

  const revision = useThreadActivityRevision("threadFollowUps");
  useEffect(() => {
    requestGeneration.current += 1;
    setReceipts(NO_RECEIPTS);
  }, [client, threadId]);

  const refresh = useCallback(async (signal: AbortSignal) => load(signal), [load]);
  useVisibleRefresh(
    refresh,
    revision,
    revision === undefined ? (props.refreshIntervalMs ?? 4_000) : THREAD_ACTIVITY_RECOVERY_MS,
  );

  const value = useMemo(() => receipts, [receipts]);
  return (
    <FinishedReceiptsContext.Provider value={value}>
      {props.children}
    </FinishedReceiptsContext.Provider>
  );
}

export function useThreadFinishedReceipts(): ReadonlyArray<ThreadFinishedReceipt> {
  return useContext(FinishedReceiptsContext);
}
