import type { CanvasThreadReferenceCard as Card } from "@octant/contracts/canvas-cards";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantCard } from "../ui/base/OctantCard";

export interface CanvasThreadReferenceCardProps {
  readonly card: Card;
}

export function CanvasThreadReferenceCard({ card }: CanvasThreadReferenceCardProps) {
  return (
    <OctantCard className="p-5" data-testid="canvas-card">
      <h3 className="h4" data-testid="canvas-card-title">
        {card.title}
      </h3>
      <OctantBadge data-testid="canvas-card-status" variant="secondary">
        {card.status}
      </OctantBadge>
      <div className="meta" data-testid="canvas-card-scope">
        {card.scope.mode} / {card.scope.workspace.kind}
      </div>
      {card.summary ? <p data-testid="canvas-card-summary">{card.summary}</p> : null}
      <div className="meta" data-testid="canvas-card-actions">
        {card.actionCount}
      </div>
    </OctantCard>
  );
}
