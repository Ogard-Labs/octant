import type { ChatThreadView, ChatThreadWindow } from "@octant/contracts/chat";
import { activeChatTurns } from "@octant/domain/chat-policy";
import { prependEarlierTurns, refreshNewestTurns } from "@octant/domain";

/** How many turns the client asks for per page; the host answers at most 50. */
export const CHAT_WINDOW_PAGE_TURNS = 30;

type ChatTurnView = ChatThreadView["turns"][number];

export type ChatWindowPageState = "idle" | "loading" | "failed";

/**
 * A run of turns the reader jumped to that does not reach the newest turn. It
 * is shown in place of the newest turns until it is joined to them or left;
 * the newest turns keep receiving live updates meanwhile.
 */
export interface ChatDetachedRange {
  readonly view: ChatThreadView;
  readonly hasEarlier: boolean;
  readonly hasLater: boolean;
  readonly earlier: ChatWindowPageState;
  readonly later: ChatWindowPageState;
}

/**
 * What the open thread holds beyond its newest turns. `windowed` is false
 * when the host answered the whole thread because it has no window read; the
 * view is then complete and nothing is offered.
 */
export interface ChatTranscriptWindowState {
  readonly threadKey: string;
  readonly windowed: boolean;
  readonly hasEarlier: boolean;
  /** Stays set once earlier messages were offered, so the row keeps its place. */
  readonly offerEarlier: boolean;
  readonly supersededTurnCount: number;
  readonly earlier: ChatWindowPageState;
  readonly detached?: ChatDetachedRange;
}

export const chatTurnKey = (turn: ChatTurnView): string => String(turn.id);

/** The window state for a whole-thread read from a host without the window route. */
export function wholeThreadWindowState(view: ChatThreadView): ChatTranscriptWindowState {
  return {
    threadKey: String(view.thread.id),
    windowed: false,
    hasEarlier: false,
    offerEarlier: false,
    supersededTurnCount: view.turns.length - activeChatTurns(view.turns).length,
    earlier: "idle",
  };
}

/**
 * The view a set of kept turns needs: thread-wide facts from `head`, and the
 * bodies, attachments, sources, and route receipts of the kept turns from
 * either view, `head` winning. What belongs to no turn yet (an attachment
 * waiting for the next message, a route receipt whose turn was never
 * accepted) comes from `head` alone, because only the newest read knows it.
 */
export function joinChatViews(
  head: ChatThreadView,
  other: ChatThreadView,
  turns: ReadonlyArray<ChatTurnView>,
): ChatThreadView {
  const kept = new Set(turns.map(chatTurnKey));
  const headTurns = new Set(head.turns.map(chatTurnKey));
  const attachments = unionBy(head.attachments, other.attachments, (item) =>
    String(item.id),
  ).filter((attachment) =>
    attachment.turnId === undefined
      ? head.attachments.includes(attachment)
      : kept.has(String(attachment.turnId)),
  );
  const citations = unionBy(head.citations, other.citations, (item) =>
    String(item.citationId),
  ).filter((citation) => kept.has(String(citation.turnId)));
  const routeDecisions = unionBy(head.routeDecisions ?? [], other.routeDecisions ?? [], (item) =>
    String(item.turnId),
  ).filter(
    (decision) =>
      kept.has(String(decision.turnId)) ||
      ((head.routeDecisions ?? []).includes(decision) && !headTurns.has(String(decision.turnId))),
  );
  const referenced = new Set<string>();
  for (const turn of turns) {
    referenced.add(String(turn.userMessageRef.contentId));
    for (const attempt of turn.attempts) {
      for (const reference of attempt.responseRefs) referenced.add(String(reference.contentId));
      if (attempt.researchRef !== undefined) referenced.add(String(attempt.researchRef.contentId));
    }
  }
  for (const citation of citations) {
    if (citation.snippetRef !== undefined) referenced.add(String(citation.snippetRef.contentId));
  }
  const contents = unionBy(head.contents, other.contents, (item) => String(item.contentId)).filter(
    (content) => referenced.has(String(content.contentId)),
  );
  const { routeDecisions: _headDecisions, ...rest } = head;
  return {
    ...rest,
    turns,
    contents,
    attachments,
    citations,
    ...(routeDecisions.length === 0 ? {} : { routeDecisions }),
  };
}

/**
 * Join a freshly read newest window onto the newest turns the client holds.
 * When the window's first turn is already held, the earlier pages stay;
 * otherwise the two runs cannot be shown to touch, and the window replaces
 * what was held, taking its own bound on earlier turns.
 */
export function refreshChatTail(
  current: ChatThreadView,
  currentHasEarlier: boolean,
  newest: ChatThreadWindow,
): { readonly view: ChatThreadView; readonly hasEarlier: boolean } {
  const refreshed = refreshNewestTurns(current.turns, newest.view.turns, chatTurnKey);
  if (refreshed.kind === "replaced") {
    return { view: newest.view, hasEarlier: newest.hasEarlier };
  }
  return {
    view: joinChatViews(newest.view, current, refreshed.turns),
    hasEarlier: currentHasEarlier,
  };
}

/** Put an earlier page above a run of turns. */
export function prependChatPage(current: ChatThreadView, page: ChatThreadView): ChatThreadView {
  return joinChatViews(current, page, prependEarlierTurns(current.turns, page.turns, chatTurnKey));
}

/** Put a later page below a run of turns. */
export function appendChatPage(current: ChatThreadView, page: ChatThreadView): ChatThreadView {
  const held = new Set(current.turns.map(chatTurnKey));
  return joinChatViews(current, page, [
    ...current.turns,
    ...page.turns.filter((turn) => !held.has(chatTurnKey(turn))),
  ]);
}

/**
 * Join a detached range onto the newest turns once the two share a turn. Both
 * are contiguous runs, so a shared turn proves the union is one run too.
 * Answers undefined while they do not touch.
 */
export function joinDetachedRange(
  tail: ChatThreadView,
  tailHasEarlier: boolean,
  detached: ChatDetachedRange,
): { readonly view: ChatThreadView; readonly hasEarlier: boolean } | undefined {
  const held = new Set(tail.turns.map(chatTurnKey));
  if (!detached.view.turns.some((turn) => held.has(chatTurnKey(turn)))) return undefined;
  const opening = detached.view.turns[0];
  const startsEarlier = opening !== undefined && !held.has(chatTurnKey(opening));
  return {
    view: prependChatPage(tail, detached.view),
    hasEarlier: startsEarlier ? detached.hasEarlier : tailHasEarlier,
  };
}

/** Whether a turn is part of a run the client holds. */
export function holdsTurn(view: ChatThreadView | undefined, turnId: string): boolean {
  return view?.turns.some((turn) => String(turn.id) === turnId) === true;
}

function unionBy<T>(
  first: ReadonlyArray<T>,
  second: ReadonlyArray<T>,
  key: (item: T) => string,
): ReadonlyArray<T> {
  const seen = new Set(first.map(key));
  return [...first, ...second.filter((item) => !seen.has(key(item)))];
}
