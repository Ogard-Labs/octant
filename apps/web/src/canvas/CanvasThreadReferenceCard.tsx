import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type {
  CanvasCardStatus,
  CanvasThreadReferenceCard as Card,
} from "@octant/contracts/canvas-cards";
import { ChevronRight, FileStack } from "lucide-react";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import { CanvasView } from "./CanvasView";
import { canvasDigest } from "./canvasDigest";
import { useCanvasDefinition } from "./useCanvasDefinition";

export interface CanvasThreadReferenceCardProps {
  readonly card: Card;
  /**
   * Reads the Canvas for a live preview and a digest of what it holds.
   * Without it the row shows the document's mark and its card facts only.
   */
  readonly client?: CanvasClient;
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
 * A Canvas the thread wrote, as one row: a live miniature of the document,
 * its title, and one line read off its content (a plan's next task, a
 * chart's series), with a plan's progress under it. The whole row opens it,
 * the way a count tile or a board card opens what it names.
 */
export function CanvasThreadReferenceCard({
  card,
  client,
  onOpen,
}: CanvasThreadReferenceCardProps) {
  const loaded = useCanvasDefinition(client, card, client !== undefined);
  const digest = loaded.kind === "ready" ? canvasDigest(loaded.definition) : undefined;
  const facts = [
    card.status === "ready" ? (digest?.label ?? "Canvas") : STATUS_WORDS[card.status],
    ...(digest?.facts ?? []),
    card.actionCount > 0
      ? `${String(card.actionCount)} ${card.actionCount === 1 ? "action" : "actions"}`
      : undefined,
    `Updated ${relativeTimeLabel(card.createdAt)}`,
  ].filter((fact): fact is string => fact !== undefined);
  const progress = digest?.progress;
  const face = (
    <>
      {loaded.kind === "ready" ? (
        // A miniature of the real renderer, not a picture of it. It is
        // decorative and inert, so nothing inside it can take focus or a click.
        <span aria-hidden="true" className="canvas-ref__preview" inert>
          <span className="canvas-ref__preview-page">
            <CanvasView input={loaded.definition} placement="thread" />
          </span>
        </span>
      ) : (
        <span aria-hidden="true" className="canvas-ref__icon">
          <FileStack size={16} strokeWidth={1.7} />
        </span>
      )}
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
        {progress === undefined || progress.total === 0 ? null : (
          <span className="canvas-ref__progress">
            <span className="canvas-ref__progress-track" aria-hidden="true">
              <span
                className="canvas-ref__progress-fill"
                style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }}
              />
            </span>
            <span className="canvas-ref__progress-label">
              {`${String(progress.done)} of ${String(progress.total)} done`}
            </span>
          </span>
        )}
      </span>
      {onOpen === undefined ? null : (
        <ChevronRight aria-hidden="true" className="canvas-ref__chevron" size={16} />
      )}
    </>
  );
  // The open control lies over the whole row rather than wrapping it: the
  // miniature is a real document with its own controls, and a button may not
  // hold other interactive content.
  return (
    <div className="canvas-ref" data-kind={digest?.kind} data-testid="canvas-card">
      {onOpen === undefined ? null : (
        <OctantButton
          aria-label={`Open ${card.title}`}
          className="canvas-ref__hit"
          onClick={() => onOpen(card)}
          type="button"
          variant="bare"
        />
      )}
      {face}
    </div>
  );
}
