import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";

/**
 * One turn of a transcript: when the person's message opened it, the row it
 * ends on, and its last reply row when it has one.
 */
export interface ThreadTurnSpan {
  readonly startedAt: string;
  readonly endKey: string;
  readonly replyKey?: string;
}

/**
 * The turns of a transcript, read from its rows in order. A row that opens a
 * turn carries the time the person's message was accepted; every other row
 * belongs to the turn before it. Rows ahead of the first turn are skipped.
 * `isReply` marks the agent's reply rows, so a caller can place what the turn
 * made above its last reply rather than after rows that follow it.
 */
export function threadTurnSpans<T>(
  rows: ReadonlyArray<T>,
  key: (row: T) => string,
  turnStartedAt: (row: T) => string | undefined,
  isReply?: (row: T) => boolean,
): ReadonlyArray<ThreadTurnSpan> {
  const spans: ThreadTurnSpan[] = [];
  for (const row of rows) {
    const startedAt = turnStartedAt(row);
    if (startedAt !== undefined) {
      // A row may open a turn and hold its reply too, as a Chat turn does.
      spans.push({
        startedAt,
        endKey: key(row),
        ...(isReply?.(row) === true ? { replyKey: key(row) } : {}),
      });
      continue;
    }
    const last = spans.at(-1);
    if (last === undefined) continue;
    spans[spans.length - 1] = {
      ...last,
      endKey: key(row),
      ...(isReply?.(row) === true ? { replyKey: key(row) } : {}),
    };
  }
  return spans;
}

export interface ThreadTurnPlacement<T> {
  /** Items to show after the row with this key, oldest first. */
  readonly byRow: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Ids of the items the transcript shows, which the thread's list then leaves out. */
  readonly placed: ReadonlySet<string>;
}

export interface ThreadCanvasPlacement extends ThreadTurnPlacement<CanvasThreadReferenceCard> {
  /** Canvases to draw inside the reply row with this key, above its text. */
  readonly beforeReply: ReadonlyMap<string, ReadonlyArray<CanvasThreadReferenceCard>>;
}

/**
 * Place each item at the end of the turn that made it: the last turn the
 * person opened at or before the item's creation time. An item the transcript
 * cannot place (no creation time, or turns not loaded yet) is left out of
 * `placed`, so the caller keeps it in its list and nothing is ever hidden.
 */
export function placeByTurn<T>(
  turns: ReadonlyArray<ThreadTurnSpan>,
  items: ReadonlyArray<T>,
  createdAt: (item: T) => string | undefined,
  id: (item: T) => string,
): ThreadTurnPlacement<T> {
  const byRow = new Map<string, T[]>();
  const placed = new Set<string>();
  const dated = items.flatMap((item) => {
    const at = createdAt(item);
    return at === undefined ? [] : [{ item, at: Date.parse(at) }];
  });
  for (const { item, at } of dated.toSorted((left, right) => left.at - right.at)) {
    const turn = turns.findLast((span) => Date.parse(span.startedAt) <= at);
    if (turn === undefined) continue;
    byRow.set(turn.endKey, [...(byRow.get(turn.endKey) ?? []), item]);
    placed.add(id(item));
  }
  return { byRow, placed };
}

/**
 * Place each Canvas in the turn that wrote it: above the turn's last reply,
 * so a summary reads before the words that add to it, or after the turn's
 * last row while it has no reply yet. An inline Canvas is drawn there and any
 * other is a row that opens it, so a thread with many Canvases never grows a
 * bar above its composer. A Canvas the transcript cannot place (no creation
 * time from an older host, or turns not loaded yet) stays in the card list.
 */
export function placeThreadCanvases(
  turns: ReadonlyArray<ThreadTurnSpan>,
  cards: ReadonlyArray<CanvasThreadReferenceCard>,
): ThreadCanvasPlacement {
  const replyKeys = new Set(turns.flatMap((turn) => turn.replyKey ?? []));
  const placement = placeByTurn(
    turns.map((turn) => ({ startedAt: turn.startedAt, endKey: turn.replyKey ?? turn.endKey })),
    cards,
    (card) => (card.canvasCreatedAt === undefined ? undefined : String(card.canvasCreatedAt)),
    (card) => String(card.canvasId),
  );
  const byRow = new Map<string, ReadonlyArray<CanvasThreadReferenceCard>>();
  const beforeReply = new Map<string, ReadonlyArray<CanvasThreadReferenceCard>>();
  for (const [key, placed] of placement.byRow) {
    (replyKeys.has(key) ? beforeReply : byRow).set(key, placed);
  }
  return { byRow, beforeReply, placed: placement.placed };
}
