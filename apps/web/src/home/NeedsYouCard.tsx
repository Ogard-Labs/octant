import type { PendingRequest } from "@octant/contracts/pending-requests";
import { BellRing } from "lucide-react";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import { PendingRequestRow } from "../pendingRequests/PendingRequestRow";
import { NEEDS_YOU_ROW_LIMIT, pendingRequestKey } from "../pendingRequests/pendingRequests";
import {
  usePendingRequestRows,
  type PendingRequestRowsSource,
} from "../pendingRequests/usePendingRequestRows";

export const NEEDS_YOU_CARD_ID = "needs-you";

/**
 * The reader and answer clients come from {@link PendingRequestRowsSource}: a
 * start screen speaks for some modes (Work's is Chat and Work, Code's is
 * Code), and without a reader (a remote window) the card is unavailable.
 */
export interface NeedsYouCardSource extends PendingRequestRowsSource {
  readonly projectNames: ReadonlyMap<string, string>;
  /** The provider of each thread the shell knows, by thread id. */
  readonly threadProviders: ReadonlyMap<string, ThreadProviderIdentity>;
  /** The clock the waits read, advanced once a minute by the shell. */
  readonly now: number;
  readonly onOpenThread: (request: PendingRequest) => void;
  /** Opens the Inbox, which holds every row the card cannot fit. */
  readonly onOpenInbox: () => void;
}

/**
 * The Needs you card: every approval and question a provider is waiting on in
 * this window's Projects, answered where it is listed. It holds no authority;
 * each answer goes through the mode's own command with the handle the host
 * listed. Available only where the host can be asked (a local window), and
 * gone from the grid while nothing waits.
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
  const { rows, answer } = usePendingRequestRows(source);

  // Before the first read the card says nothing rather than "Looking…": it
  // leaves the grid when nothing waits, so a loading line would flash on
  // every start screen and then disappear.
  if (rows === undefined) return { status: "ready", count: 0, body: null };
  const shown = rows.slice(0, NEEDS_YOU_ROW_LIMIT);
  const hidden = rows.length - shown.length;
  return {
    status: "ready",
    count: rows.length,
    body: (
      <>
        <ul className="needs-you__list">
          {shown.map(({ request, unlisted }) => (
            <li key={pendingRequestKey(request)}>
              <PendingRequestRow
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
