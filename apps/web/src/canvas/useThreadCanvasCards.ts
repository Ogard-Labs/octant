import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type {
  CanvasOriginThreadId,
  CanvasThreadReferenceCard,
} from "@octant/contracts/canvas-cards";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { useEffect, useRef, useState } from "react";

export interface ThreadCanvasCardsInput {
  readonly client: CanvasClient | undefined;
  readonly mode: OctantMode;
  /** Undefined while the thread is still loading; nothing is read until it is known. */
  readonly threadId: CanvasOriginThreadId | undefined;
  readonly projectId: ProjectId | null;
  /** Bumped when a settled turn may have written a Canvas, so the cards are read again. */
  readonly refreshKey?: number;
  /** The cards the host currently lists for this thread, each time they are read. */
  readonly onCardsObserved?: (cards: ReadonlyArray<CanvasThreadReferenceCard>) => void;
}

export interface ThreadCanvasCards {
  readonly cards: ReadonlyArray<CanvasThreadReferenceCard>;
  readonly error: string | null;
}

const NO_CARDS: ReadonlyArray<CanvasThreadReferenceCard> = [];

/**
 * The Canvases a thread wrote, read once per thread and settled turn. The
 * transcript draws the inline ones and the card list shows the rest, so both
 * read from this one request rather than asking the host twice.
 */
export function useThreadCanvasCards(input: ThreadCanvasCardsInput): ThreadCanvasCards {
  const [cards, setCards] = useState<ReadonlyArray<CanvasThreadReferenceCard>>(NO_CARDS);
  const [error, setError] = useState<string | null>(null);
  // Read through a ref so an inline observer does not refetch on every render.
  const onCardsObserved = useRef(input.onCardsObserved);
  onCardsObserved.current = input.onCardsObserved;
  const { client, mode, projectId, refreshKey, threadId } = input;
  // Another thread's Canvases must never show in this one's transcript while
  // its own are read, or stay there if that read fails. The same thread keeps
  // what it has, whether a settled turn refreshes it or its Project resolves
  // after the first read, so its rows do not blink or move under a click.
  useEffect(() => {
    setCards(NO_CARDS);
  }, [mode, threadId]);
  useEffect(() => {
    if (client === undefined || threadId === undefined) return;
    let cancelled = false;
    setError(null);
    void client
      .threadReferenceCards({ mode, threadId: String(threadId), projectId })
      .then((outcome) => {
        if (cancelled) return;
        setCards(outcome.cards);
        onCardsObserved.current?.(outcome.cards);
      })
      .catch(() => {
        if (!cancelled) setError("Canvas references are unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [client, mode, projectId, refreshKey, threadId]);
  return { cards, error };
}
