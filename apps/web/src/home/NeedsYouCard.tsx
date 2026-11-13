import type { PendingRequest, WaitingAsk } from "@octant/contracts/pending-requests";
import { BellRing } from "lucide-react";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import {
  canAnswerWaitingAsk,
  NEEDS_YOU_ROW_LIMIT,
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
export function createNeedsYouCard(source: NeedsYouCardSource): HomeCardDefinition {
  return {
    id: NEEDS_YOU_CARD_ID,
    title: "Needs you",
    icon: BellRing,
    defaultOn: true,
    available: source.pendingRequestClient !== undefined,
    hideWhenEmpty: true,
    emptyLabel: "Nothing is waiting for you.",
    useContent: () => useNeedsYouContent(source),
  };
}

function useNeedsYouContent(source: NeedsYouCardSource): HomeCardContent {
  const { now, onOpenThread, onOpenInbox } = source;
  const { rows, answer, defer, asks, answerAsk } = usePendingRequestRows(source);

  // Before the first read the card says nothing rather than "Looking…": it
  // leaves the grid when nothing waits, so a loading line would flash on
  // every start screen and then disappear.
  if (rows === undefined) return { status: "ready", count: 0, body: null };
  const shown = rows.slice(0, NEEDS_YOU_ROW_LIMIT);
  // Asks take the rows the requests leave, so the card keeps its one limit.
  const shownAsks = asks.slice(0, NEEDS_YOU_ROW_LIMIT - shown.length);
  const hidden = rows.length + asks.length - shown.length - shownAsks.length;
  return {
    status: "ready",
    count: rows.length + asks.length,
    body: (
      <>
        <ul className="needs-you__list">
          {shown.map(({ request, unlisted }) => (
            <li key={pendingRequestKey(request)}>
              <PendingRequestRow
                coordinatorTitle={source.coordinatorTitles?.get(String(request.threadId))}
                onDefer={defer}
                now={now}
                onAnswer={answer}
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
            </li>
          ))}
          {shownAsks.map((ask) => (
            <li key={waitingAskKey(ask)}>
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
            </li>
          ))}
        </ul>
        {hidden <= 0 ? null : (
          <OctantButton
            className="needs-you__more window-no-drag"
            onClick={onOpenInbox}
            size="sm"
            type="button"
            variant="link"
          >
            {`+${String(hidden)} more`}
          </OctantButton>
        )}
      </>
    ),
  };
}
