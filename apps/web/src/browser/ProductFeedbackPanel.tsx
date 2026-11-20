import "../styles/browser-feedback.css";
import type {
  ProductFeedbackNote,
  ProductFeedbackPreview,
} from "@octant/contracts/product-feedback";
import { X } from "../ui/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { ProductFeedbackEvidence } from "./ProductFeedbackEvidence";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";

export interface ProductFeedbackPanelProps {
  readonly pending: ReadonlyArray<ProductFeedbackNote>;
  readonly crops: Readonly<Record<string, string>>;
  readonly preview: ProductFeedbackPreview | undefined;
  readonly previewExpired: boolean;
  readonly pointing: boolean;
  readonly busy: boolean;
  /** The list of notes is open; the note being written shows either way. */
  readonly listOpen: boolean;
  readonly onSubmit: (comment: string) => Promise<boolean>;
  readonly onCancel: () => void;
  readonly onDiscard: (note: ProductFeedbackNote) => void;
  readonly onUpdate: (
    note: ProductFeedbackNote,
    change: { readonly comment?: string; readonly included?: boolean },
  ) => Promise<boolean>;
}

/**
 * The note being written and the notes already left, above the page's tool
 * band. It is drawn only while it has one of them to show: the tools, the
 * count and what the host says are the band's, at one height, so arming a tool
 * resizes nothing.
 */
export function ProductFeedbackPanel(props: ProductFeedbackPanelProps) {
  const [comment, setComment] = useState("");
  const panel = useRef<HTMLElement | null>(null);
  const [pointingHeight, setPointingHeight] = useState<number>();
  // Nothing here may move a separate native view between the gesture that
  // arms pointing and the point the person then picks: the sheet keeps the
  // height it had when pointing began for as long as pointing lasts.
  useLayoutEffect(() => {
    if (!props.pointing) {
      setPointingHeight(undefined);
      return;
    }
    const height = panel.current?.getBoundingClientRect().height;
    if (height !== undefined && height > 0) setPointingHeight(height);
  }, [props.pointing]);
  const expired =
    props.previewExpired ||
    (props.preview !== undefined && Date.now() >= Date.parse(props.preview.expiresAt));
  const list = props.listOpen && props.pending.length > 0;
  if (props.preview === undefined && !list) return null;
  return (
    <section
      aria-label="Notes on this page"
      className="product-feedback"
      ref={panel}
      style={
        props.pointing && pointingHeight !== undefined ? { height: pointingHeight } : undefined
      }
    >
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
      {!list ? null : (
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
      <OctantCollapsible summary="Inspect captured evidence">
        <ProductFeedbackEvidence
          element={note.element}
          capturedAt={note.capturedAt}
          {...(props.cropDataUrl === undefined ? {} : { cropDataUrl: props.cropDataUrl })}
        />
      </OctantCollapsible>
    </li>
  );
}
