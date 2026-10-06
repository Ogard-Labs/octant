import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { CanvasThreadReferenceCard as CardView } from "./CanvasThreadReferenceCard";

export interface CanvasThreadReferenceCardListProps {
  readonly cards: ReadonlyArray<CanvasThreadReferenceCard>;
  readonly error: string | null;
  readonly onOpen?: (card: CanvasThreadReferenceCard) => void;
}

export function CanvasThreadReferenceCardList(props: CanvasThreadReferenceCardListProps) {
  if (props.error) {
    return (
      <p className="canvas-ref-list__error" data-testid="canvas-card-list-error">
        {props.error}
      </p>
    );
  }
  if (props.cards.length === 0) return null;
  return (
    <section aria-label="Canvases" className="canvas-ref-list" data-testid="canvas-card-list">
      {props.cards.map((card) => (
        <CardView
          card={card}
          key={String(card.cardId)}
          {...(props.onOpen === undefined ? {} : { onOpen: props.onOpen })}
        />
      ))}
    </section>
  );
}
