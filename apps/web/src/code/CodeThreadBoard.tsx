import type {
  CodeBoardCard,
  CodeBoardQuery,
  CodeBoardStatus,
  CodeBoardView,
  CodeThreadMetadataRecoveryReason,
} from "@octant/contracts";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId } from "@octant/contracts/projects";
import { CODE_BOARD_STATUS_COLUMN_ORDER } from "@octant/domain/code-policy";
import { ChevronDown, Filter, GitBranch, GitPullRequest, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import {
  codeBoardStatusLabel,
  groupCodeBoardCards,
  type CodeBoardColumn,
  type CodeBoardGrouping,
  type CodeBoardProjectRef,
} from "./codeBoardGrouping";

const GROUPING_STORAGE_KEY = "octant.code.board.grouping";
const SHOW_EMPTY_GROUPS_STORAGE_KEY = "octant.code.board.show-empty-groups";
const ALL_STATUSES: readonly CodeBoardStatus[] = CODE_BOARD_STATUS_COLUMN_ORDER;
const FILTERS_PANEL_ID = "code-board-advanced-filters";

export interface CodeThreadBoardProps {
  readonly loadBoard: (query: CodeBoardQuery) => Promise<CodeBoardView>;
  /** Code Projects in the user's configured order (for grouping and filters). */
  readonly projects: readonly CodeBoardProjectRef[];
  readonly onOpenThread?: (threadId: CodeThreadId) => void;
  readonly onClose?: () => void;
  readonly initialGrouping?: CodeBoardGrouping;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

type BoardState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeBoardView }
  | { readonly status: "error"; readonly message: string };

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
  // The Status board is a column view: every status column is visible by
  // default so an empty column reads as "nothing here" rather than vanishing.
  const [showEmptyGroups, setShowEmptyGroups] = useState(
    () => readStoredBoolean(storage, SHOW_EMPTY_GROUPS_STORAGE_KEY) ?? true,
  );
  const [board, setBoard] = useState<BoardState>({ status: "loading" });
  const filtersRootRef = useRef<HTMLDivElement>(null);
  const filtersToggleRef = useRef<HTMLButtonElement>(null);

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
    setBoard({ status: "loading" });
    loadBoardRef.current(query).then(
      (view) => {
        if (active) setBoard({ status: "ready", view });
      },
      (error: unknown) => {
        if (active) {
          setBoard({
            status: "error",
            message:
              error instanceof Error ? error.message : "The Code Thread Board is unavailable.",
          });
        }
      },
    );
    return () => {
      active = false;
    };
    // queryKey captures every filter that affects the server result (`query` is
    // recomputed from the same filters, so it moves only when queryKey does).
    // Grouping is deliberately excluded: switching grouping is a pure client
    // projection and must not re-query or mutate any authoritative state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey]);

  useEffect(() => {
    if (!filtersOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (filtersRootRef.current === null) return;
      if (event.target instanceof Node && filtersRootRef.current.contains(event.target)) return;
      setFiltersOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setFiltersOpen(false);
      // Escape closes the dialog the person was typing in. Without this the
      // focus falls to the document body and they lose their place in the
      // toolbar, so send it back to the control that opened the dialog.
      filtersToggleRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filtersOpen]);

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
    <section aria-label="Code Thread Board" className="code-board">
      <header className="code-board__header">
        <div className="code-board__identity">
          <h1 className="code-board__title">Threads</h1>
          <p className="code-board__subtitle">
            One runtime-derived view of your Code threads and coding agents.
          </p>
        </div>
        {props.onClose === undefined ? null : (
          <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
            Back to workspace
          </OctantButton>
        )}
      </header>

      <div aria-label="Board controls" className="code-board__toolbar" role="group">
        <div className="code-board__primary-controls">
          <fieldset className="code-board__grouping">
            <legend className="sr-only">Group by</legend>
            <div className="code-board__grouping-options">
              {(["status", "project"] as const).map((option) => (
                <label className="code-board__grouping-option" key={option}>
                  <input
                    checked={grouping === option}
                    name="code-board-grouping"
                    onChange={() => changeGrouping(option)}
                    type="radio"
                    value={option}
                  />
                  <span>{option === "status" ? "Status" : "Project"}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <label className="code-board__search">
            <span className="sr-only">Search threads</span>
            <Search aria-hidden="true" size={14} strokeWidth={1.8} />
            <input
              onChange={(event) => setFilters((prev) => ({ ...prev, text: event.target.value }))}
              placeholder="Search threads"
              type="search"
              value={filters.text}
            />
          </label>

          <div className="code-board__filters" ref={filtersRootRef}>
            <OctantButton
              ref={filtersToggleRef}
              aria-controls={FILTERS_PANEL_ID}
              aria-expanded={filtersOpen}
              aria-haspopup="dialog"
              aria-label={
                activeAdvancedFilterCount === 0
                  ? "Filters"
                  : `Filters, ${activeAdvancedFilterCount} active`
              }
              className="code-board__filters-toggle"
              data-active={activeAdvancedFilterCount > 0 ? "true" : "false"}
              onClick={() => setFiltersOpen((open) => !open)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Filter aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>Filters</span>
              {activeAdvancedFilterCount === 0 ? null : (
                <span aria-hidden="true" className="code-board__filter-count">
                  {activeAdvancedFilterCount}
                </span>
              )}
            </OctantButton>

            {filtersOpen ? (
              <div
                aria-label="Filters"
                className="code-board__filters-panel"
                id={FILTERS_PANEL_ID}
                role="dialog"
              >
                <fieldset className="code-board__status-filter">
                  <legend>Status</legend>
                  <div className="code-board__status-options">
                    {ALL_STATUSES.map((status) => (
                      <label className="code-board__status-option" key={status}>
                        <input
                          checked={filters.statuses.has(status)}
                          onChange={(event) =>
                            setFilters((prev) => toggleStatus(prev, status, event.target.checked))
                          }
                          type="checkbox"
                        />
                        <span>
                          <span
                            aria-hidden="true"
                            className="code-board__status-dot"
                            data-status={status}
                          />
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
                      <select
                        onChange={(event) =>
                          setFilters((prev) => ({
                            ...prev,
                            projectIds:
                              event.target.value === ""
                                ? new Set<string>()
                                : new Set<string>([event.target.value]),
                          }))
                        }
                        value={firstOrEmpty(filters.projectIds)}
                      >
                        <option value="">All Projects</option>
                        {props.projects.map((project) => (
                          <option key={String(project.id)} value={String(project.id)}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  <label>
                    <span>Pull request</span>
                    <select
                      onChange={(event) =>
                        setFilters((prev) => ({
                          ...prev,
                          pullRequest: event.target.value as FilterState["pullRequest"],
                        }))
                      }
                      value={filters.pullRequest}
                    >
                      <option value="any">Any</option>
                      <option value="linked">Linked</option>
                      <option value="none">No PR</option>
                      <option value="open">Open</option>
                      <option value="merged">Merged</option>
                      <option value="closed">Closed</option>
                    </select>
                  </label>

                  <label>
                    <span>Checks</span>
                    <select
                      onChange={(event) =>
                        setFilters((prev) => ({
                          ...prev,
                          checks: event.target.value as FilterState["checks"],
                        }))
                      }
                      value={filters.checks}
                    >
                      <option value="any">Any</option>
                      <option value="passing">Passing</option>
                      <option value="failing">Failing</option>
                      <option value="pending">Pending</option>
                      <option value="unknown">Unknown</option>
                    </select>
                  </label>

                  <label>
                    <span>Follow-up</span>
                    <select
                      onChange={(event) =>
                        setFilters((prev) => ({
                          ...prev,
                          followUp: event.target.value as FilterState["followUp"],
                        }))
                      }
                      value={filters.followUp}
                    >
                      <option value="any">Any</option>
                      <option value="only">Only follow-up</option>
                      <option value="excluded">Exclude follow-up</option>
                    </select>
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
              </div>
            ) : null}
          </div>

          <details className="code-board__view-options">
            <summary>
              <span>View</span>
              <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
            </summary>
            <div className="code-board__view-popover">
              <label>
                <input
                  checked={showEmptyGroups}
                  onChange={(event) => {
                    setShowEmptyGroups(event.target.checked);
                    writeStoredBoolean(
                      storage,
                      SHOW_EMPTY_GROUPS_STORAGE_KEY,
                      event.target.checked,
                    );
                  }}
                  type="checkbox"
                />
                <span>Show empty groups</span>
              </label>
            </div>
          </details>
        </div>

        {activeFilters.length === 0 ? null : (
          <div aria-label="Active filters" className="code-board__active-filters" role="status">
            {activeFilters.map((filter) => (
              <span className="code-board__active-filter" key={`${filter.kind}:${filter.label}`}>
                {filter.label}
              </span>
            ))}
          </div>
        )}
      </div>

      <CodeBoardBody
        board={board}
        filters={filters}
        grouping={grouping}
        projectNames={projectNames}
        projects={props.projects}
        showEmptyGroups={showEmptyGroups}
        {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
      />
    </section>
  );
}

function CodeBoardBody(props: {
  readonly board: BoardState;
  readonly filters: FilterState;
  readonly grouping: CodeBoardGrouping;
  readonly projects: readonly CodeBoardProjectRef[];
  readonly projectNames: ReadonlyMap<string, string>;
  readonly showEmptyGroups: boolean;
  readonly onOpenThread?: (threadId: CodeThreadId) => void;
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
  if (props.board.status === "error") {
    return (
      <div className="code-board__body">
        <ShellState
          eyebrow="Code Thread Board"
          message={props.board.message}
          role="alert"
          state="disconnected"
          title="The board is unavailable"
        />
      </div>
    );
  }
  const cards = props.board.view.cards;
  // Status grouping with empty groups shown promises four fixed columns. A
  // board with no matches is exactly when someone needs to see that shape, so
  // the result flows through grouping and the explanation sits above it.
  const showsFixedColumns = props.grouping === "status" && props.showEmptyGroups;
  const emptyNote =
    cards.length === 0 ? (
      <div className="code-board__empty" role="status">
        <p>No Code threads match the current filters.</p>
        <p>{activeFilterSummary(props.filters)}</p>
        <p>No threads were deleted or completed; adjust the filters to see more.</p>
      </div>
    ) : null;
  if (cards.length === 0 && !showsFixedColumns) {
    return <div className="code-board__body">{emptyNote}</div>;
  }
  const columns = groupCodeBoardCards(cards, props.grouping, { projects: props.projects });
  const visibleColumns = props.showEmptyGroups
    ? columns
    : columns.filter((column) => column.cards.length > 0);
  return (
    <div className="code-board__body" data-grouping={props.grouping}>
      {emptyNote}
      <div className="code-board__columns" data-grouping={props.grouping}>
        {visibleColumns.map((column) => (
          <CodeBoardColumnView
            column={column}
            key={column.key}
            projectNames={props.projectNames}
            {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
          />
        ))}
      </div>
    </div>
  );
}

function CodeBoardColumnView(props: {
  readonly column: CodeBoardColumn;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly onOpenThread?: (threadId: CodeThreadId) => void;
}) {
  const { column } = props;
  // A Status column header already states the status visibly, so its cards only
  // need the status for assistive technology. Project and Recovery columns carry
  // no status of their own, so their cards must show it as visible text — the
  // colored dot alone is not a status.
  const statusPresentation = column.kind === "status" ? "screen-reader" : "visible";
  return (
    <section
      aria-label={`${column.label} (${column.cards.length})`}
      className="code-board__column"
      data-column-kind={column.kind}
    >
      <header className="code-board__column-header">
        {column.status === undefined ? null : (
          <span aria-hidden="true" className="code-board__status-dot" data-status={column.status} />
        )}
        <h2>{column.label}</h2>
        <span aria-hidden="true" className="code-board__column-count">
          {column.cards.length}
        </span>
      </header>
      {column.cards.length === 0 ? (
        <p className="code-board__column-empty">No threads</p>
      ) : (
        <ul className="code-board__cards">
          {column.cards.map((card) => (
            <li key={String(card.threadId)}>
              <CodeBoardCardView
                card={card}
                statusPresentation={statusPresentation}
                {...(() => {
                  const projectName = props.projectNames.get(String(card.projectId));
                  return projectName === undefined ? {} : { projectName };
                })()}
                {...(props.onOpenThread === undefined ? {} : { onOpen: props.onOpenThread })}
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
  readonly statusPresentation: "visible" | "screen-reader";
  readonly projectName?: string;
  readonly onOpen?: (threadId: CodeThreadId) => void;
}) {
  const { card } = props;
  const statusLabel = codeBoardStatusLabel(card.status);
  const stale =
    card.githubFreshness === "stale" ||
    card.changedFiles.kind === "unavailable" ||
    card.worktree.kind === "unavailable";
  const changedFileCount =
    card.changedFiles.kind === "observed" ? card.changedFiles.changedPathCount : 0;
  return (
    <article
      className="code-board__card"
      data-follow-up={card.followUp ? "true" : "false"}
      data-status={card.status}
    >
      <div className="code-board__card-head">
        <span aria-hidden="true" className="code-board__status-dot" data-status={card.status} />
        <button
          className="code-board__card-open"
          onClick={() => props.onOpen?.(card.threadId as CodeThreadId)}
          type="button"
        >
          <span className="code-board__card-title">{card.title}</span>
        </button>
        {/*
         * The dot is decorative. The status itself is always text: a compact
         * chip where the column does not state it, and screen-reader-only where
         * the Status column header already does.
         */}
        <span
          className={
            props.statusPresentation === "visible"
              ? "code-board__flag code-board__card-status"
              : "sr-only"
          }
        >
          {statusLabel}
        </span>
      </div>
      <p className="code-board__card-meta-line">
        {props.projectName === undefined ? null : <span>{props.projectName}</span>}
        <span>{card.modelId}</span>
      </p>
      <p className="code-board__card-flags">
        {card.recovery.kind === "recovering" ? (
          <span className="code-board__flag code-board__flag--recovery">
            Recovery: {card.recovery.reasons.map(recoveryReasonLabel).join(", ")}
          </span>
        ) : null}
        {card.blockingReason === undefined ? null : (
          <span className="code-board__flag code-board__flag--blocked">{card.blockingReason}</span>
        )}
        {card.checks.state === "failing" ? (
          <span className="code-board__flag code-board__flag--blocked">Checks failing</span>
        ) : null}
        {card.followUp ? (
          <span className="code-board__flag code-board__flag--follow-up" data-indicator="follow-up">
            <span aria-hidden="true">◆</span> Follow-up
          </span>
        ) : null}
        {card.unread ? <span className="code-board__flag">Unread</span> : null}
        {card.childAgents.active === 0 ? null : (
          <span className="code-board__flag">
            {card.childAgents.active} active {card.childAgents.active === 1 ? "agent" : "agents"}
          </span>
        )}
        {changedFileCount === 0 ? null : (
          <span className="code-board__flag">
            {changedFileCount} {changedFileCount === 1 ? "file" : "files"}
          </span>
        )}
        {card.linkedPullRequest.kind === "linked" ? (
          <span className="code-board__flag">
            <GitPullRequest aria-hidden="true" size={11} strokeWidth={1.8} /> #
            {card.linkedPullRequest.number}
          </span>
        ) : null}
        {stale ? (
          <span
            className="code-board__flag code-board__flag--stale"
            title="Some metadata could not be refreshed"
          >
            Stale metadata
          </span>
        ) : null}
      </p>
      <details className="code-board__card-details">
        <summary aria-label={`Details for ${card.title}`}>
          <span>Details</span>
          <ChevronDown aria-hidden="true" size={12} strokeWidth={1.8} />
        </summary>
        <dl className="code-board__card-meta">
          {props.projectName === undefined ? null : (
            <div>
              <dt>Project</dt>
              <dd>{props.projectName}</dd>
            </div>
          )}
          <div>
            <dt>Delivery target</dt>
            <dd>{deliveryTargetLabel(card.outcomeKind)}</dd>
          </div>
          {card.worktree.kind === "available" && card.worktree.head.kind === "branch" ? (
            <div>
              <dt>Branch</dt>
              <dd>
                <GitBranch aria-hidden="true" size={13} strokeWidth={1.8} />{" "}
                {card.worktree.head.name}
              </dd>
            </div>
          ) : null}
          {card.linkedPullRequest.kind === "linked" ? (
            <div>
              <dt>Pull request</dt>
              <dd>
                <GitPullRequest aria-hidden="true" size={13} strokeWidth={1.8} /> #
                {card.linkedPullRequest.number} · {card.linkedPullRequest.state}
              </dd>
            </div>
          ) : null}
          {card.checks.state === "unknown" || card.checks.state === "failing" ? null : (
            <div>
              <dt>Checks</dt>
              <dd>{card.checks.state}</dd>
            </div>
          )}
        </dl>
      </details>
    </article>
  );
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

function activeFilterLabels(
  filters: FilterState,
  projectNames: ReadonlyMap<string, string>,
): ReadonlyArray<{ readonly kind: string; readonly label: string }> {
  const active: Array<{ readonly kind: string; readonly label: string }> = [];
  const text = filters.text.trim();
  if (text !== "") active.push({ kind: "search", label: `Search: ${text}` });
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
