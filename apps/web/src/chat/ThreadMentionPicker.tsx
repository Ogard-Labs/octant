import type { MentionableThreadId, ThreadMentionCandidate } from "@octant/contracts";
import {
  applyThreadMentionChip,
  parseThreadMentionToken,
  type ThreadMentionToken,
} from "@octant/domain";
import { Hash, MessagesSquare, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * A `#thread` chip a composer is currently carrying. The chip is a structured
 * selection, not text: the server re-resolves `threadId` at send time, so the
 * label shown here is a receipt of what the host said, never a claim the
 * renderer made.
 */
export interface ThreadMentionChip {
  readonly threadId: MentionableThreadId;
  readonly title: string;
  readonly mode: "chat" | "work" | "code";
  readonly placementLabel: string;
  /** Set when the host refused this thread on the last resolve. */
  readonly unavailableReason?: string;
  /** Set when the host already has a Side Chat sidecar for this thread. */
  readonly hasSideChat?: boolean;
}

/**
 * `#` thread-mention wiring. A composer owns only the token under the
 * caret and the keyboard interaction; candidates, chips, and availability all
 * come from the caller, which gets them from the host.
 */
export interface ThreadMentions {
  readonly candidates: ReadonlyArray<ThreadMentionCandidate>;
  readonly chips: ReadonlyArray<ThreadMentionChip>;
  /** Receives the text after `#`, or `undefined` when the typeahead closes. */
  readonly onQueryChange: (query: string | undefined) => void;
  readonly onSelectCandidate: (candidate: ThreadMentionCandidate) => void;
  readonly onRemoveChip: (threadId: MentionableThreadId) => void;
  readonly onOpenSideChat?: (threadId: MentionableThreadId) => void;
  readonly busy?: boolean;
  readonly statusMessage?: string;
}

export interface ThreadMentionTypeaheadController {
  readonly open: boolean;
  readonly activeIndex: number;
  readonly activeCandidate: ThreadMentionCandidate | undefined;
  readonly setActiveIndex: (index: number) => void;
  /** Recompute the token after every edit or caret move. */
  readonly sync: (draft: string, caretIndex: number | null) => void;
  /** Returns `true` when the typeahead consumed the key. */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly choose: (candidate: ThreadMentionCandidate) => void;
}

/**
 * Caret-driven `#` typeahead state for one composer.
 *
 * The draft is caller-owned, so the token is derived on every edit rather than
 * stored: a composer can never believe a typeahead is open over text that
 * changed underneath it. Typing `#` resolves nothing by itself — an unmatched
 * `#text` stays ordinary text — and choosing a hit only writes the chip into
 * the draft and tells the caller, which is the half that talks to the host.
 */
export function useThreadMentionTypeahead(input: {
  readonly mentions: ThreadMentions | undefined;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  /** The live textarea, so the caret lands after an inserted chip. */
  readonly textarea: () => HTMLTextAreaElement | null;
  /** Keeps the typeahead shut while the composer cannot accept a selection. */
  readonly disabled?: boolean;
}): ThreadMentionTypeaheadController {
  const [token, setToken] = useState<ThreadMentionToken | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const mentions = input.mentions;
  const candidates = mentions?.candidates ?? [];
  const open = mentions !== undefined && token !== undefined && input.disabled !== true;
  const activeCandidate = open ? candidates[activeIndex] : undefined;

  function sync(draft: string, caretIndex: number | null) {
    if (mentions === undefined) return;
    const next = caretIndex === null ? undefined : parseThreadMentionToken(draft, caretIndex);
    setToken(next);
    setActiveIndex(0);
    mentions.onQueryChange(next?.query);
  }

  function choose(candidate: ThreadMentionCandidate) {
    if (mentions === undefined || token === undefined) return;
    const applied = applyThreadMentionChip(input.draft, token, candidate.title);
    input.onDraftChange(applied.draft);
    mentions.onSelectCandidate(candidate);
    setToken(undefined);
    setActiveIndex(0);
    mentions.onQueryChange(undefined);
    // Restore the caret after the inserted chip so typing continues inline.
    queueMicrotask(() => {
      const element = input.textarea();
      if (element === null) return;
      element.focus();
      element.setSelectionRange(applied.caretIndex, applied.caretIndex);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (open && candidates.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % candidates.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + candidates.length) % candidates.length);
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeCandidate) {
        event.preventDefault();
        choose(activeCandidate);
        return true;
      }
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setToken(undefined);
      mentions?.onQueryChange(undefined);
      return true;
    }
    return false;
  }

  return { open, activeIndex, activeCandidate, setActiveIndex, sync, handleKeyDown, choose };
}

