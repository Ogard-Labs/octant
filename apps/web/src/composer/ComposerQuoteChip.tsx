import { useId, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { NotebookPen, Quote } from "../ui/icons";
import { quotePreview, type ComposerQuote } from "./composerQuote";
import "./composer-chip.css";

export interface ComposerQuoteChipProps {
  readonly quote: ComposerQuote;
  readonly editable: boolean;
  readonly onChange: (next: ComposerQuote) => void;
  readonly onRemove: () => void;
}

/**
 * A quote in the prompt. Pressing it shows the whole quote, where the person
 * writes or changes their note on it, or takes the quote out.
 */
export function ComposerQuoteChip(props: ComposerQuoteChipProps) {
  const { quote } = props;
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(quote.comment);
  const noteId = useId();
  const preview = quotePreview(quote.text);
  const label = [
    `Quote from ${quote.source}: ${preview}`,
    ...(quote.comment === "" ? [] : [`Your note: ${quote.comment}`]),
  ].join(". ");

  return (
    <OctantPopover
      className="composer-quote-card"
      onOpenChange={(next) => {
        if (next) setNote(quote.comment);
        setOpen(next);
      }}
      open={open}
      side="top"
      sideOffset={8}
      title="Quote"
      trigger={
        <>
          <Quote aria-hidden="true" size={12} />
          <span className="composer-chip__text">{preview}</span>
          {quote.comment === "" ? null : <NotebookPen aria-hidden="true" size={12} />}
        </>
      }
      triggerClassName="composer-chip__button"
      triggerLabel={label}
    >
      <p className="composer-quote-card__source">From {quote.source}</p>
      <pre className="composer-quote-card__text">{quote.text}</pre>
      <label className="composer-quote-card__label" htmlFor={noteId}>
        Your note
      </label>
      <OctantTextarea
        disabled={!props.editable}
        id={noteId}
        onChange={(event) => setNote(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          props.onChange({ ...quote, comment: note });
          setOpen(false);
        }}
        placeholder="What you want the agent to see in it"
        rows={2}
        value={note}
      />
      <div className="composer-quote-card__actions">
        <OctantButton
          disabled={!props.editable}
          onClick={() => {
            props.onRemove();
            setOpen(false);
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove quote
        </OctantButton>
        <OctantButton
          disabled={!props.editable}
          onClick={() => {
            props.onChange({ ...quote, comment: note });
            setOpen(false);
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Save note
        </OctantButton>
      </div>
    </OctantPopover>
  );
}
