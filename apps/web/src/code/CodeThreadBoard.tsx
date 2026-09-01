import type {
  CodeBoardCard,
  CodeBoardQuery,
  CodeBoardStatus,
  CodeBoardView,
  CodeThreadMetadataRecoveryReason,
  ThreadBoardPullRequestIdentity,
} from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { THREAD_BOARD_STATUS_COLUMN_ORDER } from "@octant/domain/thread-board-policy";
import { ChevronDown, Filter, GitBranch, GitPullRequest, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ShellState } from "../shell/ShellState";
import { Surface, SurfaceEmpty, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  codeBoardStatusLabel,
  codeBoardStatusReasonLabel,
  groupCodeBoardCards,
  type CodeBoardColumn,
  type CodeBoardGrouping,
  type CodeBoardProjectRef,
} from "./codeBoardGrouping";
import { ThreadBoardPullRequestSummaries } from "../threadBoard/ThreadBoardPullRequestSummaries";

const GROUPING_STORAGE_KEY = "octant.code.board.grouping";
const SHOW_EMPTY_GROUPS_STORAGE_KEY = "octant.code.board.show-empty-groups";
const ALL_STATUSES: readonly CodeBoardStatus[] = THREAD_BOARD_STATUS_COLUMN_ORDER;

export interface CodeThreadOpenTarget {
  readonly threadId: CodeThreadId;
  readonly projectId: ProjectId;
}

export interface CodeThreadBoardProps {
  readonly loadBoard: (query: CodeBoardQuery) => Promise<CodeBoardView>;
  /** Code Projects in the user's configured order (for grouping and filters). */
  readonly projects: readonly CodeBoardProjectRef[];
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  readonly onClose?: () => void;
  readonly initialGrouping?: CodeBoardGrouping;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  /** Client unread overlay; server cards never carry unread. */
  readonly unreadThreadIds?: ReadonlySet<string>;
  /** Display names for provider instances, keyed by instance id. */
  readonly providerLabels?: ReadonlyMap<string, string>;
  /** Narrow view is a grouped list; wide view is compact columns. */
  readonly isNarrow?: boolean;
}

type BoardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeBoardView }
  | { readonly status: "refreshing"; readonly view: CodeBoardView }
  | { readonly status: "error"; readonly message: string; readonly view?: CodeBoardView };

interface FilterState {
  readonly text: string;
  readonly statuses: ReadonlySet<CodeBoardStatus>;
  readonly projectIds: ReadonlySet<string>;
  readonly followUp: "any" | "only" | "excluded";
  readonly pullRequest: "any" | "linked" | "none" | "open" | "merged" | "closed";
  readonly checks: "any" | "unknown" | "pending" | "passing" | "failing";
}

const DEFAULT_FILTERS: FilterState = {
  text: "",
  statuses: new Set(ALL_STATUSES),
  projectIds: new Set<string>(),
  followUp: "any",
  pullRequest: "any",
  checks: "any",
};

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

