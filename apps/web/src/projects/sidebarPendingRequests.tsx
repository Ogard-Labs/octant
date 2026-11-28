import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { createContext, useCallback, useMemo, useState, type ReactNode } from "react";
import {
  isFindOnlyPendingRequest,
  pendingRequestKey,
  type PendingRequestAnswerResult,
} from "../pendingRequests/pendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowEntry,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";

/**
 * What the sidebar needs to answer a waiting thread's approval on its row: the
 * window's pending-request reader and the clients each thread view already
 * answers through. A window without one (a remote client) offers only Open.
 */
export type SidebarPendingRequestSource = Omit<PendingRequestRowsSource, "modes">;

/** What one Needs-you row can say and do about the request its thread waits on. */
export interface SidebarThreadAsk {
  /** Names the request, so a row's answers start over when a new one arrives. */
  readonly key: string;
  /** What the thread asks, for the row's last line. */
  readonly text: string;
  /**
   * Answers the thread's one approval through the same command the thread's
   * approval card sends; absent when the row may only open the thread.
   */
  readonly answer?: (approved: boolean) => Promise<PendingRequestAnswerResult>;
}

export interface SidebarPendingRequests {
  /** The request a thread waits on, as the host last listed it; undefined before a read. */
  readonly forThread: (threadId: string) => SidebarThreadAsk | undefined;
  /**
   * A row that offers answers says so while it is listed, and calls the
   * returned function when it no longer does. The reader runs only while one
   * does, so a sidebar with nothing to answer reads nothing.
   */
  readonly listAsking: () => () => void;
}

/** Read by every Needs-you row in Status and the Activity feed. */
export const SidebarPendingRequestsContext = createContext<SidebarPendingRequests | undefined>(
  undefined,
);

const EVERY_MODE: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

/**
 * Whether a row may answer this request in place. Only a plain approval
 * qualifies: a question, a decision or a secret needs the thread's own card;
 * a subagent's or the agent's own approval is found, not answered, outside its
 * thread; and a Browser site ask carries a site the row has no room to show.
 */
function answerableInPlace(request: PendingRequest): boolean {
  return (
    request.kind === "approval" &&
    !isFindOnlyPendingRequest(request) &&
    !("browserOrigin" in request && request.browserOrigin !== undefined)
  );
}

/**
 * The sidebar's one pending-request reader, matched to rows by thread. It reads
 * on the same signals the Needs you card uses, and only while `enabled`. The
 * host re-checks every answer; a row only offers what the host listed.
 */
export function useSidebarPendingRequests(
  source: SidebarPendingRequestSource | undefined,
  enabled: boolean,
): SidebarPendingRequests["forThread"] {
  const reading = enabled && source?.pendingRequestClient !== undefined;
  const { rows, answer } = usePendingRequestRows(
    reading && source !== undefined ? { ...source, modes: EVERY_MODE } : undefined,
  );
  const byThread = useMemo(() => {
    const grouped = new Map<string, PendingRequestRowEntry[]>();
    for (const entry of reading ? (rows ?? []) : []) {
      const key = String(entry.request.threadId);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [reading, rows]);
  return useCallback(
    (threadId: string): SidebarThreadAsk | undefined => {
      const entries = byThread.get(threadId);
      const listed = entries?.filter((entry) => !entry.unlisted) ?? [];
      const shown = listed[0] ?? entries?.[0];
      if (shown === undefined) return undefined;
      // One listed approval and nothing else: with two waiting, an answer on
      // the row could not say which one it answers.
      const only = listed.length === 1 ? listed[0] : undefined;
      if (only === undefined || !answerableInPlace(only.request)) {
        return { key: pendingRequestKey(shown.request), text: shown.request.text };
      }
      return {
        key: pendingRequestKey(only.request),
        text: only.request.text,
        answer: (approved) => answer(only.request, { kind: approved ? "approve" : "deny" }),
      };
    },
    [answer, byThread],
  );
}

/**
 * Provides the reader to the sidebar's rows. It sits outside the sidebar so a
 * new read re-renders the rows that ask, not the whole sidebar.
 */
export function SidebarPendingRequestsProvider(props: {
  readonly source: SidebarPendingRequestSource | undefined;
  readonly children: ReactNode;
}) {
  const [asking, setAsking] = useState(0);
  const listAsking = useCallback(() => {
    setAsking((count) => count + 1);
    return () => setAsking((count) => count - 1);
  }, []);
  const forThread = useSidebarPendingRequests(props.source, asking > 0);
  const value = useMemo(() => ({ forThread, listAsking }), [forThread, listAsking]);
  return (
    <SidebarPendingRequestsContext.Provider value={value}>
      {props.children}
    </SidebarPendingRequestsContext.Provider>
  );
}
