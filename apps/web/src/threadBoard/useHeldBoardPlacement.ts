import { useState, type PointerEvent } from "react";

interface HeldCard {
  readonly threadId: unknown;
}

interface HeldColumn<TCard extends HeldCard> {
  readonly key: string;
  readonly cards: ReadonlyArray<TCard>;
}

/**
 * While a pointer rests on the board, every card keeps the column and slot it
 * had when the pointer arrived. Answering a card changes what the host reports
 * about it at once, and a column that re-sorts under the pointer slides the
 * next card beneath the cursor, so the click meant for its Deny lands on
 * whatever moved there.
 *
 * Only placement is held. Each held slot shows the newest card the host sent,
 * so status lines, request rows, and buttons stay live. A card the host no
 * longer lists keeps its slot with its last content, and a card it newly lists
 * joins the end of its column, so nothing already on screen shifts. Leaving the
 * board applies the host's placement.
 *
 * Touch has no hover, so the hold never starts for it and the board behaves as
 * the host reports. Keyboard users never point, so the same holds for them.
 */
export function useHeldBoardPlacement<TCard extends HeldCard, TColumn extends HeldColumn<TCard>>(
  columns: ReadonlyArray<TColumn>,
): {
  readonly columns: ReadonlyArray<TColumn>;
  readonly pointerHandlers: {
    readonly onPointerEnter: (event: PointerEvent) => void;
    readonly onPointerLeave: () => void;
  };
} {
  const [held, setHeld] = useState<ReadonlyArray<TColumn> | undefined>(undefined);
  return {
    columns: held === undefined ? columns : holdPlacement(held, columns),
    pointerHandlers: {
      onPointerEnter: (event) => {
        if (event.pointerType === "touch") return;
        setHeld((current) => current ?? columns);
      },
      onPointerLeave: () => setHeld(undefined),
    },
  };
}

function holdPlacement<TCard extends HeldCard, TColumn extends HeldColumn<TCard>>(
  held: ReadonlyArray<TColumn>,
  live: ReadonlyArray<TColumn>,
): ReadonlyArray<TColumn> {
  const newest = new Map<string, TCard>();
  for (const column of live) {
    for (const card of column.cards) newest.set(String(card.threadId), card);
  }
  const heldIds = new Set(
    held.flatMap((column) => column.cards.map((card) => String(card.threadId))),
  );
  const arrivals = (key: string): ReadonlyArray<TCard> =>
    (live.find((column) => column.key === key)?.cards ?? []).filter(
      (card) => !heldIds.has(String(card.threadId)),
    );
  const placed = held.map((column) => ({
    ...column,
    cards: [
      ...column.cards.map((card) => newest.get(String(card.threadId)) ?? card),
      ...arrivals(column.key),
    ],
  }));
  // A column the pointer never saw is shown as the host reports it.
  const unseen = live
    .filter((column) => !held.some((candidate) => candidate.key === column.key))
    .map((column) => ({
      ...column,
      cards: column.cards.filter((card) => !heldIds.has(String(card.threadId))),
    }));
  return [...placed, ...unseen];
}