export function CodeThreadBoard(props: CodeThreadBoardProps) {
  const storage = props.storage ?? defaultStorage();
  const [grouping, setGrouping] = useState<CodeBoardGrouping>(
    () => props.initialGrouping ?? readStoredGrouping(storage) ?? "status",
  );
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  // Empty lanes are optional detail. The default scan path spends width on
  // work that exists; View can still reveal the complete status workflow.
  const [showEmptyGroups, setShowEmptyGroups] = useState(
    () => readStoredBoolean(storage, SHOW_EMPTY_GROUPS_STORAGE_KEY) ?? false,
  );
  const [board, setBoard] = useState<BoardState>({ status: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  const query = useMemo(() => buildQuery(filters), [filters]);
  const queryKey = JSON.stringify(query);

  // The shell re-renders while threads stream, and its `loadBoard` is an inline
  // arrow, so the prop's identity changes on every one of those renders. Keying
  // the query on that identity dropped the board back to "Loading" each time and
  // it never settled. The callback is held here instead: a fresh function is not
  // a new question about the board.
  const loadBoardRef = useRef(props.loadBoard);
  useEffect(() => {
    loadBoardRef.current = props.loadBoard;
  });

  useEffect(() => {
    let active = true;
    setBoard((previous) => {
      const view = lastUsefulView(previous);
      return view === undefined ? { status: "loading" } : { status: "refreshing", view };
    });
    loadBoardRef.current(query).then(
      (view) => {
        if (active) setBoard({ status: "ready", view });
      },
      (error: unknown) => {
        if (!active) return;
        const message =
          error instanceof Error ? error.message : "The Code Thread Board is unavailable.";
        setBoard((previous) => {
          const view = lastUsefulView(previous);
          return view === undefined
            ? { status: "error", message }
            : { status: "error", message, view };
        });
      },
    );
    return () => {
      active = false;
    };
    // queryKey captures every filter that affects the server result (`query` is
    // recomputed from the same filters, so it moves only when queryKey does).
    // refreshNonce re-queries the same local authoritative state. Grouping is
    // deliberately excluded: switching grouping is a pure client projection.
  }, [queryKey, refreshNonce]);

  function changeGrouping(next: CodeBoardGrouping) {
    setGrouping(next);
    writeStoredGrouping(storage, next);
  }

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of props.projects) map.set(String(project.id), project.name);
    return map;
  }, [props.projects]);

  const activeFilters = activeFilterLabels(filters, projectNames);
  const activeAdvancedFilterCount = activeFilters.filter(
    (filter) => filter.kind !== "search",
  ).length;

  return (
    <Surface ariaLabel="Code Thread Board" className="code-board" measure="wide">
      <SurfaceHeader
        subtitle="One runtime-derived view of your Code threads and coding agents."
        title="Threads"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />

      <div aria-label="Board controls" className="surface-toolbar" role="group">
        <OctantToggleGroup<CodeBoardGrouping>
          aria-label="Group by"
          className="code-board__grouping"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === "status" || selected === "project") changeGrouping(selected);
          }}
          value={[grouping]}
        >
          <OctantToggleGroupItem value="status">Status</OctantToggleGroupItem>
          <OctantToggleGroupItem value="project">Project</OctantToggleGroupItem>
        </OctantToggleGroup>

        <label className="surface-toolbar__search code-board__search">
          <span className="sr-only">Search threads</span>
          <Search aria-hidden="true" size={14} strokeWidth={1.8} />
          <OctantInput
            onChange={(event) => setFilters((prev) => ({ ...prev, text: event.target.value }))}
            placeholder="Search threads"
            type="search"
            value={filters.text}
          />
        </label>

        <div className="code-board__filters">
          <OctantPopover
            className="code-board__filters-panel"
            onOpenChange={setFiltersOpen}
            open={filtersOpen}
            title="Filters"
            trigger={
              <>
                <Filter aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>Filters</span>
                {activeAdvancedFilterCount === 0 ? null : (
                  <span aria-hidden="true" className="code-board__filter-count">
                    {activeAdvancedFilterCount}
                  </span>
                )}
              </>
            }
            triggerClassName="code-board__filters-toggle"
            triggerDataAttributes={{ "data-active": activeAdvancedFilterCount > 0 }}
            triggerLabel={
              activeAdvancedFilterCount === 0
                ? "Filters"
                : `Filters, ${activeAdvancedFilterCount} active`
            }
            triggerVariant="ghost"
          >
            <fieldset className="code-board__status-filter">
              <legend>Status</legend>
              <div className="code-board__status-options">
                {ALL_STATUSES.map((status) => (
                  <label className="code-board__status-option" key={status}>
                    <OctantCheckbox
                      checked={filters.statuses.has(status)}
                      onChange={(event) =>
                        setFilters((prev) => toggleStatus(prev, status, event.target.checked))
                      }
                    />
                    <span>
                      <span aria-hidden="true" className={`st st-${status}`} />
                      {codeBoardStatusLabel(status)}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="code-board__filter-fields">
              {props.projects.length === 0 ? null : (
                <label>
                  <span>Project</span>
                  <OctantSelectField
                    onValueChange={(value) =>
                      setFilters((prev) => ({
                        ...prev,
                        projectIds: value === "" ? new Set<string>() : new Set<string>([value]),
                      }))
                    }
                    options={[
                      { id: "", label: "All Projects" },
                      ...props.projects.map((project) => ({
                        id: String(project.id),
                        label: project.name,
                      })),
                    ]}
                    value={firstOrEmpty(filters.projectIds)}
                  />
                </label>
              )}

              <label>
                <span>Pull request</span>
                <OctantSelectField
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      pullRequest: value as FilterState["pullRequest"],
                    }))
                  }
                  options={[
                    { id: "any", label: "Any" },
                    { id: "linked", label: "Linked" },
                    { id: "none", label: "No PR" },
                    { id: "open", label: "Open" },
                    { id: "merged", label: "Merged" },
                    { id: "closed", label: "Closed" },
                  ]}
                  value={filters.pullRequest}
                />
              </label>

              <label>
                <span>Checks</span>
                <OctantSelectField
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      checks: value as FilterState["checks"],
                    }))
                  }
                  options={[
                    { id: "any", label: "Any" },
                    { id: "passing", label: "Passing" },
                    { id: "failing", label: "Failing" },
                    { id: "pending", label: "Pending" },
                    { id: "unknown", label: "Unknown" },
                  ]}
                  value={filters.checks}
                />
              </label>

              <label>
                <span>Follow-up</span>
                <OctantSelectField
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      followUp: value as FilterState["followUp"],
                    }))
                  }
                  options={[
                    { id: "any", label: "Any" },
                    { id: "only", label: "Only follow-up" },
                    { id: "excluded", label: "Exclude follow-up" },
                  ]}
                  value={filters.followUp}
                />
              </label>
            </div>

            <div className="code-board__filters-footer">
              <OctantButton
                className="code-board__reset-filters"
                disabled={activeAdvancedFilterCount === 0 && filters.text.trim() === ""}
                onClick={() => setFilters(DEFAULT_FILTERS)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Reset filters
              </OctantButton>
            </div>
          </OctantPopover>
        </div>

        <OctantButton
          aria-label={board.status === "refreshing" ? "Refreshing board" : "Refresh board"}
          disabled={board.status === "loading" || board.status === "refreshing"}
          onClick={() => setRefreshNonce((nonce) => nonce + 1)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
          <span>{board.status === "refreshing" ? "Refreshing" : "Refresh"}</span>
        </OctantButton>

        <div className="code-board__view-options">
          <OctantPopover
            className="code-board__view-popover"
            onOpenChange={setViewOpen}
            open={viewOpen}
            title="View"
            trigger={
              <>
                <span>View</span>
                <ChevronDown aria-hidden="true" size={14} strokeWidth={1.8} />
              </>
            }
            triggerClassName="code-board__view-toggle"
            triggerLabel="View"
            triggerVariant="ghost"
          >
            <label>
              <OctantCheckbox
                checked={showEmptyGroups}
                onChange={(event) => {
                  setShowEmptyGroups(event.target.checked);
                  writeStoredBoolean(storage, SHOW_EMPTY_GROUPS_STORAGE_KEY, event.target.checked);
                }}
              />
              <span>Show empty groups</span>
            </label>
          </OctantPopover>
        </div>
      </div>

      {activeFilters.length === 0 ? null : (
        <div aria-label="Active filters" className="code-board__active-filters" role="status">
          {activeFilters.map((filter) => (
            <span
              className={filter.verbatim ? "tag tag-value" : "tag"}
              key={`${filter.kind}:${filter.label}`}
            >
              {filter.label}
            </span>
          ))}
        </div>
      )}

      <CodeBoardBody
        board={board}
        filters={filters}
        grouping={grouping}
        isNarrow={props.isNarrow === true}
        onResetFilters={() => setFilters(DEFAULT_FILTERS)}
        projectNames={projectNames}
        projects={props.projects}
        showEmptyGroups={showEmptyGroups}
        {...(props.providerLabels === undefined ? {} : { providerLabels: props.providerLabels })}
        {...(props.unreadThreadIds === undefined ? {} : { unreadThreadIds: props.unreadThreadIds })}
        {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
        {...(props.onSelectPullRequest === undefined
          ? {}
          : { onSelectPullRequest: props.onSelectPullRequest })}
      />
    </Surface>
  );
}

function CodeBoardBody(props: {
  readonly board: BoardState;
  readonly filters: FilterState;
  readonly grouping: CodeBoardGrouping;
  readonly projects: readonly CodeBoardProjectRef[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly showEmptyGroups: boolean;
  readonly isNarrow: boolean;
  readonly onResetFilters: () => void;
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}) {
  if (props.board.status === "loading") {
    return (
      <div className="code-board__body">
        <ShellState
          eyebrow="Code Thread Board"
          message="Loading the board."
          state="loading"
          title="Loading"
        />
      </div>
    );
  }
  const view = lastUsefulView(props.board);
  if (view === undefined) {
    return (
      <div className="code-board__body">
        <ShellState
          eyebrow="Code Thread Board"
          message={
            props.board.status === "error" ? props.board.message : "The board is unavailable"
          }
          role="alert"
          state="disconnected"
          title="The board is unavailable"
        />
      </div>
    );
  }
  const refreshNotice =
    props.board.status === "refreshing" ? (
      <p className="code-board__note" role="status">
        Refreshing local board state.
      </p>
    ) : props.board.status === "error" ? (
      <p className="code-board__note" role="alert">
        {props.board.message} Showing the last useful view.
      </p>
    ) : null;
  const cards = view.cards;
  const hasActiveFilters = activeFilterLabels(props.filters, props.projectNames).length > 0;
  // An empty board still shows its workflow: every column stays, each saying
  // it has nothing, and one quiet line says why the board is empty.
  const emptyNote =
    cards.length === 0 ? (
      <div className="code-board__note" role="status">
        <span className="oct-row-label">
          {hasActiveFilters ? "No Code threads match these filters" : "No Code threads yet"}
        </span>
        <span>
          {hasActiveFilters
            ? activeFilterSummary(props.filters)
            : "Create a Code thread to see it here."}
        </span>
        {hasActiveFilters ? (
          <OctantButton onClick={props.onResetFilters} size="sm" type="button" variant="ghost">
            Clear filters
          </OctantButton>
        ) : null}
      </div>
    ) : null;
  const columns = groupCodeBoardCards(cards, props.grouping, { projects: props.projects });
  const visibleColumns =
    props.showEmptyGroups || cards.length === 0
      ? columns
      : columns.filter((column) => column.cards.length > 0);
  return (
    <div
      className="code-board__body"
      data-grouping={props.grouping}
      data-layout={props.isNarrow ? "list" : "columns"}
    >
      {refreshNotice}
      {emptyNote}
      {props.isNarrow ? (
        <CodeBoardListView
          columns={visibleColumns}
          projectNames={props.projectNames}
          {...overlayProps(props)}
        />
      ) : (
        <div className="board" data-grouping={props.grouping}>
          {visibleColumns.map((column) => (
            <CodeBoardColumnView
              column={column}
              key={column.key}
              projectNames={props.projectNames}
              {...overlayProps(props)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CodeBoardListView(props: {
  readonly columns: readonly CodeBoardColumn[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}) {
  return (
    <div className="code-board__list">
      {props.columns.map((column) => (
        <section
          aria-label={`${column.label} (${column.cards.length})`}
          className="code-board__list-group"
          key={column.key}
        >
          <header className="code-board__list-head">
            {column.status === undefined ? null : (
              <span aria-hidden="true" className={`st st-${column.status}`} />
            )}
            <h2 className="oct-section-label">{column.label}</h2>
            <span aria-hidden="true" className="count oct-meta">
              {column.cards.length}
            </span>
          </header>
          {column.cards.length === 0 ? (
            <SurfaceEmpty title="No threads" />
          ) : (
            <ul className="issuelist">
              {column.cards.map((card) => (
                <li key={String(card.threadId)}>
                  <CodeBoardCardView
                    card={card}
                    layout="list"
                    statusPresentation="visible"
                    unread={props.unreadThreadIds?.has(String(card.threadId)) === true}
                    {...cardViewExtras(card, props)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function CodeBoardColumnView(props: {
  readonly column: CodeBoardColumn;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}) {
  const { column } = props;
  // A Status column header already states the status visibly, so its cards only
  // need the status for assistive technology. Project columns carry no status of
  // their own, so their cards must show it as visible text — the colored dot
  // alone is not a status.
  const statusPresentation = column.kind === "status" ? "screen-reader" : "visible";
  return (
    <section
      aria-label={`${column.label} (${column.cards.length})`}
      className="board-col"
      data-column-kind={column.kind}
      data-empty={column.cards.length === 0 ? "true" : "false"}
    >
      <header className="board-col-head">
        {column.status === undefined ? null : (
          <span aria-hidden="true" className={`st st-${column.status}`} />
        )}
        <h2 className="oct-section-label">{column.label}</h2>
        <span aria-hidden="true" className="count oct-meta">
          {column.cards.length}
        </span>
      </header>
      {column.cards.length === 0 ? (
        <div className="board-col-body">
          <SurfaceEmpty title="No threads" />
        </div>
      ) : (
        <ul className="board-col-body">
          {column.cards.map((card) => (
            <li key={String(card.threadId)}>
              <CodeBoardCardView
                card={card}
                layout="card"
                statusPresentation={statusPresentation}
                unread={props.unreadThreadIds?.has(String(card.threadId)) === true}
                {...cardViewExtras(card, props)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CodeBoardCardView(props: {
  readonly card: CodeBoardCard;
  readonly layout: "card" | "list";
  readonly statusPresentation: "visible" | "screen-reader";
  readonly unread: boolean;
  readonly projectName?: string;
  readonly providerLabel?: string;
  readonly onOpen?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}) {
  const { card } = props;
  const statusLabel = codeBoardStatusLabel(card.status);
  const waitingReason = waitingReasonText(card);
  const className = props.layout === "list" ? "issuerow" : "board-card";
  return (
    <article
      className={className}
      data-follow-up={card.followUp ? "true" : "false"}
      data-status={card.status}
    >
      <span className={props.layout === "list" ? "issuerow-main" : "board-card-top"}>
        {props.unread ? <span className="sr-only">Unread</span> : null}
        <OctantButton
          className="code-board__card-open"
          onClick={() =>
            props.onOpen?.({
              threadId: card.threadId,
              projectId: card.projectId,
            })
          }
          type="button"
        >
          {/* the recipe clamps the title to two lines; the attribute keeps
              the full title reachable on hover */}
          <span
            className={props.layout === "list" ? "issuerow-title" : "board-card-title"}
            title={card.title}
          >
            {card.title}
          </span>
        </OctantButton>
        {/*
         * The status is always text: a compact chip where the column does not
         * state it, and screen-reader-only where the Status column header
         * already does. The column head's dot is the only decorative dot.
         */}
        <span className={props.statusPresentation === "visible" ? "badge" : "sr-only"}>
          {statusLabel}
        </span>
      </span>
      {props.layout === "card" && card.childAgents.latestSummary !== undefined ? (
        <span className="board-card-activity">{card.childAgents.latestSummary}</span>
      ) : null}
      <span className={props.layout === "list" ? "issuerow-meta" : "board-card-facts"}>
        {cardFacts(card, props.projectName, props.providerLabel).map((fact) => (
          <span className={fact.className ?? "fact"} key={fact.key}>
            {fact.icon}
            {fact.text}
          </span>
        ))}
      </span>
      <ThreadBoardPullRequestSummaries
        {...(props.onSelectPullRequest === undefined
          ? {}
          : { onSelect: props.onSelectPullRequest })}
        summaries={card.pullRequestSummaries}
      />
      {waitingReason === undefined ? null : (
        <span className="board-card-blocked">{waitingReason}</span>
      )}
      <details className="code-board__card-details">
        <summary aria-label={`Details for ${card.title}`}>
          <span>Details</span>
          <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} />
        </summary>
        <dl className="code-board__card-meta">
          {cardDetailRows(card, props.projectName, props.providerLabel).map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </details>
    </article>
  );
}

function overlayProps(props: {
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}): {
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
} {
  return {
    ...(props.providerLabels === undefined ? {} : { providerLabels: props.providerLabels }),
    ...(props.unreadThreadIds === undefined ? {} : { unreadThreadIds: props.unreadThreadIds }),
    ...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread }),
    ...(props.onSelectPullRequest === undefined
      ? {}
      : { onSelectPullRequest: props.onSelectPullRequest }),
  };
}

function lastUsefulView(board: BoardState): CodeBoardView | undefined {
  if (board.status === "ready" || board.status === "refreshing") return board.view;
  if (board.status === "error") return board.view;
  return undefined;
}

function cardViewExtras(
  card: CodeBoardCard,
  props: {
    readonly projectNames: ReadonlyMap<string, string>;
    readonly providerLabels?: ReadonlyMap<string, string>;
    readonly onOpenThread?: (target: CodeThreadOpenTarget) => void;
    readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  },
): {
  readonly projectName?: string;
  readonly providerLabel?: string;
  readonly onOpen?: (target: CodeThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
} {
  const projectName = props.projectNames.get(String(card.projectId));
  const providerLabel = props.providerLabels?.get(String(card.providerInstanceId));
  return {
    ...(projectName === undefined ? {} : { projectName }),
    ...(providerLabel === undefined ? {} : { providerLabel }),
    ...(props.onOpenThread === undefined ? {} : { onOpen: props.onOpenThread }),
    ...(props.onSelectPullRequest === undefined
      ? {}
      : { onSelectPullRequest: props.onSelectPullRequest }),
  };
}

function waitingReasonText(card: CodeBoardCard): string | undefined {
  if (card.status !== "waiting") return undefined;
  if (card.recovery.kind === "recovering") {
    return `Recovery: ${card.recovery.reasons.map(recoveryReasonLabel).join(", ")}`;
  }
  if (card.blockingReason !== undefined) return card.blockingReason;
  return codeBoardStatusReasonLabel(card.statusReason);
}

interface CardFact {
  readonly key: string;
  readonly text: string;
  readonly className?: string;
  readonly icon?: ReactNode;
}

function cardFacts(
  card: CodeBoardCard,
  projectName: string | undefined,
  providerLabel: string | undefined,
): ReadonlyArray<CardFact> {
  const facts: CardFact[] = [];
  const hasPullRequestSummaries =
    card.pullRequestSummaries.items.length > 0 || card.pullRequestSummaries.hiddenCount > 0;
  if (projectName !== undefined) facts.push({ key: "project", text: projectName });
  facts.push({
    key: "checkout",
    text: card.checkoutKind === "managed-worktree" ? "Managed worktree" : "Current checkout",
  });
  if (card.worktree.kind === "available" && card.worktree.head.kind === "branch") {
    facts.push({
      key: "branch",
      text: card.worktree.head.name,
      icon: <GitBranch aria-hidden="true" className="icon" size={12} strokeWidth={1.8} />,
    });
  }
  if (card.changedFiles.kind === "observed" && card.changedFiles.changedPathCount > 0) {
    const count = card.changedFiles.changedPathCount;
    facts.push({
      key: "files",
      text: `${count} ${count === 1 ? "file" : "files"} +${card.changedFiles.insertions.toLocaleString()} −${card.changedFiles.deletions.toLocaleString()}`,
    });
  }
  facts.push({
    key: "provider-model",
    text: providerLabel === undefined ? card.modelId : `${providerLabel} · ${card.modelId}`,
  });
  if (card.childAgents.active > 0 || card.childAgents.unacknowledgedResults > 0) {
    const parts: string[] = [];
    if (card.childAgents.active > 0) {
      parts.push(
        `${card.childAgents.active} active ${card.childAgents.active === 1 ? "run" : "runs"}`,
      );
    }
    if (card.childAgents.unacknowledgedResults > 0) {
      parts.push(
        `${card.childAgents.unacknowledgedResults} ${
          card.childAgents.unacknowledgedResults === 1 ? "result" : "results"
        }`,
      );
    }
    facts.push({ key: "child-runs", text: parts.join(" · ") });
  }
  if (card.planProgress.kind === "present") {
    facts.push({
      key: "plan-progress",
      text: `${card.planProgress.done} of ${card.planProgress.total} tasks`,
    });
  }
  if (!hasPullRequestSummaries && card.linkedPullRequest.kind === "linked") {
    facts.push({
      key: "pr",
      text: `#${card.linkedPullRequest.number}${
        card.linkedPullRequest.freshness === "stale" ? " · stale" : ""
      }`,
      icon: <GitPullRequest aria-hidden="true" className="icon" size={12} strokeWidth={1.8} />,
    });
  }
  if (!hasPullRequestSummaries && card.checks.state !== "unknown") {
    facts.push({
      key: "checks",
      text: card.checks.state === "failing" ? "Checks failing" : `Checks ${card.checks.state}`,
      className: card.checks.state === "failing" ? "fact bad" : "fact",
    });
  }
  if (
    !hasPullRequestSummaries &&
    card.reviewState.state !== "unknown" &&
    card.reviewState.state !== "none"
  ) {
    facts.push({
      key: "review",
      text: `Review ${card.reviewState.state.replace("-", " ")}`,
    });
  }
  facts.push({
    key: "delivery",
    text: `${deliveryTargetLabel(card.outcomeKind)} · ${card.deliverySatisfaction}`,
  });
  if (card.followUp) {
    facts.push({
      key: "follow-up",
      text: "Follow-up",
      className: "fact warn",
    });
  }
  if (card.recovery.kind === "recovering") {
    facts.push({ key: "recovery", text: "Recovering" });
  }
  if (
    card.githubFreshness === "stale" ||
    (card.changedFiles.kind === "observed" && card.changedFiles.freshness === "stale") ||
    card.worktree.kind === "unavailable"
  ) {
    facts.push({ key: "stale", text: "Stale metadata" });
  }
  if (card.lastMeaningfulActivityAt !== null) {
    facts.push({
      key: "activity",
      text: activityLabel(card.lastMeaningfulActivityAt),
    });
  }
  return facts;
}

function cardDetailRows(
  card: CodeBoardCard,
  projectName: string | undefined,
  providerLabel: string | undefined,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const rows: Array<{ readonly label: string; readonly value: string }> = [];
  if (projectName !== undefined) rows.push({ label: "Project", value: projectName });
  if (card.worktree.kind === "available") {
    rows.push({
      label: card.checkoutKind === "managed-worktree" ? "Worktree" : "Checkout",
      value: card.worktree.path,
    });
  }
  rows.push({
    label: "Provider",
    value: providerLabel === undefined ? String(card.providerInstanceId) : providerLabel,
  });
  rows.push({ label: "Model", value: card.modelId });
  rows.push({
    label: "Delivery target",
    value: `${deliveryTargetLabel(card.outcomeKind)} · ${card.deliverySatisfaction}`,
  });
  rows.push({ label: "Reason", value: codeBoardStatusReasonLabel(card.statusReason) });
  if (card.worktree.kind === "available" && card.worktree.head.kind === "branch") {
    rows.push({ label: "Branch", value: card.worktree.head.name });
  }
  if (card.linkedPullRequest.kind === "linked") {
    rows.push({
      label: "Pull request",
      value: `#${card.linkedPullRequest.number} · ${card.linkedPullRequest.state}${
        card.linkedPullRequest.freshness === "stale" ? " · stale" : ""
      }`,
    });
  }
  if (card.checks.state !== "unknown") {
    rows.push({
      label: "Checks",
      value: `${card.checks.state}${card.checks.freshness === "stale" ? " · stale" : ""}`,
    });
  }
  if (card.reviewState.state !== "unknown") {
    rows.push({
      label: "Review",
      value: `${card.reviewState.state}${card.reviewState.freshness === "stale" ? " · stale" : ""}`,
    });
  }
  if (card.childAgents.latestSummary !== undefined) {
    rows.push({ label: "Latest child run", value: card.childAgents.latestSummary });
  }
  if (card.lastMeaningfulActivityAt !== null) {
    rows.push({
      label: "Last activity",
      value: new Date(String(card.lastMeaningfulActivityAt)).toLocaleString(),
    });
  }
  return rows;
}

function activityLabel(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleString();
}

function buildQuery(filters: FilterState): CodeBoardQuery {
  const query: {
    version: 1;
    text?: string;
    statuses?: CodeBoardStatus[];
    projectIds?: ProjectId[];
    followUp?: FilterState["followUp"];
    pullRequest?: FilterState["pullRequest"];
    checks?: FilterState["checks"];
  } = { version: 1 };
  const text = filters.text.trim();
  if (text !== "") query.text = text;
  if (filters.statuses.size !== ALL_STATUSES.length) {
    query.statuses = ALL_STATUSES.filter((status) => filters.statuses.has(status));
  }
  if (filters.projectIds.size > 0) {
    query.projectIds = [...filters.projectIds] as ProjectId[];
  }
  if (filters.followUp !== "any") query.followUp = filters.followUp;
  if (filters.pullRequest !== "any") query.pullRequest = filters.pullRequest;
  if (filters.checks !== "any") query.checks = filters.checks;
  return query as CodeBoardQuery;
}

function toggleStatus(prev: FilterState, status: CodeBoardStatus, checked: boolean): FilterState {
  const statuses = new Set(prev.statuses);
  if (checked) statuses.add(status);
  else statuses.delete(status);
  // Never allow an empty status filter: fall back to the all-status default.
  if (statuses.size === 0) return { ...prev, statuses: new Set(ALL_STATUSES) };
  return { ...prev, statuses };
}

function statusSummary(statuses: ReadonlySet<CodeBoardStatus>): string {
  return ALL_STATUSES.filter((status) => statuses.has(status))
    .map(codeBoardStatusLabel)
    .join(", ");
}

interface ActiveFilterLabel {
  readonly kind: string;
  readonly label: string;
  /** The label embeds text a person typed (a search term, a Project name),
   * so it must render as typed rather than uppercased into a label. */
  readonly verbatim?: true;
}

function activeFilterLabels(
  filters: FilterState,
  projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<ActiveFilterLabel> {
  const active: ActiveFilterLabel[] = [];
  const text = filters.text.trim();
  if (text !== "") active.push({ kind: "search", label: `Search: ${text}`, verbatim: true });
  if (filters.statuses.size !== ALL_STATUSES.length) {
    active.push({
      kind: "statuses",
      label: `${filters.statuses.size} ${filters.statuses.size === 1 ? "status" : "statuses"}`,
    });
  }
  for (const projectId of filters.projectIds) {
    active.push({
      kind: "project",
      label: projectNames.get(projectId) ?? "Selected Project",
      verbatim: true,
    });
  }
  if (filters.pullRequest !== "any") {
    const labels: Readonly<Record<Exclude<FilterState["pullRequest"], "any">, string>> = {
      linked: "Linked PR",
      none: "No PR",
      open: "Open PR",
      merged: "Merged PR",
      closed: "Closed PR",
    };
    active.push({ kind: "pull-request", label: labels[filters.pullRequest] });
  }
  if (filters.checks !== "any") {
    active.push({
      kind: "checks",
      label: `${filters.checks[0]!.toUpperCase()}${filters.checks.slice(1)} checks`,
    });
  }
  if (filters.followUp !== "any") {
    active.push({
      kind: "follow-up",
      label: filters.followUp === "only" ? "Follow-up only" : "No follow-up",
    });
  }
  return active;
}

function activeFilterSummary(filters: FilterState): string {
  const active: string[] = [];
  if (filters.text.trim() !== "") active.push(`search “${filters.text.trim()}”`);
  if (filters.statuses.size !== ALL_STATUSES.length) {
    active.push(`status ${statusSummary(filters.statuses)}`);
  }
  if (filters.projectIds.size > 0) active.push("a Project");
  if (filters.pullRequest !== "any") active.push(`pull request ${filters.pullRequest}`);
  if (filters.checks !== "any") active.push(`checks ${filters.checks}`);
  if (filters.followUp !== "any") active.push(`follow-up ${filters.followUp}`);
  return active.length === 0 ? "No filters are active." : `Active filters: ${active.join("; ")}.`;
}

function firstOrEmpty(values: ReadonlySet<string>): string {
  for (const value of values) return value;
  return "";
}

function deliveryTargetLabel(kind: CodeBoardCard["outcomeKind"]): string {
  switch (kind) {
    case "investigation-result":
      return "Investigation result";
    case "local-implementation":
      return "Local implementation";
    case "opened-pr":
      return "Opened PR";
    case "merged-pr":
      return "Merged PR";
  }
}

function recoveryReasonLabel(reason: CodeThreadMetadataRecoveryReason): string {
  return reason === "project-projection-missing"
    ? "Project projection missing"
    : "Operation journal rebuild required";
}

function readStoredGrouping(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
): CodeBoardGrouping | undefined {
  try {
    const value = storage?.getItem(GROUPING_STORAGE_KEY);
    return value === "status" || value === "project" ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredGrouping(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  grouping: CodeBoardGrouping,
): void {
  try {
    storage?.setItem(GROUPING_STORAGE_KEY, grouping);
  } catch {
    // A device that cannot persist the preference still works this session.
  }
}

function readStoredBoolean(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  key: string,
): boolean | undefined {
  try {
    const value = storage?.getItem(key);
    return value === "true" ? true : value === "false" ? false : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredBoolean(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  key: string,
  value: boolean,
): void {
  try {
    storage?.setItem(key, String(value));
  } catch {
    // A device that cannot persist the preference still works this session.
  }
}
