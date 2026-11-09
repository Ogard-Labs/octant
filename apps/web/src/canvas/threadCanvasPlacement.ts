import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";

/** One turn of a transcript: when the person's message opened it, and the row it ends on. */
export interface ThreadTurnSpan {
  readonly startedAt: string;
  readonly endKey: string;
}

/**
 * The turns of a transcript, read from its rows in order. A row that opens a
 * turn carries the time the person's message was accepted; every other row
 * belongs to the turn before it. Rows ahead of the first turn are skipped.
 */
export function threadTurnSpans<T>(
  rows: ReadonlyArray<T>,
  key: (row: T) => string,
  turnStartedAt: (row: T) => string | undefined,
): ReadonlyArray<ThreadTurnSpan> {
  const spans: ThreadTurnSpan[] = [];
  for (const row of rows) {
    const startedAt = turnStartedAt(row);
    if (startedAt !== undefined) {
      spans.push({ startedAt, endKey: key(row) });
      continue;
    }
    const last = spans.at(-1);
    if (last !== undefined) spans[spans.length - 1] = { ...last, endKey: key(row) };
  }
  return spans;
}

export interface ThreadTurnPlacement<T> {
  /** Items to show after the row with this key, oldest first. */
  readonly byRow: ReadonlyMap<string, ReadonlyArray<T>>;
  /** Ids of the items the transcript shows, which the thread's list then leaves out. */
  readonly placed: ReadonlySet<string>;
}

export type ThreadCanvasPlacement = ThreadTurnPlacement<CanvasThreadReferenceCard>;

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
 * Place each Canvas at the end of the turn that wrote it. An inline Canvas is
 * drawn there and any other is a row that opens it, so a thread with many
 * Canvases never grows a bar above its composer. A Canvas the transcript
 * cannot place (no creation time from an older host, or turns not loaded
 * yet) stays in the card list.
 */
export function placeThreadCanvases(
  turns: ReadonlyArray<ThreadTurnSpan>,
  cards: ReadonlyArray<CanvasThreadReferenceCard>,
): ThreadCanvasPlacement {
  return placeByTurn(
    turns,
    cards,
    (card) => (card.canvasCreatedAt === undefined ? undefined : String(card.canvasCreatedAt)),
    (card) => String(card.canvasId),
  );
}
