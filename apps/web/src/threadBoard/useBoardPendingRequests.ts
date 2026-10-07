import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { useEffect, useMemo, useRef } from "react";
import {
  pendingRequestKey,
  type PendingRequestAnswerResult,
  type PendingRequestResponse,
} from "../pendingRequests/pendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowEntry,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";

/**
 * What a mounted board needs to show a waiting thread's question where its
 * card is: the one read this window shares, and the clients each thread view
 * already answers through. A board without a source looks as it always did.
 */
export interface BoardPendingRequestSource extends Omit<PendingRequestRowsSource, "modes"> {
  /** The clock the waits read, advanced once a minute by the shell. */
  readonly now: number;
}

/** The oldest request a thread waits on, and how many more wait behind it. */
export interface BoardCardRequest {
  readonly entry: PendingRequestRowEntry;
  readonly moreWaiting: number;
  readonly now: number;
  readonly onAnswer: (
    request: PendingRequest,
    response: PendingRequestResponse,
  ) => Promise<PendingRequestAnswerResult>;
}

export interface BoardPendingRequests {
  /**
   * The request to answer on a card. It is matched by thread alone: the host
   * lists a request only while its thread waits on the person, and a Code
   * thread parked on a tool approval still counts as executing while its turn
   * runs, so the board files that card under In progress, not Waiting.
   */
  readonly forCard: (card: { readonly threadId: unknown }) => BoardCardRequest | undefined;
  /** When each waiting thread's oldest request began, by thread id; undefined without a reader. */
  readonly oldestRequestedAt: ReadonlyMap<string, string> | undefined;
}

const MODES: Readonly<Record<"work" | "code", ReadonlyArray<OctantMode>>> = {
  work: ["work"],
  code: ["code"],
};

/**
 * The pending requests of one board's mode, matched to its cards by thread.
 * It reads once for the whole board, on the same signals the Needs you card
 * uses, and never on a timer. When the set of waiting requests changes after
 * the first read (one answered here or elsewhere, one newly raised), it asks
 * the board to read again, so a card moves column when the host says it did and
 * never before.
 */
export function useBoardPendingRequests(
  source: BoardPendingRequestSource | undefined,
  mode: "work" | "code",
  onWaitingChanged: () => void,
): BoardPendingRequests {
  const { rows, answer } = usePendingRequestRows(
    source === undefined ? undefined : { ...source, modes: MODES[mode] },
  );
  const now = source?.now ?? 0;
  const hasReader = source?.pendingRequestClient !== undefined;

  const byThread = useMemo(() => {
    const grouped = new Map<string, PendingRequestRowEntry[]>();
    for (const entry of rows ?? []) {
      const key = String(entry.request.threadId);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [rows]);

  const oldestRequestedAt = useMemo(
    () =>
      hasReader
        ? new Map(
            [...byThread].flatMap(([threadId, entries]) => {
              const oldest = entries[0];
              return oldest === undefined ? [] : [[threadId, oldest.request.requestedAt] as const];
            }),
          )
        : undefined,
    [byThread, hasReader],
  );

  const waitingKeys = useMemo(
    () =>
      rows
        ?.filter((entry) => !entry.unlisted)
        .map((entry) => pendingRequestKey(entry.request))
        .toSorted()
        .join("\n"),
    [rows],
  );
  const lastWaitingKeys = useRef<string | undefined>(undefined);
  const onWaitingChangedRef = useRef(onWaitingChanged);
  useEffect(() => {
    onWaitingChangedRef.current = onWaitingChanged;
  });
  useEffect(() => {
    if (waitingKeys === undefined) return;
    if (lastWaitingKeys.current !== undefined && lastWaitingKeys.current !== waitingKeys) {
      onWaitingChangedRef.current();
    }
    lastWaitingKeys.current = waitingKeys;
  }, [waitingKeys]);

  return {
    forCard: (card) => {
      const entries = byThread.get(String(card.threadId));
      const first = entries?.[0];
      if (entries === undefined || first === undefined) return undefined;
      return {
        entry: first,
        moreWaiting: entries.slice(1).filter((entry) => !entry.unlisted).length,
        now,
        onAnswer: answer,
      };
    },
    oldestRequestedAt,
  };
}
