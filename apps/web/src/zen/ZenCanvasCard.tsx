import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasDefinition, CanvasId } from "@octant/contracts/canvas";
import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { CanvasDocument } from "../canvas/CanvasDocument";

export interface ZenCanvasCardProps {
  readonly client: Pick<CanvasClient, "get">;
  /**
   * The canvas this card names. Every read goes to the same journal a
   * workspace tab reads and is authorized the same way; the card holds the id
   * only so it can ask.
   */
  readonly canvasId: CanvasId;
}

/**
 * A pinned window onto a canvas this window may already open.
 *
 * The card renders the canvas's own current version rather than a copy: it
 * reads the document by id, and reads it again when asked. It carries no
 * canvas state of its own — no pinned version, no local edit, no separate
 * history — so a card and a tab on one canvas cannot come to disagree about
 * what it says.
 *
 * It reads rather than streams, so it holds none of the space's live slots and
 * costs nothing while it sits there. It also never revises: revising is the
 * workspace tab's, and a card that could do it would be reaching past what it
 * was pinned to.
 */
export function ZenCanvasCard(props: ZenCanvasCardProps) {
  const [definition, setDefinition] = useState<CanvasDefinition>();
  const [notice, setNotice] = useState<string>();
  const [reading, setReading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const client = props.client;
  const canvasId = props.canvasId;

  useEffect(() => {
    let active = true;
    setReading(true);
    void client
      .get(canvasId)
      .then((outcome) => {
        if (!active) return;
        // Which of the refusals applied is the host's to tell the Canvas
        // surface, not this card's to repeat about a document it was only
        // pinned to name.
        if (outcome.kind !== "ready") {
          setNotice("This canvas is unavailable.");
          return;
        }
        setDefinition(outcome.version.definition);
        setNotice(undefined);
      })
      .catch(() => {
        if (active) setNotice("This canvas is unavailable.");
      })
      .finally(() => {
        if (active) setReading(false);
      });
    return () => void (active = false);
  }, [attempt, canvasId, client]);

  if (definition === undefined) {
    return (
      <p className="zen-canvas-card__notice" role="status">
        {notice ?? "Reading this canvas…"}
      </p>
    );
  }

  return (
    <div className="zen-canvas-card">
      <div className="zen-canvas-card__chrome">
        <button
          aria-label="Re-read this canvas"
          className="zen-canvas-card__refresh"
          disabled={reading}
          onClick={() => setAttempt((previous) => previous + 1)}
          type="button"
        >
          <RotateCw aria-hidden="true" size={12} />
        </button>
        {notice === undefined ? null : (
          // The last good reading stays on screen; saying it is old is more
          // use than replacing a document with an error.
          <span className="zen-canvas-card__stale" role="status">
            {notice} This is the last reading.
          </span>
        )}
      </div>
      <div className="zen-canvas-card__document">
        <CanvasDocument definition={definition} />
      </div>
    </div>
  );
}
