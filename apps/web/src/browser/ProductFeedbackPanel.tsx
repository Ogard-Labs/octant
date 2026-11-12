import type {
  ProductFeedbackNote,
  ProductFeedbackPreview,
} from "@octant/contracts/product-feedback";
import { MessageSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ProductFeedbackEvidence } from "./ProductFeedbackEvidence";

export interface ProductFeedbackPanelProps {
  readonly pending: ReadonlyArray<ProductFeedbackNote>;
  readonly crops: Readonly<Record<string, string>>;
  readonly preview: ProductFeedbackPreview | undefined;
  readonly previewExpired: boolean;
  readonly pointing: boolean;
  readonly busy: boolean;
  readonly message?: string;
  readonly selectionUnavailable?: string;
  readonly onTogglePointing: () => void;
  readonly onSubmit: (comment: string) => Promise<boolean>;
  readonly onCancel: () => void;
  readonly onDiscard: (note: ProductFeedbackNote) => void;
  readonly onUpdate: (
    note: ProductFeedbackNote,
    change: { readonly comment?: string; readonly included?: boolean },
  ) => Promise<boolean>;
  readonly onRefresh: () => void;
}

export function ProductFeedbackPanel(props: ProductFeedbackPanelProps) {
  const [comment, setComment] = useState("");
  const panel = useRef<HTMLElement | null>(null);
  const [pointingHeight, setPointingHeight] = useState<number>();
  useEffect(() => {
    if (!props.pointing) setPointingHeight(undefined);
  }, [props.pointing]);
  const included = props.pending.filter((note) => note.included !== false).length;
  const expired =
    props.previewExpired ||
    (props.preview !== undefined && Date.now() >= Date.parse(props.preview.expiresAt));
  return (
    <section
      aria-label="Notes on this page"
      className="product-feedback"
      ref={panel}
      style={
        props.pointing && pointingHeight !== undefined ? { height: pointingHeight } : undefined
      }
    >
      <header className="product-feedback__header">
        <OctantButton
          aria-pressed={props.pointing}
          disabled={props.busy || (props.selectionUnavailable !== undefined && !props.pointing)}
          onClick={() => {
            // Selection labels/controls must not move a separate native view
            // between its arming gesture and the person's selected point.
            const height = panel.current?.getBoundingClientRect().height;
            if (!props.pointing && height !== undefined && height > 0) setPointingHeight(height);
            props.onTogglePointing();
          }}
          size="sm"
          type="button"
          variant={props.pointing ? "secondary" : "ghost"}
        >
          <MessageSquare aria-hidden="true" size={12} />
          {props.pointing
            ? "Cancel pointing"
            : props.preview === undefined
              ? "Point at something"
              : "Choose another element"}
        </OctantButton>
        <OctantButton
          disabled={props.busy || props.pointing}
          onClick={props.onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          Refresh notes
        </OctantButton>
        {props.pending.length === 0 ? null : (
          <span className="product-feedback__count">
            {included === 1 && props.pending.length === 1
              ? "1 note goes with your next message"
              : `${included} of ${props.pending.length} notes included with your next message`}
          </span>
        )}
      </header>
      {props.pointing ? (
        <p role="status">Tap the thing you mean. Pointing will not click it or send a message.</p>
      ) : null}
      {props.selectionUnavailable === undefined ? null : <p>{props.selectionUnavailable}</p>}
      {props.preview === undefined ? null : (
        <section aria-label="Element preview" className="product-feedback__composer">
          <ProductFeedbackEvidence
            element={props.preview.element}
            capturedAt={props.preview.capturedAt}
            {...(props.preview.cropDataUrl === undefined
              ? {}
              : { cropDataUrl: props.preview.cropDataUrl })}
          />
          {expired ? (
            <p>This preview expired. Your comment is kept; choose the element again.</p>
          ) : null}
          <OctantTextarea
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
              disabled={props.busy || props.pointing || expired || comment.trim().length === 0}
              onClick={() => {
                const submitted = comment;
                void props.onSubmit(submitted.trim()).then((saved) => {
                  if (saved) setComment((latest) => (latest === submitted ? "" : latest));
                });
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
              Cancel note
            </OctantButton>
          </div>
        </section>
      )}
      {props.message === undefined ? null : (
        <p className="product-feedback__message" role="status">
          {props.message}
        </p>
      )}
      {props.pending.length === 0 ? null : (
        <ul className="product-feedback__list">
          {props.pending.map((note) => (
            <PendingNote
              key={String(note.id)}
              note={note}
              busy={props.busy || props.pointing}
              {...(props.crops[String(note.id)] === undefined
                ? {}
                : { cropDataUrl: props.crops[String(note.id)] })}
              onUpdate={props.onUpdate}
              onDiscard={props.onDiscard}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PendingNote(props: {
  readonly note: ProductFeedbackNote;
  readonly cropDataUrl?: string;
  readonly busy: boolean;
  readonly onUpdate: ProductFeedbackPanelProps["onUpdate"];
  readonly onDiscard: ProductFeedbackPanelProps["onDiscard"];
}) {
  const note = props.note;
  const label =
    note.element.kind === "browser-element"
      ? (note.element.accessibleName ?? note.element.selector)
      : (note.element.label ?? note.element.identifier);
  const [edit, setEdit] = useState({
    base: note.comment,
    text: note.comment,
    changedElsewhere: false,
  });
  useEffect(
    () =>
      setEdit((previous) =>
        previous.text === previous.base || previous.text === note.comment
          ? { base: note.comment, text: note.comment, changedElsewhere: false }
          : {
              ...previous,
              base: note.comment,
              changedElsewhere: previous.changedElsewhere || previous.base !== note.comment,
            },
      ),
    [note.comment],
  );
  return (
    <li className="product-feedback__note">
      <h3 className="product-feedback__note-heading">{label}</h3>
      <label className="product-feedback__selection">
        <OctantCheckbox
          aria-label={`Include note: ${note.comment}`}
          checked={note.included !== false}
          disabled={props.busy}
          onChange={(event) => void props.onUpdate(note, { included: event.currentTarget.checked })}
        />
        Include with next message
      </label>
      <OctantTextarea
        aria-label={`Edit note: ${note.comment}`}
        className="product-feedback__input"
        maxLength={2000}
        rows={2}
        value={edit.text}
        onChange={(event) => setEdit((previous) => ({ ...previous, text: event.target.value }))}
      />
      {edit.changedElsewhere ? <p>Saved comment changed elsewhere. Your edit is kept.</p> : null}
      <div className="product-feedback__composer-actions">
        <OctantButton
          disabled={props.busy || edit.text.trim().length === 0 || edit.text === note.comment}
          onClick={() => {
            const submitted = edit.text;
            void props.onUpdate(note, { comment: submitted.trim() }).then((saved) => {
              if (saved)
                setEdit((latest) =>
                  latest.text === submitted
                    ? { base: submitted.trim(), text: submitted.trim(), changedElsewhere: false }
                    : { ...latest, base: submitted.trim() },
                );
            });
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Save comment
        </OctantButton>
        <OctantButton
          aria-label={`Remove note: ${note.comment}`}
          disabled={props.busy}
          onClick={() => props.onDiscard(note)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={12} /> Remove note
        </OctantButton>
      </div>
      <details>
        <summary>Inspect captured evidence</summary>
        <ProductFeedbackEvidence
          element={note.element}
          capturedAt={note.capturedAt}
          {...(props.cropDataUrl === undefined ? {} : { cropDataUrl: props.cropDataUrl })}
        />
      </details>
    </li>
  );
}
