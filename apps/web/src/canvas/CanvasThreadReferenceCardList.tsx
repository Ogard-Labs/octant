import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type {
  CanvasOriginThreadId,
  CanvasThreadReferenceCard,
} from "@octant/contracts/canvas-cards";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { useEffect, useState } from "react";
import { CanvasThreadReferenceCard as CardView } from "./CanvasThreadReferenceCard";

export interface CanvasThreadReferenceCardListProps {
  readonly client: CanvasClient;
  readonly mode: OctantMode;
  readonly threadId: CanvasOriginThreadId;
  readonly projectId: ProjectId | null;
  readonly refreshKey?: number;
  readonly onOpen?: (card: CanvasThreadReferenceCard) => void;
}

export function CanvasThreadReferenceCardList(props: CanvasThreadReferenceCardListProps) {
  const [cards, setCards] = useState<ReadonlyArray<CanvasThreadReferenceCard>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void props.client
      .threadReferenceCards({
        mode: props.mode,
        threadId: String(props.threadId),
        projectId: props.projectId,
      })
      .then((outcome) => {
        if (!cancelled) setCards(outcome.cards);
      })
      .catch(() => {
        if (!cancelled) setError("Canvas references are unavailable.");
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.mode, props.projectId, props.refreshKey, props.threadId]);

  if (error) {
    return <p data-testid="canvas-card-list-error">{error}</p>;
  }
  if (cards.length === 0) return null;
  return (
    <section aria-label="Canvas references" className="stack" data-testid="canvas-card-list">
      {cards.map((card) => (
        <div key={String(card.cardId)}>
          <CardView card={card} />
          {props.onOpen ? (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => props.onOpen?.(card)}
            >
              Open Canvas
            </button>
          ) : null}
        </div>
      ))}
    </section>
  );
}
