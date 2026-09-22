import type {
  WorkBoardCard,
  WorkBoardQuery,
  WorkBoardRecoveryReason,
  WorkBoardStatus,
  WorkBoardView,
  ThreadBoardPullRequestIdentity,
} from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { WorkThreadId } from "@octant/contracts/work-threads";
import { THREAD_BOARD_STATUS_COLUMN_ORDER } from "@octant/domain/thread-board-policy";
import { ChevronDown, Filter, Folder, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cardViewExtras, ThreadBoardBody } from "../board/ThreadBoardView";
import {
  activityLabel,
  defaultBoardStorage,
  firstOrEmpty,
  lastUsefulView,
  readStoredBoolean,
  readStoredValue,
  type BoardStorage,
  type CardFact,
  type ThreadBoardState,
  type ActiveFilterLabel,
  writeStoredBoolean,
  writeStoredValue,
} from "../board/threadBoardState";
import { Surface, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantButton } from "../ui/base/OctantButton";
import { absoluteTimeFormatter, relativeTimeLabel } from "../lib/relativeTime";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantPopover } from "../ui/base/OctantPopover";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  groupWorkBoardCards,
  workBoardStatusLabel,
  workBoardStatusReasonLabel,
  type WorkBoardColumn,
  type WorkBoardGrouping,
  type WorkBoardProjectRef,
} from "./workBoardGrouping";
import { ThreadBoardPullRequestSummaries } from "../threadBoard/ThreadBoardPullRequestSummaries";

const GROUPING_STORAGE_KEY = "octant.work.board.grouping";
const SHOW_EMPTY_GROUPS_STORAGE_KEY = "octant.work.board.show-empty-groups";
const ALL_STATUSES: readonly WorkBoardStatus[] = THREAD_BOARD_STATUS_COLUMN_ORDER;

export interface WorkThreadOpenTarget {
  readonly threadId: WorkThreadId;
  readonly projectId: ProjectId;
}

export interface WorkThreadBoardProps {
  readonly loadBoard: (query: WorkBoardQuery) => Promise<WorkBoardView>;
  readonly projects: readonly WorkBoardProjectRef[];
  readonly onOpenThread?: (target: WorkThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  readonly onClose?: () => void;
  readonly initialGrouping?: WorkBoardGrouping;
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
  readonly unreadThreadIds?: ReadonlySet<string>;
  readonly providerLabels?: ReadonlyMap<string, string>;
  readonly isNarrow?: boolean;
}

interface FilterState {
  readonly text: string;
  readonly statuses: ReadonlySet<WorkBoardStatus>;
  readonly projectIds: ReadonlySet<string>;
  readonly followUp: "any" | "only" | "excluded";
  readonly pendingRequest: "any" | "only" | "excluded";
}

const DEFAULT_FILTERS: FilterState = {
  text: "",
  statuses: new Set(ALL_STATUSES),
  projectIds: new Set<string>(),
  followUp: "any",
  pendingRequest: "any",
};

export function WorkThreadBoard(props: WorkThreadBoardProps) {
  const storage: BoardStorage | undefined = props.storage ?? defaultBoardStorage();
  const [grouping, setGrouping] = useState<WorkBoardGrouping>(
    () =>
      props.initialGrouping ??
      readStoredValue(storage, GROUPING_STORAGE_KEY, (value) =>
        value === "status" || value === "project" ? value : undefined,
      ) ??
      "status",
  );
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [showEmptyGroups, setShowEmptyGroups] = useState(
    () => readStoredBoolean(storage, SHOW_EMPTY_GROUPS_STORAGE_KEY) ?? true,
  );
  const [board, setBoard] = useState<ThreadBoardState<WorkBoardView>>({ status: "loading" });
  const [refreshNonce, setRefreshNonce] = useState(0);

  const query = useMemo(() => buildQuery(filters), [filters]);
  const queryKey = JSON.stringify(query);

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
        const message = error instanceof Error ? error.message : "The task board is unavailable.";
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
  }, [queryKey, refreshNonce]);

  function changeGrouping(next: WorkBoardGrouping) {
    setGrouping(next);
    writeStoredValue(storage, GROUPING_STORAGE_KEY, next);
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
    <Surface ariaLabel="Thread board" className="code-board" measure="wide">
      <SurfaceHeader
        subtitle="Your threads by status."
        title="Board"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />

      <div aria-label="Board controls" className="surface-toolbar" role="group">
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
                      {workBoardStatusLabel(status)}
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
                <span>Pending request</span>
                <OctantSelectField
                  onValueChange={(value) =>
                    setFilters((prev) => ({
                      ...prev,
                      pendingRequest: value as FilterState["pendingRequest"],
                    }))
                  }
                  options={[
                    { id: "any", label: "Any" },
                    { id: "only", label: "Only pending" },
                    { id: "excluded", label: "Exclude pending" },
                  ]}
                  value={filters.pendingRequest}
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
            <div className="code-board__view-row">
              <span className="code-board__view-label">Group by</span>
              <OctantToggleGroup<WorkBoardGrouping>
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
            </div>
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

      <ThreadBoardBody<WorkBoardCard, WorkBoardColumn, WorkBoardView>
        activeFilterSummary={
          activeFilterLabels(filters, projectNames).length === 0
            ? undefined
            : activeFilterSummary(filters)
        }
        board={board}
        cardsOf={(view) => view.cards}
        copy={{
          eyebrow: "Tasks",
          emptyTitle: "No tasks yet",
          emptyFilteredTitle: "No tasks match these filters",
          emptyDetail: "Create a task to see it here.",
        }}
        groupCards={(cards) => groupWorkBoardCards(cards, grouping, { projects: props.projects })}
        grouping={grouping}
        isNarrow={props.isNarrow === true}
        layout={props.isNarrow === true ? "list" : "columns"}
        onClearFilters={() => setFilters(DEFAULT_FILTERS)}
        renderCard={(card, presentation) => (
          <WorkBoardCardView
            card={card}
            layout={presentation.layout}
            statusPresentation={presentation.statusPresentation}
            unread={props.unreadThreadIds?.has(String(card.threadId)) === true}
            {...cardViewExtras(card, {
              projectNames,
              ...(props.providerLabels === undefined
                ? {}
                : { providerLabels: props.providerLabels }),
              ...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread }),
              ...(props.onSelectPullRequest === undefined
                ? {}
                : { onSelectPullRequest: props.onSelectPullRequest }),
            })}
          />
        )}
        showEmptyGroups={showEmptyGroups}
      />
    </Surface>
  );
}

