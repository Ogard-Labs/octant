import { useRef, useState, type KeyboardEvent } from "react";
import { Archive, MessageSquare, Search, TriangleAlert } from "lucide-react";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import type { SidebarActivityMode } from "./activityViewModel";
import {
  buildThreadSearchResults,
  flattenThreadSearchHits,
  type ThreadSearchHit,
  type ThreadSearchProject,
  type ThreadSearchUnfiledLabel,
  type ThreadSearchThread,
} from "./threadSearchViewModel";

export type ThreadSearchListingStatus = "ready" | "loading" | "unavailable";

export interface ThreadSearchOverlayProps {
  readonly mode: SidebarActivityMode;
  /** Every current-mode thread the host listed for this window, live and archived. */
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
  /** Reports the typed query so the host can list its archived matches. */
  readonly onQueryChange?: (query: string) => void;
  readonly onClose: () => void;
  readonly onOpenThread: (hit: ThreadSearchHit) => void;
}

const MODE_LABEL: Record<SidebarActivityMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

const LISTING_COPY: Record<Exclude<ThreadSearchListingStatus, "ready">, string> = {
  loading: "Threads are still loading, so these results may be incomplete.",
  unavailable: "The host thread list is unavailable, so Search has nothing to match.",
};

const ARCHIVED_LISTING_COPY: Record<Exclude<ThreadSearchListingStatus, "ready">, string> = {
  loading: "Archived threads are still loading, so the Archived group may be incomplete.",
  unavailable: "Archived threads are unavailable, so no Archived group can be shown.",
};

const RESULTS_ID = "thread-search-results";

function optionId(index: number): string {
  return `thread-search-option-${index}`;
}

/**
 * One current-mode thread Search overlay.
 *
 * The overlay matches only the threads the host already listed for this window,
 * so it can never reveal a thread this window is not authorized to see. Project,
 * `Recents`, and `Unfiled` are printed as folder words on a row, never as
 * filters — searching stays scoped to the active mode and nothing else. The
 * combobox keeps focus while Up/Down move an active option, Enter opens it, and
 * Escape dismisses, so the surface is fully keyboard operable; archived rows are
 * marked with an icon *and* the word "Archived" rather than colour alone.
 */
export function ThreadSearchOverlay(props: ThreadSearchOverlayProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const listing = props.listing ?? "ready";
  const archivedListing = props.archivedListing ?? "ready";
  const modeLabel = MODE_LABEL[props.mode];
  const results = buildThreadSearchResults({
    mode: props.mode,
    query,
    threads: props.threads,
    projects: props.projects,
    ...(props.unfiledLabel === undefined ? {} : { unfiledLabel: props.unfiledLabel }),
  });
  const hits = flattenThreadSearchHits(results);
  const active = hits.length === 0 ? -1 : Math.min(activeIndex, hits.length - 1);
  const hasQuery = query.trim() !== "";
  const statusMessage = !hasQuery
    ? ""
    : hits.length === 0
      ? archivedListing === "loading"
        ? "No matching threads yet; archived threads are still loading."
        : archivedListing === "unavailable"
          ? "No matching live threads; archived threads are unavailable."
          : "No matching threads."
      : `${hits.length} matching thread${hits.length === 1 ? "" : "s"}.${
          results.truncated ? " Showing the most recent matches." : ""
        }`;

  function open(hit: ThreadSearchHit | undefined): void {
    if (hit === undefined) return;
    props.onOpenThread(hit);
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
      label={`Search ${modeLabel} threads`}
      onClose={props.onClose}
      open
      popupId="thread-search-dialog"
    >
      <div className="thread-search__field">
        <Search aria-hidden="true" size={14} strokeWidth={1.8} />
        <OctantInput
          {...(active >= 0 ? { "aria-activedescendant": optionId(active) } : {})}
          aria-controls={RESULTS_ID}
          aria-expanded={hits.length > 0}
          aria-label={`Search ${modeLabel} threads`}
          autoComplete="off"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            props.onQueryChange?.(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Search thread titles"
          ref={inputRef}
          role="combobox"
          value={query}
        />
      </div>
      <p className="thread-search__scope" role="note">
        {modeLabel} threads only. Project, Recents, and Unfiled are folder labels.
      </p>
      {listing === "ready" ? null : (
        <p className="thread-search__listing" data-listing={listing} role="note">
          <TriangleAlert aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{LISTING_COPY[listing]}</span>
        </p>
      )}
      {hasQuery && archivedListing !== "ready" ? (
        <p className="thread-search__listing" data-listing={archivedListing} role="note">
          <Archive aria-hidden="true" size={13} strokeWidth={1.8} />
          <span>{ARCHIVED_LISTING_COPY[archivedListing]}</span>
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
        aria-label={`${modeLabel} thread results`}
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
                  id={optionId(index)}
                  key={`${hit.mode}:${hit.threadId}`}
                  onClick={() => open(hit)}
                  onMouseMove={() => setActiveIndex(index)}
                  role="option"
                >
                  {hit.archived ? (
                    <Archive aria-hidden="true" size={13} strokeWidth={1.8} />
                  ) : (
                    <MessageSquare aria-hidden="true" size={13} strokeWidth={1.8} />
                  )}
                  <span className="thread-search__result-title">{hit.title}</span>
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
    </OctantDialog>
  );
}
