import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { createContext, useCallback, useMemo } from "react";
import {
  isFindOnlyPendingRequest,
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
  /** What the thread asks, for the row's last line. */
  readonly text: string;
  /**
   * Answers the thread's one approval through the same command the thread's
   * approval card sends; absent when the row may only open the thread.
   */
  readonly answer?: (approved: boolean) => Promise<PendingRequestAnswerResult>;
}

export interface SidebarPendingRequests {
  readonly forThread: (threadId: string) => SidebarThreadAsk | undefined;
}

/** Read by every Needs-you row; provided once by the sidebar. */
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
 * on the same signals the Needs you card uses and only while `enabled`: the
 * sidebar turns it on while a Needs-you row of a thread the window does not
 * show is listed, so a sidebar with nothing to answer reads nothing. The host
 * re-checks every answer; a row only offers what the host listed.
 */
export function useSidebarPendingRequests(
  source: SidebarPendingRequestSource | undefined,
  enabled: boolean,
): SidebarPendingRequests | undefined {
  const reading = enabled && source?.pendingRequestClient !== undefined;
  const { rows, answer } = usePendingRequestRows(
    reading && source !== undefined ? { ...source, modes: EVERY_MODE } : undefined,
  );
  const byThread = useMemo(() => {
    const grouped = new Map<string, PendingRequestRowEntry[]>();
    for (const entry of rows ?? []) {
      const key = String(entry.request.threadId);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [rows]);
  const forThread = useCallback(
    (threadId: string): SidebarThreadAsk | undefined => {
      const entries = byThread.get(threadId);
      const listed = entries?.filter((entry) => !entry.unlisted) ?? [];
      const shown = listed[0] ?? entries?.[0];
      if (shown === undefined) return undefined;
      // One listed approval and nothing else: with two waiting, an answer on
      // the row could not say which one it answers.
      const only = listed.length === 1 ? listed[0] : undefined;
      if (only === undefined || !answerableInPlace(only.request))
        return { text: shown.request.text };
      return {
        text: only.request.text,
        answer: (approved) => answer(only.request, { kind: approved ? "approve" : "deny" }),
      };
    },
    [answer, byThread],
  );
  return useMemo(() => (reading ? { forThread } : undefined), [forThread, reading]);
}
