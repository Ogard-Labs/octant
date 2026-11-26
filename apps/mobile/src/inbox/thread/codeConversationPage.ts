import {
  loadMobileCodeConversation,
  type MobileCodeConversation,
  type MobileRemoteTransport,
} from "@octant/client-runtime";

/**
 * The page to show: the anchored one while the reader stays on an earlier
 * page, else the newest. A search hit missing from the newest page is read
 * through its turn; the page is anchored only while it really ends before the
 * newest turn (a host that no longer holds the turn answers the newest).
 */
export async function loadCodeConversationPage(
  transport: MobileRemoteTransport,
  threadId: string,
  anchor: string | undefined,
  focus: string | undefined,
): Promise<{ readonly loaded: MobileCodeConversation; readonly anchoredAt: string | undefined }> {
  if (anchor !== undefined) {
    const loaded = await loadMobileCodeConversation(transport, threadId, { through: anchor });
    return { loaded, anchoredAt: loaded.hasLater ? anchor : undefined };
  }
  const newest = await loadMobileCodeConversation(transport, threadId);
  if (
    focus === undefined ||
    !newest.hasEarlier ||
    newest.turns.some((turn) => turn.operationId === focus)
  ) {
    return { loaded: newest, anchoredAt: undefined };
  }
  const earlier = await loadMobileCodeConversation(transport, threadId, { through: focus });
  return { loaded: earlier, anchoredAt: earlier.hasLater ? focus : undefined };
}

/**
 * Whether the phone keeps re-reading the thread: its newest turn runs, or a
 * turn waits. The phone holds no stream of a Code turn, so without this a
 * running reply, and a message sent into it, shows only at the next refresh.
 * It decides reading alone; the composer stays open while a turn runs.
 */
export function rereadsCodeThread(
  turns: ReadonlyArray<Pick<MobileCodeConversation["turns"][number], "status">>,
): boolean {
  return turns.at(-1)?.status === "incomplete" || turns.some((turn) => turn.status === "waiting");
}

/**
 * Whether the phone takes a light look, now and then, for a turn started on
 * another device: it shows the newest turns and none of them runs. A turn
 * that runs is re-read already, and an anchored search page stays in place.
 */
export function looksForTurnStartedElsewhere(shown: MobileCodeConversation | undefined): boolean {
  return shown !== undefined && !shown.hasLater && !rereadsCodeThread(shown.turns);
}

/**
 * Whether the light look at the newest turn calls for reading the page again:
 * the host's newest turn is not the one shown, even if it already finished,
 * or the shown one runs or waits again.
 */
export function refreshesForNewestTurn(
  shown: MobileCodeConversation,
  newest:
    | Pick<MobileCodeConversation["turns"][number], "operationId" | "status">
    | null
    | undefined,
): boolean {
  if (newest === undefined || newest === null) return false;
  return (
    newest.operationId !== shown.turns.at(-1)?.operationId ||
    newest.status === "incomplete" ||
    newest.status === "waiting"
  );
}
