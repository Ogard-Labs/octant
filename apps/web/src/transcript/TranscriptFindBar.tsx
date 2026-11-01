import { ChevronDown, ChevronUp, X } from "lucide-react";
import { forwardRef, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface TranscriptFindBarProps {
  readonly query: string;
  readonly count: number;
  /** Zero-based position of the current match. */
  readonly current: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: 1 | -1) => void;
  readonly onClose: () => void;
}

/** The find bar pinned to the top of a transcript. */
export const TranscriptFindBar = forwardRef<HTMLInputElement, TranscriptFindBarProps>(
  function TranscriptFindBar(props, ref) {
    const status =
      props.query === ""
        ? ""
        : props.count === 0
          ? "No matches"
          : `${props.current + 1} of ${props.count}`;
    function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
      if (event.key === "Enter") {
        event.preventDefault();
        props.onStep(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    }
    return (
      <div className="transcript-find" data-transcript-find="" role="search">
        <OctantInput
          aria-label="Find in thread"
          autoComplete="off"
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Find in thread"
          ref={ref}
          spellCheck={false}
          value={props.query}
        />
        <span aria-live="polite" className="transcript-find__status">
          {status}
        </span>
        <OctantButton
          aria-label="Previous match"
          disabled={props.count === 0}
          onClick={() => props.onStep(-1)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronUp size={14} />
        </OctantButton>
        <OctantButton
          aria-label="Next match"
          disabled={props.count === 0}
          onClick={() => props.onStep(1)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <ChevronDown size={14} />
        </OctantButton>
        <OctantButton
          aria-label="Close find"
          onClick={props.onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X size={14} />
        </OctantButton>
      </div>
    );
  },
);
