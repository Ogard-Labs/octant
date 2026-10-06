import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasThreadReferenceCard as CardView } from "./CanvasThreadReferenceCard";

export interface CanvasThreadReferenceCardListProps {
  readonly cards: ReadonlyArray<CanvasThreadReferenceCard>;
  readonly error: string | null;
  readonly onOpen?: (card: CanvasThreadReferenceCard) => void;
}

export function CanvasThreadReferenceCardList(props: CanvasThreadReferenceCardListProps) {
  if (props.error) {
    return <p data-testid="canvas-card-list-error">{props.error}</p>;
  }
  if (props.cards.length === 0) return null;
  return (
    <section aria-label="Canvas references" className="stack" data-testid="canvas-card-list">
      {props.cards.map((card) => (
        <div key={String(card.cardId)}>
          <CardView card={card} />
          {props.onOpen ? (
            <OctantButton
              size="sm"
              type="button"
              variant="outline"
              onClick={() => props.onOpen?.(card)}
            >
              Open Canvas
            </OctantButton>
          ) : null}
        </div>
      ))}
    </section>
  );
}
