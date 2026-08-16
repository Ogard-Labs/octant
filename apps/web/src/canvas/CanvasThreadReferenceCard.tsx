import type { CanvasThreadReferenceCard as Card } from "@octant/contracts/canvas-cards";

export interface CanvasThreadReferenceCardProps {
  readonly card: Card;
}

export function CanvasThreadReferenceCard({ card }: CanvasThreadReferenceCardProps) {
  return (
    <div data-testid="canvas-card">
      <h3 data-testid="canvas-card-title">{card.title}</h3>
      <div data-testid="canvas-card-status">{card.status}</div>
      <div data-testid="canvas-card-scope">
        {card.scope.mode} / {card.scope.workspace.kind}
      </div>
      {card.summary ? <p data-testid="canvas-card-summary">{card.summary}</p> : null}
      <div data-testid="canvas-card-actions">{card.actionCount}</div>
    </div>
  );
}
