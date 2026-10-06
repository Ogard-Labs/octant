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

export interface InlineCanvasPlacement {
  /** Inline Canvases to draw after the row with this key, oldest first. */
  readonly byRow: ReadonlyMap<string, ReadonlyArray<CanvasThreadReferenceCard>>;
  /** Canvases the transcript draws, which the thread's card list then leaves out. */
  readonly placed: ReadonlySet<string>;
}

/**
 * Place each inline Canvas at the end of the turn that wrote it: the last turn
 * the person opened at or before the Canvas's first version. A Canvas the
 * transcript cannot place (no creation time from an older host, or turns not
 * loaded yet) stays a card, so nothing a thread wrote is ever hidden.
 */
export function placeInlineCanvases(
  turns: ReadonlyArray<ThreadTurnSpan>,
  cards: ReadonlyArray<CanvasThreadReferenceCard>,
): InlineCanvasPlacement {
  const byRow = new Map<string, CanvasThreadReferenceCard[]>();
  const placed = new Set<string>();
  const inline = cards
    .filter((card) => card.presentation === "inline" && card.canvasCreatedAt !== undefined)
    .toSorted(
      (left, right) =>
        Date.parse(String(left.canvasCreatedAt)) - Date.parse(String(right.canvasCreatedAt)),
    );
  for (const card of inline) {
    const createdAt = Date.parse(String(card.canvasCreatedAt));
    const turn = turns.findLast((span) => Date.parse(span.startedAt) <= createdAt);
    if (turn === undefined) continue;
    byRow.set(turn.endKey, [...(byRow.get(turn.endKey) ?? []), card]);
    placed.add(String(card.canvasId));
  }
  return { byRow, placed };
}