/**
 * The `#` hit list. Every row is a thread the host already said this principal
 * can Open, so the list adds no authority of its own and shows no disabled
 * rows for threads it refused.
 */
export function ThreadMentionTypeahead(props: {
  readonly listId: string;
  readonly candidates: ReadonlyArray<ThreadMentionCandidate>;
  readonly activeIndex: number;
  readonly busy?: boolean;
  readonly onHover: (index: number) => void;
  readonly onChoose: (candidate: ThreadMentionCandidate) => void;
}) {
  return (
    <div className="thread-mention__typeahead">
      {props.candidates.length === 0 ? (
        <p className="thread-mention__empty" role="status">
          {props.busy === true
            ? "Searching threads you can open…"
            : "No matching thread you can open. Leaving this as ordinary text."}
        </p>
      ) : (
        <ul
          aria-label="Threads you can mention"
          className="thread-mention__list"
          id={props.listId}
          role="listbox"
        >
          {props.candidates.map((candidate, index) => (
            <li
              className="thread-mention__option"
              key={String(candidate.threadId)}
              role="presentation"
            >
              <OctantButton
                aria-selected={index === props.activeIndex}
                id={`${props.listId}-${String(candidate.threadId)}`}
                onClick={() => props.onChoose(candidate)}
                onMouseEnter={() => props.onHover(index)}
                role="option"
                size="sm"
                type="button"
                variant={index === props.activeIndex ? "secondary" : "ghost"}
              >
                <Hash aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{candidate.title}</span>
                <span className="thread-mention__meta">
                  {`${threadModeLabel(candidate.mode)} · ${threadPlacementLabel(candidate.placement)}`}
                </span>
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The chips the current turn will carry. Each chip states, in words, that the
 * mention is read-only, and reports the host's refusal instead of quietly
 * dropping a selection the user still sees in the draft.
 */
export function ThreadMentionChips(props: {
  readonly chips: ReadonlyArray<ThreadMentionChip>;
  readonly disabled?: boolean;
  readonly onRemove: (threadId: MentionableThreadId) => void;
  readonly onOpenSideChat?: (threadId: MentionableThreadId) => void;
}) {
  if (props.chips.length === 0) return null;
  return (
    <ul aria-label="Mentioned threads" className="thread-mention__chips">
      {props.chips.map((chip) => (
        <li className="chip thread-mention__chip" key={String(chip.threadId)}>
          <Hash aria-hidden="true" size={12} strokeWidth={1.8} />
          <span>{chip.title}</span>
          <span className="thread-mention__chip-receipt">
            {chip.unavailableReason === undefined
              ? `${threadModeLabel(chip.mode)} · ${chip.placementLabel} · Read-only`
              : `Unavailable: ${chip.unavailableReason}`}
          </span>
          {props.onOpenSideChat === undefined ? null : (
            <OctantButton
              aria-label={`Open Side Chat about ${chip.title}`}
              disabled={props.disabled === true || chip.unavailableReason !== undefined}
              onClick={() => props.onOpenSideChat?.(chip.threadId)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <MessagesSquare aria-hidden="true" size={12} strokeWidth={1.8} />
              <span>{chip.hasSideChat === true ? "Reopen Side Chat" : "Side Chat"}</span>
            </OctantButton>
          )}
          <button
            aria-label={`Remove ${chip.title} thread mention`}
            className="chip-x window-no-drag"
            disabled={props.disabled === true}
            onClick={() => props.onRemove(chip.threadId)}
            type="button"
          >
            <X aria-hidden="true" size={10} strokeWidth={1.8} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Words, never colour alone, for the mode a mentioned thread belongs to. */
export function threadModeLabel(mode: "chat" | "work" | "code"): string {
  if (mode === "work") return "Work";
  if (mode === "code") return "Code";
  return "Chat";
}

/** Words for where the host says a mentionable thread is filed. */
export function threadPlacementLabel(placement: ThreadMentionCandidate["placement"]): string {
  if (placement.kind === "project") return placement.label;
  return placement.kind === "recents" ? "Recents" : "Unfiled";
}
