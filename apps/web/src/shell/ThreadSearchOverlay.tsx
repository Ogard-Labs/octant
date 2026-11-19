import "../styles/thread-search.css";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Archive,
  FolderPlus,
  MessageSquare,
  Search,
  Settings,
  SquarePen,
  TriangleAlert,
} from "../ui/icons";
import { WorkerMark } from "../projects/coordinatorMarks";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { SidebarActivityMode } from "./activityViewModel";
import {
  buildThreadSearchResults,
  flattenThreadSearchHits,
  type ThreadSearchContentHit,
  type ThreadSearchHit,
  type ThreadSearchMatchRange,
  type ThreadSearchProject,
  type ThreadSearchScope,
  type ThreadSearchUnfiledLabel,
  type ThreadSearchThread,
} from "./threadSearchViewModel";

export type ThreadSearchListingStatus = "ready" | "loading" | "unavailable";

export interface ThreadSearchOverlayProps {
  readonly mode: SidebarActivityMode;
  /** Every current-mode thread the host already listed for this window, live and archived. */
  readonly threads: ReadonlyArray<ThreadSearchThread>;
  readonly projects: ReadonlyArray<ThreadSearchProject>;
  readonly unfiledLabel?: ThreadSearchUnfiledLabel;
  readonly listing?: ThreadSearchListingStatus;
  /**
   * State of the archived half of `threads` when the host lists it separately
   * from the live half, so a pending or refused archived listing is never
   * printed as an empty Archived group.
   */
  readonly archivedListing?: ThreadSearchListingStatus;
  /** The host's hits (titles, messages, and tool text) in the modes `scope` names. */
  readonly contentHits?: ReadonlyArray<ThreadSearchContentHit>;
  /**
   * The modes searched: every mode, or one. With `onScopeChange` the overlay
   * shows an All / Chat / Work / Code filter; without it, it searches `mode`.
   */
  readonly scope?: ThreadSearchScope;
  readonly onScopeChange?: (scope: ThreadSearchScope) => void;
  readonly contentListing?: ThreadSearchListingStatus;
  readonly contentTruncated?: boolean;
  /** Reports the typed query so the host can list its archived and content matches. */
  readonly onQueryChange?: (query: string) => void;
  /** The query the overlay opens with, so a search handed over from the sidebar filter is not shown empty. */
  readonly initialQuery?: string;
  readonly onClose: () => void;
  readonly onNewThread?: () => void;
  readonly onNewProject?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onOpenThread: (hit: ThreadSearchHit) => void;
}

const MODE_LABEL: Record<SidebarActivityMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

const SCOPES: ReadonlyArray<ThreadSearchScope> = ["all", "chat", "work", "code"];

const SCOPE_LABEL: Record<ThreadSearchScope, string> = { all: "All", ...MODE_LABEL };

const LISTING_COPY: Record<Exclude<ThreadSearchListingStatus, "ready">, string> = {
  loading: "Threads are still loading, so these results may be incomplete.",
  unavailable: "The host thread list is unavailable, so Search has nothing to match.",
};

const ARCHIVED_LISTING_COPY: Record<Exclude<ThreadSearchListingStatus, "ready">, string> = {
  loading: "Archived threads are still loading, so the Archived group may be incomplete.",
  unavailable: "Archived threads are unavailable, so no Archived group can be shown.",
};

const CONTENT_LISTING_COPY: Record<Exclude<ThreadSearchListingStatus, "ready">, string> = {
  loading: "Message search is still loading, so body matches may be incomplete.",
  unavailable: "Message search is unavailable, so only this mode's thread titles are matched.",
};

const RESULTS_ID = "thread-search-results";

function optionId(index: number): string {
  return `thread-search-option-${index}`;
}

/**
 * The thread Search overlay, across every mode or in one.
 *
 * Title matches use only the threads the host already listed for this window.
 * The host's search adds rows from every mode the scope names, each with its
 * snippet and the turn holding the match. Project, `Recents`, and `Unfiled` are printed as
 * folder words on a row, never as filters.
 */