function WorkBoardCardView(props: {
  readonly card: WorkBoardCard;
  readonly layout: "card" | "list";
  readonly statusPresentation: "visible" | "screen-reader";
  readonly unread: boolean;
  readonly projectName?: string;
  readonly providerLabel?: string;
  readonly onOpen?: (target: WorkThreadOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
}) {
  const { card } = props;
  const statusLabel = workBoardStatusLabel(card.status);
  const waitingReason = waitingReasonText(card);
  const className = props.layout === "list" ? "issuerow" : "board-card";
  return (
    <article
      className={className}
      data-follow-up={card.followUp ? "true" : "false"}
      data-status={card.status}
    >
      {props.layout === "card" && props.projectName !== undefined ? (
        <span className="board-card-eyebrow">{props.projectName}</span>
      ) : null}
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
          <span
            className={props.layout === "list" ? "issuerow-title" : "board-card-title"}
            title={card.title}
          >
            {card.title}
          </span>
        </OctantButton>
        <span className={props.statusPresentation === "visible" ? "badge" : "sr-only"}>
          {statusLabel}
        </span>
      </span>
      {props.layout === "card" && card.childRuns.latestSummary !== undefined ? (
        <span className="board-card-activity">{card.childRuns.latestSummary}</span>
      ) : null}
      {/* A card says what the task is doing now, who runs it, and when it last
          moved; the folder, model, delivery, and artifact facts live in the
          list view and on the task. Stacked on the card they made every task a
          wall of metadata with the same weight as its title. */}
      <span className={props.layout === "list" ? "issuerow-meta" : "board-card-facts"}>
        {(props.layout === "list"
          ? cardFacts(card, props.projectName, props.providerLabel)
          : cardSummary(card, props.providerLabel, waitingReason)
        ).map((fact) => (
          <span className={fact.className ?? "fact"} key={fact.key} title={fact.title ?? fact.text}>
            {fact.icon}
            {/* The fact is a flex row, and an ellipsis never applies to a flex
                container's bare text: the reason was cut mid-letter instead
                ("…stale or ambiguou"). The text truncates in a box of its own. */}
            <span className="fact__text">{fact.text}</span>
          </span>
        ))}
      </span>
      <ThreadBoardPullRequestSummaries
        {...(props.onSelectPullRequest === undefined
          ? {}
          : { onSelect: props.onSelectPullRequest })}
        summaries={card.pullRequestSummaries}
      />
      {props.layout === "list" && waitingReason !== undefined ? (
        <span className="board-card-blocked" title={waitingReason}>
          {waitingReason}
        </span>
      ) : null}
      {props.layout === "list" ? (
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
      ) : null}
    </article>
  );
}

function waitingReasonText(card: WorkBoardCard): string | undefined {
  if (card.status !== "waiting") return undefined;
  if (card.recovery.kind === "recovering") {
    return `Recovery: ${card.recovery.reasons.map(recoveryReasonLabel).join(", ")}`;
  }
  if (card.blockingReason !== undefined) return card.blockingReason;
  return workBoardStatusReasonLabel(card.statusReason);
}

function cardFacts(
  card: WorkBoardCard,
  projectName: string | undefined,
  providerLabel: string | undefined,
): ReadonlyArray<CardFact<ReactNode>> {
  const facts: CardFact<ReactNode>[] = [];
  if (projectName !== undefined) facts.push({ key: "project", text: projectName });
  if (card.binding.kind === "bound") {
    facts.push({
      key: "binding",
      text: card.binding.workingDirectory,
      icon: <Folder aria-hidden="true" className="icon" size={12} strokeWidth={1.8} />,
    });
  }
  facts.push({
    key: "provider-model",
    text: providerLabel === undefined ? card.modelId : `${providerLabel} · ${card.modelId}`,
  });
  if (card.activeRequest.kind === "pending") {
    facts.push({
      key: "request",
      text:
        card.activeRequest.requestKind === "approval"
          ? `Approval: ${card.activeRequest.summary}`
          : `Input: ${card.activeRequest.summary}`,
      className: "fact warn",
    });
  }
  if (card.artifacts.count > 0) {
    const count = card.artifacts.count;
    facts.push({
      key: "artifacts",
      text:
        card.artifacts.latestDisplayName === undefined
          ? `${count} ${count === 1 ? "artifact" : "artifacts"}`
          : card.artifacts.latestDisplayName,
    });
  }
  if (card.citations.count > 0) {
    facts.push({
      key: "citations",
      text: `${card.citations.count} ${card.citations.count === 1 ? "citation" : "citations"}${
        card.citations.staleCount > 0 ? " · stale" : ""
      }`,
    });
  }
  if (card.goal.kind === "present") {
    facts.push({ key: "goal", text: `Goal · ${card.goal.status}` });
  }
  facts.push({
    key: "delivery",
    text: `${card.deliveryTarget} · ${card.deliverySatisfaction}`,
  });
  if (card.childRuns.active > 0 || card.childRuns.unacknowledgedResults > 0) {
    const parts: string[] = [];
    if (card.childRuns.active > 0) {
      parts.push(`${card.childRuns.active} active ${card.childRuns.active === 1 ? "run" : "runs"}`);
    }
    if (card.childRuns.unacknowledgedResults > 0) {
      parts.push(
        `${card.childRuns.unacknowledgedResults} ${
          card.childRuns.unacknowledgedResults === 1 ? "result" : "results"
        }`,
      );
    }
    facts.push({ key: "child-runs", text: parts.join(" · ") });
  }
  if (card.followUp) {
    facts.push({ key: "follow-up", text: "Follow-up", className: "fact warn" });
  }
  if (card.recovery.kind === "recovering") {
    facts.push({ key: "recovery", text: "Recovering" });
  }
  if (card.staleEvidence) {
    facts.push({ key: "stale", text: "Stale evidence" });
  }
  if (card.lastMeaningfulActivityAt !== null) {
    facts.push({ key: "activity", text: activityLabel(card.lastMeaningfulActivityAt) });
  }
  return facts;
}

/**
 * The card face: what needs the person, who is running the task, and when it
 * last moved. Everything else waits in the list view's facts.
 */
function cardSummary(
  card: WorkBoardCard,
  providerLabel: string | undefined,
  waitingReason: string | undefined,
): ReadonlyArray<CardFact<ReactNode>> {
  const facts: CardFact<ReactNode>[] = [];
  if (waitingReason !== undefined) facts.push({ key: "waiting", text: waitingReason });
  if (card.activeRequest.kind === "pending") {
    facts.push({
      key: "request",
      text:
        card.activeRequest.requestKind === "approval"
          ? `Approval: ${card.activeRequest.summary}`
          : `Input: ${card.activeRequest.summary}`,
      className: "fact warn",
    });
  }
  if (card.followUp) facts.push({ key: "follow-up", text: "Follow-up", className: "fact warn" });
  if (card.recovery.kind === "recovering") facts.push({ key: "recovery", text: "Recovering" });
  if (card.goal.kind === "present") facts.push({ key: "goal", text: `Goal · ${card.goal.status}` });
  if (providerLabel !== undefined) facts.push({ key: "provider", text: providerLabel });
  if (card.lastMeaningfulActivityAt !== null) {
    facts.push({
      key: "activity-at",
      text: relativeTimeLabel(card.lastMeaningfulActivityAt),
      title: absoluteTimeFormatter.format(new Date(card.lastMeaningfulActivityAt)),
    });
  }
  return facts;
}

function cardDetailRows(
  card: WorkBoardCard,
  projectName: string | undefined,
  providerLabel: string | undefined,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const rows: Array<{ readonly label: string; readonly value: string }> = [];
  if (projectName !== undefined) rows.push({ label: "Project", value: projectName });
  if (card.binding.kind === "bound") {
    rows.push({ label: "Working directory", value: card.binding.workingDirectory });
    if (card.binding.bindingRevisionId !== undefined) {
      rows.push({ label: "Binding revision", value: String(card.binding.bindingRevisionId) });
    }
  }
  rows.push({
    label: "Provider",
    value: providerLabel === undefined ? String(card.providerInstanceId) : providerLabel,
  });
  rows.push({ label: "Model", value: card.modelId });
  rows.push({
    label: "Delivery",
    value: `${card.deliveryTarget} · ${card.deliverySatisfaction}`,
  });
  rows.push({ label: "Reason", value: workBoardStatusReasonLabel(card.statusReason) });
  if (card.activeRequest.kind === "pending") {
    rows.push({ label: "Active request", value: card.activeRequest.summary });
  }
  if (card.goal.kind === "present") {
    rows.push({ label: "Goal", value: `${card.goal.status} · ${card.goal.objective}` });
  }
  if (card.childRuns.latestSummary !== undefined) {
    rows.push({ label: "Latest child run", value: card.childRuns.latestSummary });
  }
  if (card.lastMeaningfulActivityAt !== null) {
    rows.push({
      label: "Last activity",
      value: new Date(String(card.lastMeaningfulActivityAt)).toLocaleString(),
    });
  }
  return rows;
}

function buildQuery(filters: FilterState): WorkBoardQuery {
  const query: {
    version: 1;
    text?: string;
    statuses?: WorkBoardStatus[];
    projectIds?: ProjectId[];
    followUp?: FilterState["followUp"];
    pendingRequest?: FilterState["pendingRequest"];
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
  if (filters.pendingRequest !== "any") query.pendingRequest = filters.pendingRequest;
  return query as WorkBoardQuery;
}

function toggleStatus(prev: FilterState, status: WorkBoardStatus, checked: boolean): FilterState {
  const statuses = new Set(prev.statuses);
  if (checked) statuses.add(status);
  else statuses.delete(status);
  if (statuses.size === 0) return { ...prev, statuses: new Set(ALL_STATUSES) };
  return { ...prev, statuses };
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
  if (filters.pendingRequest !== "any") {
    active.push({
      kind: "pending-request",
      label: filters.pendingRequest === "only" ? "Pending request only" : "No pending request",
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
    active.push(
      `status ${ALL_STATUSES.filter((status) => filters.statuses.has(status))
        .map(workBoardStatusLabel)
        .join(", ")}`,
    );
  }
  if (filters.projectIds.size > 0) active.push("a Project");
  if (filters.pendingRequest !== "any") active.push(`pending request ${filters.pendingRequest}`);
  if (filters.followUp !== "any") active.push(`follow-up ${filters.followUp}`);
  return active.length === 0 ? "No filters are active." : `Active filters: ${active.join("; ")}.`;
}

function recoveryReasonLabel(reason: WorkBoardRecoveryReason): string {
  return reason === "project-projection-missing"
    ? "Project projection missing"
    : "Binding revision mismatch";
}
