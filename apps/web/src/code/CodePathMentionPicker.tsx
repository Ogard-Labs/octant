import type { CodeFileListingClient } from "@octant/client-runtime";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import { reconcileFileMentionPaths } from "@octant/domain";
import { File, Folder } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  applyPathMention,
  rankPathMentionCandidates,
  readPathMentionQuery,
  type PathMentionCandidate,
  type PathMentionQuery,
} from "./pathMentions";
import { useCodeFileListingController } from "./useCodeFileListingController";

export interface CodePathMentionsOptions {
  readonly client?: CodeFileListingClient;
  readonly threadId?: CodeThreadId | undefined;
  readonly checkoutId?: CodeCheckoutId | undefined;
  readonly draft: string;
  readonly onDraftChange: (draft: string, caretIndex: number) => void;
  /** The live textarea, so the caret lands after the inserted path. */
  readonly textarea: () => HTMLTextAreaElement | null;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

export interface CodePathMentionsController {
  readonly open: boolean;
  readonly busy: boolean;
  readonly activeIndex: number;
  readonly candidates: ReadonlyArray<PathMentionCandidate>;
  readonly activeCandidate: PathMentionCandidate | undefined;
  /** Paths chosen for this turn; the host re-checks each one at send. */
  readonly selectedPaths: ReadonlyArray<string>;
  readonly setActiveIndex: (index: number) => void;
  /** Recompute the token after every edit or caret move. */
  readonly sync: (draft: string, caretIndex: number | null) => void;
  /** Returns `true` when the typeahead consumed the key. */
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly choose: (candidate: PathMentionCandidate) => void;
  /** Restore paths carried by a refused message. */
  readonly restore: (paths: ReadonlyArray<string>) => void;
  readonly clear: () => void;
}

/**
 * `@path` typeahead for the Code composer.
 *
 * The checkout is only listed once the user actually opens a mention: a file
 * tree is not a live observation, and walking one on every thread open would
 * scan the repository for a picker nobody asked for. Every offered path comes
 * from the host's own confined listing for this checkout, so the picker names
 * files the thread is already bound to and grants nothing by naming them.
 */
export function useCodePathMentions(options: CodePathMentionsOptions): CodePathMentionsController {
  const [mention, setMention] = useState<PathMentionQuery | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlyArray<string>>([]);
  // Latched rather than tracking `mention`, so closing and reopening the
  // typeahead reads the listing already loaded instead of walking again.
  const [requested, setRequested] = useState(false);

  const listing = useCodeFileListingController({
    ...(options.client === undefined ? {} : { client: options.client }),
    threadId: options.threadId,
    checkoutId: options.checkoutId,
    enabled: requested && options.threadId !== undefined && options.checkoutId !== undefined,
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.windowCapability === undefined
      ? {}
      : { windowCapability: options.windowCapability }),
  });

  const paths = useMemo(
    (): ReadonlyArray<PathMentionCandidate> =>
      listing.entries.map((entry) => ({
        kind: entry.kind === "directory" ? "directory" : "file",
        path: String(entry.path),
      })),
    [listing.entries],
  );
  const candidates = useMemo(
    () => (mention === undefined ? [] : rankPathMentionCandidates(paths, mention.query)),
    [mention, paths],
  );

  const open = mention !== undefined;
  const activeCandidate = open ? candidates[activeIndex] : undefined;

  useEffect(() => {
    setSelectedPaths((current) => {
      const kept = reconcileFileMentionPaths(options.draft, current);
      return kept.length === current.length ? current : kept;
    });
  }, [options.draft]);

  function sync(draft: string, caretIndex: number | null) {
    const next = caretIndex === null ? undefined : readPathMentionQuery(draft, caretIndex);
    if (next !== undefined) setRequested(true);
    setMention(next);
    setActiveIndex(0);
  }

  function choose(candidate: PathMentionCandidate) {
    if (mention === undefined) return;
    const applied = applyPathMention(options.draft, mention, candidate);
    options.onDraftChange(applied.draft, applied.caret);
    if (candidate.kind === "file") {
      setSelectedPaths((current) =>
        current.includes(candidate.path) ? current : [...current, candidate.path],
      );
    }
    // A directory keeps the typeahead open on its own contents; a file is done.
    setMention(
      candidate.kind === "directory"
        ? { start: mention.start, query: `${candidate.path}/` }
        : undefined,
    );
    setActiveIndex(0);
    queueMicrotask(() => {
      const element = options.textarea();
      if (element === null) return;
      element.focus();
      element.setSelectionRange(applied.caret, applied.caret);
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
      setMention(undefined);
      return true;
    }
    return false;
  }

  return {
    open,
    busy: listing.status === "loading",
    activeIndex,
    candidates,
    activeCandidate,
    selectedPaths,
    setActiveIndex,
    sync,
    handleKeyDown,
    choose,
    restore: (paths) =>
      setSelectedPaths((current) => [
        ...paths.filter((path) => !current.includes(path)),
        ...current,
      ]),
    clear: () => setSelectedPaths([]),
  };
}

/**
 * The `@` hit list. Rows are paths the host's confined listing already
 * returned for this checkout, so the list adds no reach of its own.
 */
export function PathMentionTypeahead(props: {
  readonly listId: string;
  readonly candidates: ReadonlyArray<PathMentionCandidate>;
  readonly activeIndex: number;
  readonly busy?: boolean;
  readonly onHover: (index: number) => void;
  readonly onChoose: (candidate: PathMentionCandidate) => void;
}) {
  return (
    <div className="thread-mention__typeahead">
      {props.candidates.length === 0 ? (
        <p className="thread-mention__empty" role="status">
          {props.busy === true
            ? "Reading the files in this checkout…"
            : "No matching file in this checkout. Leaving this as ordinary text."}
        </p>
      ) : (
        <ul
          aria-label="Files you can mention"
          className="thread-mention__list"
          id={props.listId}
          role="listbox"
        >
          {props.candidates.map((candidate, index) => (
            <li className="thread-mention__option" key={candidate.path} role="presentation">
              <OctantButton
                aria-selected={index === props.activeIndex}
                id={`${props.listId}-${candidate.path}`}
                onClick={() => props.onChoose(candidate)}
                onMouseEnter={() => props.onHover(index)}
                role="option"
                size="sm"
                type="button"
                variant={index === props.activeIndex ? "secondary" : "ghost"}
              >
                {candidate.kind === "directory" ? (
                  <Folder aria-hidden="true" size={12} strokeWidth={1.8} />
                ) : (
                  <File aria-hidden="true" size={12} strokeWidth={1.8} />
                )}
                <span>{candidate.path}</span>
                <span className="thread-mention__meta">
                  {candidate.kind === "directory" ? "Folder" : "File"}
                </span>
              </OctantButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
