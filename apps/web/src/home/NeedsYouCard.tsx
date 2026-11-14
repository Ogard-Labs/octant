import { useMinuteNow } from "../polling/useMinuteTick";
import type { PendingRequest, WaitingAsk } from "@octant/contracts/pending-requests";
import { BellRing } from "../ui/icons";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import type { HomeListCardDefinition, HomeListRead } from "./homeCards";
import { threadListId } from "./homeListModel";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import {
  canAnswerWaitingAsk,
  pendingRequestKey,
  waitingAskKey,
} from "../pendingRequests/pendingRequests";
import { WaitingAskRow } from "../pendingRequests/WaitingAskRow";
import {
  usePendingRequestRows,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";

export const NEEDS_YOU_CARD_ID = "needs-you";

/**
 * The reader and answer clients come from {@link PendingRequestRowsSource}: a
 * start screen speaks for some modes (Work's is Chat and Work, Code's is
 * Code), and without a reader the card is unavailable.
 */
export interface NeedsYouCardSource extends PendingRequestRowsSource {
  readonly projectNames: ReadonlyMap<string, string>;
  /** Each worker's coordinator title, by worker thread id, from the window's thread list. */
  readonly coordinatorTitles?: ReadonlyMap<string, string>;
  /** The provider of each thread the shell knows, by thread id. */
  readonly threadProviders: ReadonlyMap<string, ThreadProviderIdentity>;
  /** The clock the waits read, advanced once a minute by the shell. */
  readonly now: number;
  readonly onOpenThread: (request: PendingRequest) => void;
  /** Opens the thread of an ask its own card answers; absent, an ask row has nowhere to go. */
  readonly onOpenAsk?: ((ask: WaitingAsk) => void) | undefined;
  /** Opens the Inbox, which holds every row the card cannot fit. */
  readonly onOpenInbox: () => void;
}

/**
 * The Needs you card: every approval, question and other ask waiting on the
 * person in this window's Projects, answered where it is listed when the row
 * carries the whole ask. It holds no authority; each answer goes through the
 * mode's own command, or the ask's own route, with the handle the host
 * listed. Available wherever the host can be asked (a local window, or a
 * paired device reading under its own scope), and gone from the grid while
 * nothing waits.
 */
export function createNeedsYouCard(source: NeedsYouCardSource): HomeListCardDefinition {
  return {
    id: NEEDS_YOU_CARD_ID,
    title: "Needs you",
    icon: BellRing,
    defaultOn: true,
    available: source.pendingRequestClient !== undefined,
    useListRows: () => useNeedsYouListRows(source),
  };
}

/**
 * The same requests and asks as rows of the start screen's list. Each keeps
 * its own row, with the answer where it is listed, and stands for its thread,
 * so Continue and In progress do not name that thread a second time. Before
 * the first read the list says nothing rather than "Looking…".
 */
function useNeedsYouListRows(source: NeedsYouCardSource): HomeListRead {
  const { onOpenThread, onOpenInbox } = source;
  const now = useMinuteNow(source.now);
  const { rows, answer, defer, asks, answerAsk } = usePendingRequestRows(source);
  if (rows === undefined) return { status: "loading" };
  return {
    status: "ready",
    seeAll: { "needs-you": { label: "See all", onSelect: onOpenInbox } },
    rows: [
      ...rows.map(({ request, unlisted }) => ({
        id: `request:${pendingRequestKey(request)}`,
        aliases: [threadListId(String(request.threadId))],
        section: "needs-you" as const,
        glyph: "ask" as const,
        tone: "warning" as const,
        label: "Waiting for you",
        title: "",
        meta: [],
        custom: (
          <PendingRequestRow
            coordinatorTitle={source.coordinatorTitles?.get(String(request.threadId))}
            now={now}
            onAnswer={answer}
            onDefer={defer}
            onOpenThread={onOpenThread}
            projectName={
              request.projectId === undefined
                ? undefined
                : source.projectNames.get(String(request.projectId))
            }
            provider={source.threadProviders.get(String(request.threadId))}
            request={request}
            settled={unlisted}
          />
        ),
      })),
      ...asks.map((ask) => ({
        id: waitingAskKey(ask),
        aliases: [threadListId(String(ask.threadId))],
        section: "needs-you" as const,
        glyph: "ask" as const,
        tone: "warning" as const,
        label: "Waiting for you",
        title: "",
        meta: [],
        custom: (
          <WaitingAskRow
            ask={ask}
            now={now}
            onAnswer={canAnswerWaitingAsk(source.askClients, ask) ? answerAsk : undefined}
            onOpenThread={(opened) => source.onOpenAsk?.(opened)}
            projectName={
              ask.projectId === undefined
                ? undefined
                : source.projectNames.get(String(ask.projectId))
            }
          />
        ),
      })),
    ],
  };
}
