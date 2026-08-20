import type { CanvasThreadReferenceCard as Card } from "@octant/contracts/canvas-cards";

export interface CanvasThreadReferenceCardProps {
  readonly card: Card;
}

export function CanvasThreadReferenceCard({ card }: CanvasThreadReferenceCardProps) {
  return (
    <div className="card card-tight" data-testid="canvas-card">
      <h3 className="h4" data-testid="canvas-card-title">
        {card.title}
      </h3>
      <div className="badge" data-testid="canvas-card-status">
        {card.status}
      </div>
      <div className="meta" data-testid="canvas-card-scope">
        {card.scope.mode} / {card.scope.workspace.kind}
      </div>
      {card.summary ? <p data-testid="canvas-card-summary">{card.summary}</p> : null}
      <div className="meta" data-testid="canvas-card-actions">
        {card.actionCount}
      </div>
    </div>
  );
}
