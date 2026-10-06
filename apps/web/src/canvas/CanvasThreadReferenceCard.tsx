import type {
  CanvasCardStatus,
  CanvasThreadReferenceCard as Card,
} from "@octant/contracts/canvas-cards";
import { ChevronRight, FileStack } from "lucide-react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";

export interface CanvasThreadReferenceCardProps {
  readonly card: Card;
  /** Opens the Canvas; without it the row only names the document. */
  readonly onOpen?: (card: Card) => void;
}

/** What a person reads for a card that is not simply ready to open. */
const STATUS_WORDS: Record<Exclude<CanvasCardStatus, "ready">, string> = {
  creating: "Creating",
  limited: "Limited",
  stale: "Out of date",
  offline: "Offline",
  unauthorized: "Not available here",
  invalid: "Can't be shown",
  interrupted: "Interrupted",
  oversized: "Too large to show",
  incompatible: "Needs a newer Octant",
  failed: "Failed",
};

/**
 * A Canvas the thread wrote, as one row: the document's mark, its title, and
 * one line saying what it is and when it last changed. The whole row opens
 * it, the way a count tile or a board card opens what it names.
 */
export function CanvasThreadReferenceCard({ card, onOpen }: CanvasThreadReferenceCardProps) {
  const facts = [
    card.status === "ready" ? "Canvas" : STATUS_WORDS[card.status],
    card.actionCount > 0
      ? `${String(card.actionCount)} ${card.actionCount === 1 ? "action" : "actions"}`
      : undefined,
    `Updated ${relativeTimeLabel(card.createdAt)}`,
  ].filter((fact): fact is string => fact !== undefined);
  const face = (
    <>
      <span aria-hidden="true" className="canvas-ref__icon">
        <FileStack size={16} strokeWidth={1.7} />
      </span>
      <span className="canvas-ref__text">
        <span className="canvas-ref__title" data-testid="canvas-card-title">
          {card.title}
        </span>
        {card.summary ? (
          <span className="canvas-ref__summary" data-testid="canvas-card-summary">
            {card.summary}
          </span>
        ) : null}
        <span
          className="canvas-ref__meta"
          data-testid="canvas-card-meta"
          title={absoluteTimeFormatter.format(Date.parse(card.createdAt))}
        >
          {facts.join(" · ")}
        </span>
      </span>
      {onOpen === undefined ? null : (
        <ChevronRight aria-hidden="true" className="canvas-ref__chevron" size={16} />
      )}
    </>
  );
  return onOpen === undefined ? (
    <div className="canvas-ref" data-testid="canvas-card">
      {face}
    </div>
  ) : (
    <OctantButton
      className="canvas-ref"
      data-testid="canvas-card"
      onClick={() => onOpen(card)}
      type="button"
      variant="bare"
    >
      {face}
    </OctantButton>
  );
}
