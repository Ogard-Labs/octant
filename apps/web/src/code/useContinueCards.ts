import { useEffect, useState } from "react";
import type { CodeBoardCard, CodeBoardQuery, CodeBoardView } from "@octant/contracts";

const CONTINUE_LIMIT = 6;

export type ContinueCards =
  | { readonly kind: "idle" }
  | { readonly kind: "ready"; readonly cards: ReadonlyArray<CodeBoardCard> };

/**
 * The threads the Code start screen offers to continue, read from the board.
 *
 * This read belongs to the window, not to the draft it is shown under. The
 * draft subtree is deliberately remounted to give a new task a clean composer,
 * and while the read lived inside it the Continue section unmounted and came
 * back on every New task, which reads as a flash. Held above that remount, the
 * cards survive it.
 *
 * A later read keeps the cards already on screen until fresh ones land, so
 * neither a slow board nor a refused one blanks the section.
 */
export function useContinueCards(
  loadBoard: ((query: CodeBoardQuery) => Promise<CodeBoardView>) | undefined,
  changeRevision: number,
): ContinueCards {
  const [cards, setCards] = useState<ContinueCards>({ kind: "idle" });
  useEffect(() => {
    if (loadBoard === undefined) {
      setCards({ kind: "idle" });
      return;
    }
    let cancelled = false;
    loadBoard({ version: 1 }).then(
      (view) => {
        if (cancelled) return;
        setCards({ kind: "ready", cards: latestFirst(view) });
      },
      () => {
        // A board that cannot be read says nothing new, so the section keeps
        // whatever it was already showing.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loadBoard, changeRevision]);
  return cards;
}

function latestFirst(view: CodeBoardView): ReadonlyArray<CodeBoardCard> {
  return [...view.cards]
    .sort((a, b) =>
      (b.lastMeaningfulActivityAt ?? "").localeCompare(a.lastMeaningfulActivityAt ?? ""),
    )
    .slice(0, CONTINUE_LIMIT);
}
