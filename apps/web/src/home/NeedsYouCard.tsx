import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { OctantMode } from "@octant/contracts";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { BellRing } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ThreadProviderIdentity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeCardContent, HomeCardDefinition } from "./homeCards";
import { PendingRequestRow } from "./PendingRequestRow";
import {
  answerPendingRequest,
  NEEDS_YOU_ROW_LIMIT,
  pendingRequestKey,
  pendingRequestsForModes,
  type PendingRequestAnswerClients,
  type PendingRequestResponse,
} from "./pendingRequests";
import { usePendingRequests, type PendingRequestFreshness } from "./usePendingRequests";

export const NEEDS_YOU_CARD_ID = "needs-you";

export interface NeedsYouCardSource extends PendingRequestFreshness {
  /** This window's reader; without one (a remote window) the card is unavailable. */
  readonly pendingRequestClient: PendingRequestClient | undefined;
  /** The clients each thread view already answers through. */
  readonly answerClients: PendingRequestAnswerClients;
  /** The modes this start screen speaks for; Work's is Chat and Work, Code's is Code. */
  readonly modes: ReadonlyArray<OctantMode>;
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

/**
 * A request whose answer was refused. If the host stops listing it, the row
 * stays so its refusal line can be read, until the next read or the shell's
 * next minute tick, whichever comes first; a quiet host may send no next read.
 */
interface RefusedRequest {
  readonly request: PendingRequest;
  readonly unlisted: boolean;
}

function useNeedsYouContent(source: NeedsYouCardSource): HomeCardContent {
  const { pendingRequestClient, answerClients, modes, now, onOpenThread, onOpenInbox } = source;
  const { read, refresh } = usePendingRequests(pendingRequestClient, {
    feedRevision: source.feedRevision,
    settings: source.settings,
    workspace: source.workspace,
  });
  const [refused, setRefused] = useState<ReadonlyMap<string, RefusedRequest>>(new Map());
  const listed = useMemo(
    () => (read.status === "ready" ? pendingRequestsForModes(read.requests, modes) : []),
    [modes, read],
  );

  // Each completed read reconciles what a refusal kept on screen: a request
  // the host no longer lists gets one read of grace, then leaves.
  useEffect(() => {
    setRefused((current) => {
      if (current.size === 0) return current;
      const live = new Set(listed.map(pendingRequestKey));
      const next = new Map<string, RefusedRequest>();
      for (const [key, entry] of current) {
        if (live.has(key)) next.set(key, entry);
        else if (!entry.unlisted) next.set(key, { request: entry.request, unlisted: true });
      }
      return next;
    });
  }, [listed]);

  useEffect(() => {
    setRefused((current) => {
      if (![...current.values()].some((entry) => entry.unlisted)) return current;
      return new Map([...current].filter(([, entry]) => !entry.unlisted));
    });
  }, [now]);

  const answer = useCallback(
    async (request: PendingRequest, response: PendingRequestResponse) => {
      const key = pendingRequestKey(request);
      setRefused((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
      const result = await answerPendingRequest(answerClients, request, response);
      if (result.status === "refused") {
        setRefused((current) => new Map(current).set(key, { request, unlisted: false }));
      }
      refresh();
      return result;
    },
    [answerClients, refresh],
  );

  // Before the first read the card says nothing rather than "Looking…": it
  // leaves the grid when nothing waits, so a loading line would flash on
  // every start screen and then disappear.
  if (read.status === "loading") return { status: "ready", count: 0, body: null };
  const liveKeys = new Set(listed.map(pendingRequestKey));
  const rows = [
    ...listed.map((request) => ({ request, unlisted: false })),
    ...[...refused]
      .filter(([key]) => !liveKeys.has(key))
      .map(([, entry]) => ({ request: entry.request, unlisted: true })),
  ].toSorted((a, b) => a.request.requestedAt.localeCompare(b.request.requestedAt));
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