export function ThreadSearchOverlay(props: ThreadSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(props.initialQuery ?? "");
  const [activeIndex, setActiveIndex] = useState(0);

  const listing = props.listing ?? "ready";
  const archivedListing = props.archivedListing ?? "ready";
  const contentListing = props.contentListing ?? "ready";
  const scope: ThreadSearchScope =
    props.onScopeChange === undefined ? props.mode : (props.scope ?? "all");
  const modeLabel = scope === "all" ? "all" : MODE_LABEL[scope];
  const results = buildThreadSearchResults({
    mode: props.mode,
    scope,
    query,
    threads: props.threads,
    projects: props.projects,
    ...(props.unfiledLabel === undefined ? {} : { unfiledLabel: props.unfiledLabel }),
    ...(props.contentHits === undefined ? {} : { contentHits: props.contentHits }),
    ...(props.contentTruncated === undefined ? {} : { contentTruncated: props.contentTruncated }),
  });
  const hits = flattenThreadSearchHits(results);
  const active = hits.length === 0 ? -1 : Math.min(activeIndex, hits.length - 1);
  const hasQuery = query.trim() !== "";
  // A pending or refused archived/content listing must never read as "no matches":
  // that would claim the incomplete half of Search is empty.
  const statusMessage = !hasQuery
    ? ""
    : hits.length === 0
      ? listing === "loading" || archivedListing === "loading" || contentListing === "loading"
        ? "No matching threads yet; more results are still loading."
        : listing === "unavailable"
          ? archivedListing === "unavailable" && contentListing === "unavailable"
            ? "No matching threads; the host thread list, archived threads, and message search are unavailable."
            : archivedListing === "unavailable"
              ? "No matching threads; the host thread list and archived threads are unavailable."
              : contentListing === "unavailable"
                ? "No matching threads; the host thread list and message search are unavailable."
                : "No matching threads; the host thread list is unavailable."
          : archivedListing === "unavailable" && contentListing === "unavailable"
            ? "No matching live threads; archived and message search are unavailable."
            : archivedListing === "unavailable"
              ? "No matching live threads; archived threads are unavailable."
              : contentListing === "unavailable"
                ? "No matching threads; message search is unavailable."
                : "No matching threads."
      : `${hits.length} matching thread${hits.length === 1 ? "" : "s"}.${
          results.truncated ? " Showing the most recent matches." : ""
        }`;
  const placeholder = "Search titles, messages, Canvas, and tool output";

  function open(hit: ThreadSearchHit | undefined): void {
    if (hit === undefined) return;
    props.onOpenThread(hit);
  }

  function runQuickAction(action: (() => void) | undefined): void {
    if (action === undefined) return;
    props.onClose();
    action();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (hits.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex(active + 1 >= hits.length ? 0 : active + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(active <= 0 ? hits.length - 1 : active - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(hits.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      open(hits[active]);
    }
  }

  let flatIndex = -1;
  return (
    <OctantDialog
      className="thread-search"
      initialFocus={inputRef}
      label={scope === "all" ? "Search threads" : `Search ${modeLabel} threads`}
      onClose={props.onClose}
      open
      popupId="thread-search-dialog"
    >
      <div className="thread-search__field">
        <Search aria-hidden="true" size={14} />
        <OctantInput
          {...(active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
          aria-controls={RESULTS_ID}
          aria-expanded={hits.length > 0}
          aria-label={scope === "all" ? "Search threads" : `Search ${modeLabel} threads`}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            props.onQueryChange?.(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>
      {props.onScopeChange === undefined ? null : (
        <OctantToggleGroup<ThreadSearchScope>
          aria-label="Modes to search"
          className="thread-search__modes"
          onValueChange={(value) => {
            const next = value[0];
            if (next === undefined) return;
            setActiveIndex(0);
            props.onScopeChange?.(next);
          }}
          value={[scope]}
        >
          {SCOPES.map((candidate) => (
            <OctantToggleGroupItem key={candidate} value={candidate}>
              {SCOPE_LABEL[candidate]}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
      )}
      {listing === "ready" ? null : (
        <p className="thread-search__listing" data-listing={listing} role="note">
          <TriangleAlert aria-hidden="true" size={14} />
          <span>{LISTING_COPY[listing]}</span>
        </p>
      )}
      {hasQuery && archivedListing !== "ready" ? (
        <p className="thread-search__listing" data-listing={archivedListing} role="note">
          <Archive aria-hidden="true" size={14} />
          <span>{ARCHIVED_LISTING_COPY[archivedListing]}</span>
        </p>
      ) : null}
      {hasQuery && contentListing !== "ready" ? (
        <p className="thread-search__listing" data-listing={contentListing} role="note">
          <MessageSquare aria-hidden="true" size={14} />
          <span>{CONTENT_LISTING_COPY[contentListing]}</span>
        </p>
      ) : null}
      <p
        aria-atomic="true"
        aria-live="polite"
        className={`thread-search__status${statusMessage === "" ? " sr-only" : ""}`}
        role="status"
      >
        {statusMessage}
      </p>
      <div
        aria-label={scope === "all" ? "Thread results" : `${modeLabel} thread results`}
        className="thread-search__results"
        id={RESULTS_ID}
        role="listbox"
      >
        {results.groups.map((group) => (
          <div
            aria-label={group.label}
            className="thread-search__group"
            key={group.id}
            role="group"
          >
            <p aria-hidden="true" className="thread-search__group-label">
              {group.label}
            </p>
            {group.hits.map((hit) => {
              flatIndex += 1;
              const index = flatIndex;
              return (
                <div
                  aria-selected={index === active}
                  className="thread-search__result"
                  data-active={index === active}
                  data-archived={hit.archived}
                  data-content={hit.snippet !== undefined}
                  id={optionId(index)}
                  key={`${hit.mode}:${hit.threadId}:${hit.turnId ?? hit.canvasId ?? "title"}`}
                  onClick={() => open(hit)}
                  onMouseMove={() => setActiveIndex(index)}
                  role="option"
                >
                  {hit.archived ? (
                    <Archive aria-hidden="true" size={14} />
                  ) : hit.workerOf !== undefined ? (
                    <WorkerMark coordinatorName={hit.workerOf} size={14} />
                  ) : (
                    <MessageSquare aria-hidden="true" size={14} />
                  )}
                  <span className="thread-search__result-main">
                    <span className="thread-search__result-title">{hit.title}</span>
                    {hit.snippet === undefined ? null : (
                      <span className="thread-search__result-snippet">
                        {renderHighlightedSnippet(hit.snippet, hit.matchRanges)}
                      </span>
                    )}
                  </span>
                  {hit.field === "tool" || hit.field === "canvas" ? (
                    <span className="thread-search__result-state">
                      {hit.field === "tool" ? "Tool output" : "Canvas"}
                    </span>
                  ) : null}
                  {scope === "all" ? (
                    <span className="thread-search__result-state">{MODE_LABEL[hit.mode]}</span>
                  ) : null}
                  <span className="thread-search__result-label">{hit.folderLabel}</span>
                  {hit.archived ? (
                    <span className="thread-search__result-state">Archived</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {props.onNewThread === undefined &&
      props.onNewProject === undefined &&
      props.onOpenSettings === undefined ? null : (
        <div aria-label="Quick actions" className="thread-search__quick-actions" role="group">
          <p className="thread-search__group-label">Quick actions</p>
          {props.onNewThread === undefined ? null : (
            <OctantButton
              className="thread-search__quick-action justify-start"
              onClick={() => runQuickAction(props.onNewThread)}
              type="button"
              variant="ghost"
            >
              <SquarePen aria-hidden="true" size={14} />
              <span>{props.mode === "chat" ? "New chat" : "New task"}</span>
            </OctantButton>
          )}
          {props.onNewProject === undefined ? null : (
            <OctantButton
              className="thread-search__quick-action justify-start"
              onClick={() => runQuickAction(props.onNewProject)}
              type="button"
              variant="ghost"
            >
              <FolderPlus aria-hidden="true" size={14} />
              <span>New Project</span>
            </OctantButton>
          )}
          {props.onOpenSettings === undefined ? null : (
            <OctantButton
              className="thread-search__quick-action justify-start"
              onClick={() => runQuickAction(props.onOpenSettings)}
              type="button"
              variant="ghost"
            >
              <Settings aria-hidden="true" size={14} />
              <span>Settings</span>
            </OctantButton>
          )}
        </div>
      )}
      <p className="thread-search__scope" role="note">
        {scope === "all"
          ? "Searches titles, messages, attachment names, Canvas, and tool output in Chat, Work, and Code, archived threads included. Every word must appear; quote a phrase to match it exactly."
          : `Searches ${modeLabel} titles, messages, attachment names, Canvas, and tool output, archived threads included. Every word must appear; quote a phrase to match it exactly.`}
      </p>
    </OctantDialog>
  );
}

function renderHighlightedSnippet(
  snippet: string,
  ranges: ReadonlyArray<ThreadSearchMatchRange> | undefined,
): ReactNode {
  if (ranges === undefined || ranges.length === 0) return snippet;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, range] of ranges.entries()) {
    if (range.start < cursor || range.end > snippet.length || range.end <= range.start) continue;
    if (range.start > cursor) {
      parts.push(snippet.slice(cursor, range.start));
    }
    parts.push(
      <mark className="thread-search__result-mark" key={`mark-${index}`}>
        {snippet.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor));
  return parts.length === 0 ? snippet : parts;
}
