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
import type { SharedPendingRequestRead } from "../pendingRequests/usePendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowEntry,
} from "../pendingRequests/usePendingRequestRows";
import type { PendingRequestAnswerClients } from "../pendingRequests/pendingRequests";

/**
 * What the sidebar needs to answer a waiting thread's approval on its row: the
 * window's pending-request read and the clients each thread view already
 * answers through. A window without a reader (a remote client) offers only Open.
 */
export interface SidebarPendingRequestSource {
  /**
   * The window's one pending-request read, which also counts the threads a
   * subagent or the agent itself holds waiting. It re-reads on Work, Code and
   * tool-approval signals and the shell's settings and workspace. The sidebar
   * lists from it rather than reading on its own: the host reads every request
   * source for each read, and two readers following the same signals made it
   * do that twice for every Code navigation change.
   */
  readonly shared: SharedPendingRequestRead;
  /**
   * Bumps on the Chat navigation topic, which the shared read does not follow
   * because a streaming Chat reply moves it on every delta.
   */
  readonly chatRevision: number;
  readonly answerClients: PendingRequestAnswerClients;
  /** The clock the waits read, advanced once a minute by the shell. */
  readonly now: number;
}

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
   * read once. While some listed row offers answers the sidebar also re-reads
   * on Chat navigation, the one signal the window's shared read leaves out;
   * a sidebar whose rows can only open their threads adds no other read.
   */
  readonly listWaiting: (threadId: string, movedAt: string | undefined) => () => void;
}

/** Read by every Needs-you row in Status and the Activity feed. */
export const SidebarPendingRequestsContext = createContext<SidebarPendingRequests | undefined>(
  undefined,
);

const EVERY_MODE: ReadonlyArray<OctantMode> = ["chat", "work", "code"];

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
 * The window's pending-request read, matched to the sidebar's rows by thread.
 * Rows list from it only while some row waits. The sidebar adds a read only
 * where the shared read would not make one: when a waiting row appears or its
 * thread moves while no row offers answers, and on Chat navigation while some
 * row does. The host re-checks every answer; a row only offers what the host
 * listed.
 */
export function useSidebarPendingRequests(
  source: SidebarPendingRequestSource | undefined,
  waiting: ReadonlyArray<string>,
): SidebarPendingRequests["forThread"] {
  const reading = waiting.length > 0 && source !== undefined;
  const [following, setFollowing] = useState(false);
  const { rows, answer, refresh } = usePendingRequestRows(
    source === undefined
      ? undefined
      : {
          answerClients: source.answerClients,
          feedRevision: 0,
          modes: EVERY_MODE,
          now: source.now,
          pendingRequestClient: undefined,
          settings: undefined,
          shared: source.shared,
          workspace: undefined,
        },
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
  // The Chat revision the sidebar last asked for a read at. Starting to follow
  // again reads once only if Chat moved meanwhile.
  const chatRevision = source?.chatRevision ?? 0;
  const readAtChat = useRef(chatRevision);
  useEffect(() => {
    if (!following || readAtChat.current === chatRevision) return;
    readAtChat.current = chatRevision;
    refresh();
  }, [chatRevision, following, refresh]);
  // A row that starts waiting, or whose thread moved, needs one read to say
  // what it asks. The shared read's first read covers rows listed before it
  // lands, and while the sidebar follows, the signals that moved the row also
  // move a read, so a second one here would only repeat it.
  const loaded = source?.shared.read.status === "ready";
  const listed = useRef<ReadonlySet<string>>(new Set());
  const waitingList = waiting.join("\t");
  useEffect(() => {
    const now = waitingList === "" ? [] : waitingList.split("\t");
    const before = listed.current;
    listed.current = new Set(now);
    if (following || !loaded || !now.some((key) => !before.has(key))) return;
    readAtChat.current = chatRevision;
    refresh();
  }, [chatRevision, following, loaded, waitingList, refresh]);
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
