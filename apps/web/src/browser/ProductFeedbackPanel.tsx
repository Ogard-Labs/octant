import type { ProductFeedbackNote } from "@octant/contracts/product-feedback";
import { MessageSquare, X } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ProductFeedbackPanelProps {
  readonly pending: ReadonlyArray<ProductFeedbackNote>;
  readonly pointing: boolean;
  readonly busy: boolean;
  readonly message?: string;
  /** Set while the user has tapped a spot and is writing about it. */
  readonly pendingPoint?: { readonly x: number; readonly y: number };
  readonly onTogglePointing: () => void;
  readonly onSubmit: (comment: string) => void;
  readonly onCancel: () => void;
  readonly onDiscard: (note: ProductFeedbackNote) => void;
}

/**
 * Point at the page and say what is wrong with it.
 *
 * The panel says plainly what a note is: it travels with the next message, and
 * it is a description of what the user saw, not a second way to instruct the
 * agent. Nothing here names the element — the host does that when the note is
 * captured, and the note that comes back is what the list shows.
 */
export function ProductFeedbackPanel(props: ProductFeedbackPanelProps) {
  const [comment, setComment] = useState("");

  return (
    <section aria-label="Notes on this page" className="product-feedback">
      <header className="product-feedback__header">
        <OctantButton
          aria-pressed={props.pointing}
          disabled={props.busy}
          onClick={props.onTogglePointing}
          size="sm"
          type="button"
          variant={props.pointing ? "secondary" : "ghost"}
        >
          <MessageSquare aria-hidden="true" size={12} strokeWidth={1.8} />
          {props.pointing ? "Tap the thing you mean" : "Point at something"}
        </OctantButton>
        {props.pending.length === 0 ? null : (
          <span className="product-feedback__count">
            {props.pending.length === 1
              ? "1 note goes with your next message"
              : `${String(props.pending.length)} notes go with your next message`}
          </span>
        )}
      </header>

      {props.pendingPoint === undefined ? null : (
        <div className="product-feedback__composer">
          <textarea
            aria-label="What is wrong with this?"
            className="product-feedback__input"
            maxLength={2000}
            onChange={(event) => setComment(event.target.value)}
            placeholder="What is wrong with this?"
            rows={2}
            value={comment}
          />
          <div className="product-feedback__composer-actions">
            <OctantButton
              disabled={props.busy || comment.trim().length === 0}
              onClick={() => {
                props.onSubmit(comment.trim());
                setComment("");
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Leave the note
            </OctantButton>
            <OctantButton
              disabled={props.busy}
              onClick={() => {
                props.onCancel();
                setComment("");
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </OctantButton>
          </div>
        </div>
      )}

      {props.message === undefined ? null : (
        <p className="product-feedback__message" role="status">
          {props.message}
        </p>
      )}

      {props.pending.length === 0 ? null : (
        <ul className="product-feedback__list">
          {props.pending.map((note) => (
            <li className="product-feedback__note" key={String(note.id)}>
              <span className="product-feedback__note-comment">{note.comment}</span>
              <span className="product-feedback__note-element">{elementLabel(note)}</span>
              <OctantButton
                aria-label={`Remove note: ${note.comment}`}
                disabled={props.busy}
                onClick={() => props.onDiscard(note)}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X aria-hidden="true" size={12} strokeWidth={1.8} />
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Name the element the way the host recorded it. The accessible name is the
 * one a person would recognise; the selector is the fallback, never a promise
 * of a durable locator.
 */
function elementLabel(note: ProductFeedbackNote): string {
  if (note.element.kind === "browser-element") {
    return note.element.accessibleName ?? note.element.selector;
  }
  return note.element.label ?? note.element.identifier;
}
