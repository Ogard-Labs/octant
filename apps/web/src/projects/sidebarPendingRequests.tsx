import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  approvedOnlyInThread,
  isFindOnlyPendingRequest,
  pendingRequestKey,
  type PendingRequestAnswerResult,
} from "../pendingRequests/pendingRequests";
import type { PendingRequestFreshness } from "../pendingRequests/usePendingRequests";
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
   * Whether the window shows this thread now, so its own approval card is in
   * view. A page that covers the workspace, such as Board, leaves the panes
   * behind it open but shows none of them.
   */
  readonly shows: (threadId: string) => boolean;
  /**
   * A Needs-you row whose thread the window does not show lists it while it
   * waits, with when the thread last moved, and calls the returned function
   * when it stops. A thread that starts waiting, or moves while it waits, is
   * read once. The reader goes on following the host's change signals only
   * while some listed row offers answers, so a sidebar whose rows can only
   * open their threads reads nothing more.
   */
  readonly listWaiting: (threadId: string, movedAt: string | undefined) => () => void;
}

/** Read by every Needs-you row in Status and the Activity feed. */
export const SidebarPendingRequestsContext = createContext<SidebarPendingRequests | undefined>(
  undefined,
);

const EVERY_MODE: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

/**
 * Change signals a reader that has not followed yet is given: they never
 * change, so it reads when it starts and when a row asks, and at no other time.
 */
const NOT_FOLLOWING: PendingRequestFreshness = {
  feedRevision: 0,
  settings: undefined,
  workspace: undefined,
};

/**
 * Whether a row may answer this request in place. Only an approval the host
 * says is one tool call qualifies: entering or leaving Plan changes the
 * thread's level and hands over a plan only its card shows; a question, a
 * decision or a secret needs the thread's own card; a subagent's or the
 * agent's own approval is found, not answered, outside its thread; and a
 * Browser site ask carries a site the row has no room to show.
 */
function answerableInPlace(request: PendingRequest): boolean {
  return (
    request.kind === "approval" &&
    !approvedOnlyInThread(request) &&
    !isFindOnlyPendingRequest(request) &&
    !("browserOrigin" in request && request.browserOrigin !== undefined)
  );
}

/** One waiting row's thread and when it last moved, as the row listed it. */
function waitingKey(threadId: string, movedAt: string | undefined): string {
  return `${threadId}\n${movedAt ?? ""}`;
}

function waitingThreadId(key: string): string {
  return key.slice(0, key.indexOf("\n"));
}

/**
 * The sidebar's one pending-request reader, matched to rows by thread. It reads
 * only while some row waits, and follows the same signals the Needs you card
 * uses only while some waiting row offers answers. The host re-checks every
 * answer; a row only offers what the host listed.
 */
export function useSidebarPendingRequests(
  source: SidebarPendingRequestSource | undefined,
  waiting: ReadonlyArray<string>,
): SidebarPendingRequests["forThread"] {
  const reading = waiting.length > 0 && source?.pendingRequestClient !== undefined;
  const [following, setFollowing] = useState(false);
  // A reader that stops following keeps the last signals it followed, so
  // stopping is not itself a change that reads again; starting again reads
  // once if anything moved meanwhile.
  const [held, setHeld] = useState<PendingRequestFreshness>(NOT_FOLLOWING);
  const feedRevision = source?.feedRevision ?? 0;
  const settings = source?.settings;
  const workspace = source?.workspace;
  useEffect(() => {
    if (following) setHeld({ feedRevision, settings, workspace });
  }, [feedRevision, following, settings, workspace]);
  const { rows, answer, refresh } = usePendingRequestRows(
    reading && source !== undefined
      ? { ...source, ...(following ? {} : held), modes: EVERY_MODE }
      : undefined,
  );
  const byThread = useMemo(() => {
    const grouped = new Map<string, PendingRequestRowEntry[]>();
    for (const entry of reading ? (rows ?? []) : []) {
      const key = String(entry.request.threadId);
      grouped.set(key, [...(grouped.get(key) ?? []), entry]);
    }
    return grouped;
  }, [reading, rows]);
  const forThread = useCallback(
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
  const answersSome = waiting.some((key) => forThread(waitingThreadId(key))?.answer !== undefined);
  useEffect(() => setFollowing(answersSome), [answersSome]);
  // A row that starts waiting, or whose thread moved, needs one read to say
  // what it asks. The read the reader makes when it starts covers the first.
  const listed = useRef<ReadonlySet<string>>(new Set());
  const waitingList = waiting.join("\t");
  useEffect(() => {
    const now = waitingList === "" ? [] : waitingList.split("\t");
    const before = listed.current;
    listed.current = new Set(now);
    if (before.size > 0 && now.some((key) => !before.has(key))) refresh();
  }, [waitingList, refresh]);
  return forThread;
}

/**
 * Provides the reader to the sidebar's rows. It sits outside the sidebar so a
 * new read re-renders the rows that ask, not the whole sidebar.
 */
export function SidebarPendingRequestsProvider(props: {
  readonly source: SidebarPendingRequestSource | undefined;
  /** The threads the window shows now; empty while a page covers the workspace. */
  readonly shownThreadIds: ReadonlyArray<string>;
  readonly children: ReactNode;
}) {
  const [waiting, setWaiting] = useState<ReadonlyMap<string, number>>(new Map());
  const listWaiting = useCallback((threadId: string, movedAt: string | undefined) => {
    const key = waitingKey(threadId, movedAt);
    setWaiting((current) => new Map(current).set(key, (current.get(key) ?? 0) + 1));
    return () =>
      setWaiting((current) => {
        const next = new Map(current);
        const count = (next.get(key) ?? 1) - 1;
        if (count > 0) next.set(key, count);
        else next.delete(key);
        return next;
      });
  }, []);
  const waitingKeys = useMemo(() => [...waiting.keys()].toSorted(), [waiting]);
  const forThread = useSidebarPendingRequests(props.source, waitingKeys);
  const shown = useMemo(() => new Set(props.shownThreadIds), [props.shownThreadIds]);
  const shows = useCallback((threadId: string) => shown.has(threadId), [shown]);
  const value = useMemo(() => ({ forThread, listWaiting, shows }), [forThread, listWaiting, shows]);
  return (
    <SidebarPendingRequestsContext.Provider value={value}>
      {props.children}
    </SidebarPendingRequestsContext.Provider>
  );
}
