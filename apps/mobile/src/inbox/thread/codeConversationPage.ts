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
