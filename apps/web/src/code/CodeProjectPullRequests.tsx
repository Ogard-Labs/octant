import type {
  CodeProjectPullRequestBackgroundRefreshState,
  CodeProjectPullRequestConnection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestView,
  ProjectId,
} from "@octant/contracts";
import {
  Check,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link2,
  ListFilter,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import {
  defaultBoardStorage,
  readStoredValue,
  writeStoredValue,
} from "../threadBoard/threadBoardState";
import { Surface, SurfaceEmpty, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantBadge, type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuRoot,
  OctantMenuSeparator,
} from "../ui/base/OctantMenu";
import { OctantTooltip } from "../ui/base/OctantTooltip";
import {
  WorkList,
  WorkListGroup,
  WorkListMenuTrigger,
  WorkListRow,
  WorkListSortMenu,
  type WorkListState,
} from "../surface/WorkList";
import { relativeTimeLabel } from "../lib/relativeTime";
import { OctantAlert } from "../ui/base/OctantAlert";
import {
  NO_PULL_REQUEST_FILTERS,
  PULL_REQUEST_CHECKS_OPTIONS,
  PULL_REQUEST_REVIEW_OPTIONS,
  PULL_REQUEST_SORT_OPTIONS,
  PULL_REQUEST_STATE_OPTIONS,
  activeFilterCount,
  blockingFact,
  filterPullRequests,
  groupPullRequestsByRepository,
  mergeabilityCopy,
  pullRequestAttention,
  pullRequestStatusSentence,
  reviewCopy,
  sortPullRequests,
  type PullRequestChecksFilter,
  type PullRequestFilters,
  type PullRequestReviewFilter,
  type PullRequestSort,
  type PullRequestStateFilter,
} from "./pullRequestListView";

export { mergeabilityCopy, reviewCopy };

const SORT_STORAGE_KEY = "octant.code.pull-requests.sort";
const GROUP_STORAGE_KEY = "octant.code.pull-requests.group-by-repository";
const STATE_STORAGE_KEY = "octant.code.pull-requests.filter-state";
const REVIEW_STORAGE_KEY = "octant.code.pull-requests.filter-review";
const CHECKS_STORAGE_KEY = "octant.code.pull-requests.filter-checks";

function oneOf<T extends string>(options: ReadonlyArray<{ readonly value: T }>) {
  return (value: string): T | undefined => options.find((option) => option.value === value)?.value;
}

interface ProjectSetting {
  readonly enabledFor: (projectId: ProjectId) => boolean;
  readonly setEnabled: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
}

/** The two agent permissions that sit beside Agents may merge in a Project's menu. */
interface AgentForgeChoices {
  readonly comments: ProjectSetting;
  readonly defaultBranchPush: ProjectSetting;
}

export interface CodeProjectPullRequestsProps {
  readonly load: (query: CodeProjectPullRequestQuery) => Promise<CodeProjectPullRequestView>;
  readonly refresh: (
    command: CodeProjectPullRequestRefreshCommand,
  ) => Promise<CodeProjectPullRequestView>;
  readonly onClose?: () => void;
  readonly isNarrow?: boolean;
  readonly selectedRowKey?: string;
  readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
  /**
   * The dock lists one thread's Project under the dock's own head; the page
   * keeps its Surface shell, sorting, grouping, and the Project's settings.
   */
  readonly presentation?: "page" | "dock";
  /**
   * Show only this Project's connection and rows. The dock scopes the list to
   * the Project the active thread belongs to, so it never reports another
   * Project's refresh as this one's.
   */
  readonly projectId?: ProjectId;
  /**
   * Present when the shell can toggle the opt-in background refresh for a
   * Project. The server owns the setting; this only issues the command.
   */
  readonly backgroundRefresh?: ProjectSetting;
  /**
   * Present on a local window, which alone may let a Project's agents merge
   * without asking each time. The server owns the setting and refuses a paired
   * device.
   */
  readonly agentMerge?: ProjectSetting;
  /**
   * Present with `agentMerge`, under the same rule: whether agents below Full
   * access may comment without asking for each post, and whether an ordinary
   * push may reach the default branch. The server owns both and refuses a
   * paired device.
   */
  readonly agentForgeChoices?: AgentForgeChoices;
  /** Injectable for tests; defaults to `window.localStorage` when available. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

type WorkspaceState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestView }
  | { readonly status: "refreshing"; readonly view: CodeProjectPullRequestView }
  | {
      readonly status: "error";
      readonly message: string;
      readonly view?: CodeProjectPullRequestView;
    };

export function CodeProjectPullRequests(props: CodeProjectPullRequestsProps) {
  const [workspace, setWorkspace] = useState<WorkspaceState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const storage = props.storage ?? defaultBoardStorage();
  const [sort, setSort] = useState<PullRequestSort>(
    () => readStoredValue(storage, SORT_STORAGE_KEY, oneOf(PULL_REQUEST_SORT_OPTIONS)) ?? "updated",
  );
  const [grouped, setGrouped] = useState<boolean>(
    () => readStoredValue(storage, GROUP_STORAGE_KEY, (value) => value) === "true",
  );
  const [filters, setFilters] = useState<PullRequestFilters>(() => ({
    state: readStoredValue(storage, STATE_STORAGE_KEY, oneOf(PULL_REQUEST_STATE_OPTIONS)) ?? "any",
    review:
      readStoredValue(storage, REVIEW_STORAGE_KEY, oneOf(PULL_REQUEST_REVIEW_OPTIONS)) ?? "any",
    checks:
      readStoredValue(storage, CHECKS_STORAGE_KEY, oneOf(PULL_REQUEST_CHECKS_OPTIONS)) ?? "any",
  }));
  const searchInput = useRef<HTMLInputElement>(null);
  const loadRef = useRef(props.load);
  useEffect(() => {
    loadRef.current = props.load;
  });

  useEffect(() => {
    let active = true;
    loadRef.current({ version: 1 }).then(
      (view) => {
        if (active) setWorkspace({ status: "ready", view });
      },
      () => {
        if (active) {
          setWorkspace({ status: "error", message: "The pull-request list could not be read." });
        }
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function runRefresh(command: CodeProjectPullRequestRefreshCommand): Promise<void> {
    setWorkspace((previous) => {
      const view =
        previous.status === "ready" || previous.status === "refreshing"
          ? previous.view
          : previous.status === "error"
            ? previous.view
            : undefined;
      return view === undefined ? { status: "loading" } : { status: "refreshing", view };
    });
    try {
      const view = await props.refresh(command);
      setWorkspace({ status: "ready", view });
    } catch {
      setWorkspace((previous) => ({
        status: "error",
        message: "The pull-request list could not be refreshed.",
        ...(previous.status === "ready" || previous.status === "refreshing"
          ? { view: previous.view }
          : previous.status === "error" && previous.view !== undefined
            ? { view: previous.view }
            : {}),
      }));
    }
  }

  function chooseSort(next: PullRequestSort): void {
    setSort(next);
    writeStoredValue(storage, SORT_STORAGE_KEY, next);
  }

  function chooseGrouped(next: boolean): void {
    setGrouped(next);
    writeStoredValue(storage, GROUP_STORAGE_KEY, String(next));
  }

  function chooseFilters(next: PullRequestFilters): void {
    setFilters(next);
    writeStoredValue(storage, STATE_STORAGE_KEY, next.state);
    writeStoredValue(storage, REVIEW_STORAGE_KEY, next.review);
    writeStoredValue(storage, CHECKS_STORAGE_KEY, next.checks);
  }

  const view =
    workspace.status === "ready" || workspace.status === "refreshing"
      ? workspace.view
      : workspace.status === "error"
        ? workspace.view
        : undefined;
  const dock = props.presentation === "dock";
  const projectId = props.projectId;
  const busy = workspace.status === "loading" || workspace.status === "refreshing";
  const scopedProjects =
    view === undefined
      ? []
      : projectId === undefined
        ? view.projects
        : view.projects.filter((project) => String(project.projectId) === String(projectId));
  // The dock speaks about one Project, so its freshness is that Project's, not
  // the newest refresh anywhere in the snapshot.
  const scopedFreshness =
    view === undefined || projectId === undefined
      ? view?.freshness
      : projectFreshnessFor(view, projectId);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const scopedRows =
    view?.rows.filter(
      (row) => projectId === undefined || String(row.projectId) === String(projectId),
    ) ?? [];
  // The dock lists one Project's rows in the page's default order; sorting,
  // grouping and filtering are the page's. So the dock counts no filter either:
  // counting the page's saved ones, an empty dock said nothing matched "these
  // filters" and offered to clear them, which could show no row and erased the
  // page's choices.
  const filterCount = dock ? 0 : activeFilterCount(filters);
  const visibleRows = sortPullRequests(
    filterPullRequests(
      scopedRows.filter((row) => pullRequestMatches(row, normalizedSearch)),
      dock ? NO_PULL_REQUEST_FILTERS : filters,
    ),
    dock ? "updated" : sort,
  );
  const freshnessStatus = scopedFreshness?.status ?? "loading";
  const hasProjects = scopedProjects.length > 0;
  // With no Project on GitHub there is nothing to refresh or search; saying
  // "Refresh to load" beside "No github.com origin" contradicted itself.
  const onGitHub = scopedProjects.some((project) => project.kind === "connected");
  const ready = view !== undefined && hasProjects && onGitHub;
  const connectedProjects = scopedProjects.filter(
    (project): project is Extract<CodeProjectPullRequestConnection, { kind: "connected" }> =>
      project.kind === "connected",
  );
  const unconnectedProjects = scopedProjects.filter((project) => project.kind === "unconnected");
  const countCopy =
    view === undefined
      ? undefined
      : pullRequestCountCopy(scopedFreshness ?? view.freshness, visibleRows.length);

  const searchField = (
    <label className="surface-toolbar__search code-project-pull-requests__search">
      <Search aria-hidden="true" size={14} strokeWidth={1.7} />
      <span className="sr-only">Search pull requests</span>
      <OctantInput
        aria-label="Search pull requests"
        onChange={(event) => setSearch(event.currentTarget.value)}
        placeholder="Search pull requests"
        ref={searchInput}
        type="search"
        value={search}
      />
      {search === "" ? null : (
        <OctantButton
          aria-label="Clear pull-request search"
          className="code-project-pull-requests__search-clear"
          onClick={() => {
            setSearch("");
            searchInput.current?.focus();
          }}
          type="button"
          variant="ghost"
        >
          <X aria-hidden="true" size={14} strokeWidth={1.7} />
        </OctantButton>
      )}
    </label>
  );

  const showGroups = grouped && !dock;
  const groups = showGroups ? groupPullRequestsByRepository(visibleRows) : [];
  // A connected Project with nothing to list still gets its group when grouping
  // is on, so its settings stay reachable and its empty state is told.
  const emptyConnected = showGroups
    ? connectedProjects.filter(
        (project) => !groups.some((group) => String(group.projectId) === String(project.projectId)),
      )
    : [];
  // Several repositories on one ungrouped list would read alike by bare name
  // (a/app, b/app), so the owner is named; a group head already says it.
  const qualifyRepository =
    !showGroups &&
    new Set(scopedRows.map((row) => `${row.repositoryOwner}/${row.repositoryName}`)).size > 1;
  const neverRefreshed = showGroups
    ? []
    : connectedProjects.filter((project) => {
        if (view === undefined) return false;
        const freshness = projectFreshnessFor(view, project.projectId);
        return (
          freshness.status === "empty" &&
          freshness.lastSuccessfulRefreshAt === undefined &&
          !scopedRows.some((row) => String(row.projectId) === String(project.projectId))
        );
      });
  const backgroundNotes =
    view === undefined || dock
      ? []
      : connectedProjects.flatMap((project) => {
          const copy = backgroundRefreshCopy(backgroundRefreshStateFor(view, project.projectId));
          return copy === undefined ? [] : [{ project, copy }];
        });

  const body = (
    <div
      className="code-project-pull-requests"
      data-freshness={freshnessStatus}
      data-narrow={props.isNarrow === true ? "true" : "false"}
      data-presentation={dock ? "dock" : "page"}
    >
      {!ready ? null : dock ? (
        <div className="surface-toolbar">
          {searchField}
          <span
            className="oct-meta code-project-pull-requests__count"
            data-freshness={scopedFreshness?.status}
          >
            {countCopy}
          </span>
        </div>
      ) : (
        <div className="surface-toolbar">{searchField}</div>
      )}

      {workspace.status === "loading" ? (
        <ShellState
          eyebrow="Pull requests"
          message="Open and draft pull requests will list here."
          state="loading"
          title="Loading pull requests"
        />
      ) : null}

      {view === undefined ? (
        workspace.status === "error" ? (
          <OctantAlert className="code-project-pull-requests__status" tone="warning">
            {workspace.message}
          </OctantAlert>
        ) : null
      ) : !hasProjects ? (
        dock ? (
          <SurfaceEmpty
            detail="Only a Code Project with a github.com origin lists pull requests."
            icon={<GitPullRequest size={20} strokeWidth={1.5} />}
            title="No pull-request source for this Project"
          />
        ) : (
          <SurfaceEmpty
            detail="Add a Code Project to see pull requests here."
            icon={<GitPullRequest size={20} strokeWidth={1.5} />}
            title="No Code Projects yet"
          />
        )
      ) : !onGitHub ? (
        <SurfaceEmpty
          action={
            <OctantButton
              disabled={busy}
              onClick={() =>
                void runRefresh(
                  projectId === undefined
                    ? { kind: "refresh-all" }
                    : { kind: "refresh-project", projectId },
                )
              }
              size="sm"
              type="button"
              variant="outline"
            >
              Check again
            </OctantButton>
          }
          detail="Pull requests show up here once a Project's Git remote points at github.com. Add one, then check again."
          icon={<GitPullRequest size={20} strokeWidth={1.5} />}
          title={dock ? "This Project isn't on GitHub" : "None of your Code Projects is on GitHub"}
        />
      ) : null}
      {view !== undefined && hasProjects && !onGitHub && workspace.status === "error" ? (
        // A check that failed must not read as "still not on GitHub".
        <OctantAlert className="code-project-pull-requests__status" tone="warning">
          {workspace.message}
        </OctantAlert>
      ) : null}
      {view === undefined || !ready ? null : (
        <>
          <p
            className="code-project-pull-requests__status"
            data-state={scopedFreshness?.status}
            role="status"
          >
            {freshnessCopy(scopedFreshness ?? view.freshness)}
            {truncationCopy(view, dock)}
          </p>
          {workspace.status === "error" ? (
            <OctantAlert className="code-project-pull-requests__status" tone="warning">
              {workspace.message}
            </OctantAlert>
          ) : null}
          {showGroups
            ? null
            : backgroundNotes.map(({ project, copy }) => (
                <p
                  className="code-project-pull-requests__status"
                  key={String(project.projectId)}
                  role="status"
                >
                  {project.projectName}: {copy}
                </p>
              ))}
          {visibleRows.length === 0 && normalizedSearch !== "" ? (
            <SurfaceEmpty
              action={
                <OctantButton
                  onClick={() => setSearch("")}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Clear search
                </OctantButton>
              }
              title={`No pull requests match “${search.trim()}”`}
            />
          ) : null}
          {visibleRows.length === 0 && normalizedSearch === "" && filterCount > 0 ? (
            <SurfaceEmpty
              action={
                <OctantButton
                  onClick={() => chooseFilters(NO_PULL_REQUEST_FILTERS)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Clear filters
                </OctantButton>
              }
              title="No pull requests match these filters"
            />
          ) : null}
          {visibleRows.length === 0 &&
          normalizedSearch === "" &&
          filterCount === 0 &&
          !showGroups ? (
            <p className="code-project-pull-requests__empty">
              {listEmptyCopy(scopedFreshness ?? view.freshness)}
            </p>
          ) : null}
          {showGroups ? (
            <div className="work-list__groups">
              {groups.map((group) => (
                <RepositoryGroup
                  busy={busy}
                  key={group.key}
                  onRefresh={() =>
                    void runRefresh({ kind: "refresh-project", projectId: group.projectId })
                  }
                  onSelectRow={props.onSelectRow}
                  project={connectedProjects.find(
                    (project) => String(project.projectId) === String(group.projectId),
                  )}
                  rows={group.rows}
                  selectedRowKey={props.selectedRowKey}
                  title={`${group.owner}/${group.name}`}
                  {...(props.backgroundRefresh === undefined
                    ? {}
                    : { backgroundRefresh: props.backgroundRefresh })}
                  {...(props.agentMerge === undefined ? {} : { agentMerge: props.agentMerge })}
                  {...(props.agentForgeChoices === undefined
                    ? {}
                    : { agentForgeChoices: props.agentForgeChoices })}
                  {...settingsNote(view, group.projectId)}
                />
              ))}
              {emptyConnected.map((project) => (
                <RepositoryGroup
                  busy={busy}
                  emptyCopy={
                    normalizedSearch !== "" || filterCount > 0
                      ? "Nothing matches"
                      : projectEmptyCopy(projectFreshnessFor(view, project.projectId))
                  }
                  key={String(project.projectId)}
                  onRefresh={() =>
                    void runRefresh({ kind: "refresh-project", projectId: project.projectId })
                  }
                  onSelectRow={props.onSelectRow}
                  project={project}
                  rows={[]}
                  selectedRowKey={props.selectedRowKey}
                  title={`${project.repositoryOwner}/${project.repositoryName}`}
                  {...(props.backgroundRefresh === undefined
                    ? {}
                    : { backgroundRefresh: props.backgroundRefresh })}
                  {...(props.agentMerge === undefined ? {} : { agentMerge: props.agentMerge })}
                  {...(props.agentForgeChoices === undefined
                    ? {}
                    : { agentForgeChoices: props.agentForgeChoices })}
                  {...settingsNote(view, project.projectId)}
                />
              ))}
            </div>
          ) : visibleRows.length === 0 ? null : (
            <PullRequestRows
              onSelectRow={props.onSelectRow}
              qualifyRepository={qualifyRepository}
              rows={visibleRows}
              selectedRowKey={props.selectedRowKey}
            />
          )}
          {neverRefreshed.length === 0 ? null : (
            <p className="code-project-pull-requests__notice">
              Not refreshed yet: {neverRefreshed.map((project) => project.projectName).join(", ")}.
            </p>
          )}
          {dock || unconnectedProjects.length === 0 ? null : (
            <details className="code-project-pull-requests__notice" role="note">
              <summary>
                {unconnectedProjects.length === 1
                  ? "1 Project is not on GitHub"
                  : `${String(unconnectedProjects.length)} Projects are not on GitHub`}
              </summary>
              <span>{unconnectedProjects.map((project) => project.projectName).join(", ")}</span>
            </details>
          )}
        </>
      )}
    </div>
  );

  if (dock) return body;

  return (
    <Surface ariaLabel="Pull requests" className="code-project-pull-requests-surface">
      <SurfaceHeader
        {...(ready && countCopy !== undefined ? { detail: countCopy } : {})}
        title="Pull requests"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
        {...(ready
          ? {
              actions: (
                <>
                  <WorkListSortMenu
                    grouped={grouped}
                    label="Sort pull requests"
                    onGroupedChange={chooseGrouped}
                    onValueChange={chooseSort}
                    options={PULL_REQUEST_SORT_OPTIONS}
                    value={sort}
                  />
                  <FilterMenu filters={filters} onChange={chooseFilters} />
                  {grouped ? null : (
                    <RepositorySettingsMenu
                      busy={busy}
                      onRefresh={(project) =>
                        void runRefresh({ kind: "refresh-project", projectId: project.projectId })
                      }
                      projects={connectedProjects}
                      {...(props.backgroundRefresh === undefined
                        ? {}
                        : { backgroundRefresh: props.backgroundRefresh })}
                      {...(props.agentMerge === undefined ? {} : { agentMerge: props.agentMerge })}
                      {...(props.agentForgeChoices === undefined
                        ? {}
                        : { agentForgeChoices: props.agentForgeChoices })}
                    />
                  )}
                  <OctantTooltip label="Refresh all pull requests">
                    <OctantButton
                      aria-label="Refresh all"
                      className="work-list__icon-button"
                      disabled={busy}
                      onClick={() => void runRefresh({ kind: "refresh-all" })}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <RefreshCw aria-hidden="true" size={16} strokeWidth={1.5} />
                    </OctantButton>
                  </OctantTooltip>
                </>
              ),
            }
          : {})}
      />
      {body}
    </Surface>
  );

  function settingsNote(
    snapshot: CodeProjectPullRequestView,
    id: CodeProjectPullRequestConnection["projectId"],
  ): { readonly backgroundRefreshState?: CodeProjectPullRequestBackgroundRefreshState } {
    const state = backgroundRefreshStateFor(snapshot, id);
    return state === undefined ? {} : { backgroundRefreshState: state };
  }
}

function FilterMenu(props: {
  readonly filters: PullRequestFilters;
  readonly onChange: (filters: PullRequestFilters) => void;
}) {
  const count = activeFilterCount(props.filters);
  return (
    <OctantMenuRoot>
      <WorkListMenuTrigger
        active={count > 0}
        label={
          count === 0 ? "Filter pull requests" : `Filter pull requests, ${String(count)} active`
        }
        tooltip="Filter"
      >
        <ListFilter aria-hidden="true" size={16} strokeWidth={1.5} />
      </WorkListMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
          <OctantMenuPopup aria-label="Filter pull requests" className="min-w-56">
            <FilterGroup<PullRequestStateFilter>
              label="State"
              onChange={(state) => props.onChange({ ...props.filters, state })}
              options={PULL_REQUEST_STATE_OPTIONS}
              value={props.filters.state}
            />
            <OctantMenuSeparator />
            <FilterGroup<PullRequestReviewFilter>
              label="Review"
              onChange={(review) => props.onChange({ ...props.filters, review })}
              options={PULL_REQUEST_REVIEW_OPTIONS}
              value={props.filters.review}
            />
            <OctantMenuSeparator />
            <FilterGroup<PullRequestChecksFilter>
              label="Checks"
              onChange={(checks) => props.onChange({ ...props.filters, checks })}
              options={PULL_REQUEST_CHECKS_OPTIONS}
              value={props.filters.checks}
            />
            {count === 0 ? null : (
              <>
                <OctantMenuSeparator />
                <OctantMenuItem onClick={() => props.onChange(NO_PULL_REQUEST_FILTERS)}>
                  Clear filters
                </OctantMenuItem>
              </>
            )}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function FilterGroup<T extends string>(props: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (value: T) => void;
}) {
  return (
    <OctantMenuGroup>
      <OctantMenuGroupLabel>{props.label}</OctantMenuGroupLabel>
      <OctantMenuRadioGroup
        onValueChange={(value) => {
          const next = oneOf(props.options)(String(value));
          if (next !== undefined) props.onChange(next);
        }}
        value={props.value}
      >
        {props.options.map((option) => (
          <OctantMenuRadioItem
            closeOnClick={false}
            key={option.value}
            label={option.label}
            value={option.value}
          >
            {option.label}
          </OctantMenuRadioItem>
        ))}
      </OctantMenuRadioGroup>
    </OctantMenuGroup>
  );
}

/**
 * What the heavy Project header used to hold, for one Project: the two
 * switches that change what the host does on its own, and a refresh. They are
 * checked items rather than switches, with the same names and the same setters;
 * the server still owns both settings and refuses a device that may not set
 * them.
 */
function ProjectSettingsItems(props: {
  readonly project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly backgroundRefresh?: ProjectSetting;
  readonly agentMerge?: ProjectSetting;
  readonly agentForgeChoices?: AgentForgeChoices;
}) {
  const { project } = props;
  return (
    <>
      {props.backgroundRefresh === undefined ? null : (
        <OctantMenuCheckboxItem
          aria-label={`Auto-refresh ${project.projectName} pull requests`}
          checked={props.backgroundRefresh.enabledFor(project.projectId)}
          closeOnClick={false}
          disabled={props.busy}
          label="Auto-refresh"
          onCheckedChange={(enabled) =>
            void props.backgroundRefresh?.setEnabled(project.projectId, enabled)
          }
        >
          Auto-refresh
        </OctantMenuCheckboxItem>
      )}
      {props.agentMerge === undefined ? null : (
        <OctantMenuCheckboxItem
          aria-label={`Let agents merge ${project.projectName} pull requests`}
          checked={props.agentMerge.enabledFor(project.projectId)}
          // One activation, one change: a menu left open under the pointer let a
          // second Enter flip the permission straight back. Auto-refresh stays open
          // because it is not an authority and its check shows the change.
          closeOnClick
          disabled={props.busy}
          label="Agents may merge"
          onCheckedChange={(enabled) =>
            void props.agentMerge?.setEnabled(project.projectId, enabled)
          }
        >
          Agents may merge
        </OctantMenuCheckboxItem>
      )}
      {props.agentForgeChoices === undefined ? null : (
        <>
          <OctantMenuCheckboxItem
            aria-label={`Let agents comment on ${project.projectName} pull requests`}
            checked={props.agentForgeChoices.comments.enabledFor(project.projectId)}
            // An authority closes on one activation, as Agents may merge does.
            closeOnClick
            disabled={props.busy}
            label="Agents may comment on pull requests"
            onCheckedChange={(enabled) =>
              void props.agentForgeChoices?.comments.setEnabled(project.projectId, enabled)
            }
          >
            Agents may comment on pull requests
          </OctantMenuCheckboxItem>
          <OctantMenuCheckboxItem
            aria-label={`Let agents push to the default branch of ${project.projectName}`}
            checked={props.agentForgeChoices.defaultBranchPush.enabledFor(project.projectId)}
            closeOnClick
            disabled={props.busy}
            label="Agents may push to the default branch"
            onCheckedChange={(enabled) =>
              void props.agentForgeChoices?.defaultBranchPush.setEnabled(project.projectId, enabled)
            }
          >
            Agents may push to the default branch
          </OctantMenuCheckboxItem>
        </>
      )}
      <OctantMenuItem
        aria-label={`Refresh ${project.projectName}`}
        disabled={props.busy}
        onClick={props.onRefresh}
      >
        Refresh
      </OctantMenuItem>
    </>
  );
}

/** The ungrouped page's way to each Project's settings: one group per Project. */
function RepositorySettingsMenu(props: {
  readonly projects: ReadonlyArray<
    Extract<CodeProjectPullRequestConnection, { kind: "connected" }>
  >;
  readonly busy: boolean;
  readonly onRefresh: (
    project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }>,
  ) => void;
  readonly backgroundRefresh?: ProjectSetting;
  readonly agentMerge?: ProjectSetting;
  readonly agentForgeChoices?: AgentForgeChoices;
}) {
  // A permission someone gave is read off the closed button, not found in the menu.
  const mergeRepositories = props.projects
    .filter((project) => props.agentMerge?.enabledFor(project.projectId) === true)
    .map((project) => `${project.repositoryOwner}/${project.repositoryName}`);
  return (
    <OctantMenuRoot>
      <WorkListMenuTrigger
        active={mergeRepositories.length > 0}
        label={
          mergeRepositories.length === 0
            ? "Repository settings"
            : `Repository settings, agents may merge in ${mergeRepositories.join(", ")}`
        }
        tooltip={
          mergeRepositories.length === 0
            ? "Repository settings"
            : `Repository settings. Agents may merge in ${mergeRepositories.join(", ")}`
        }
      >
        <Settings2 aria-hidden="true" size={16} strokeWidth={1.5} />
      </WorkListMenuTrigger>
      <OctantMenuPortal>
        <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
          <OctantMenuPopup aria-label="Repository settings" className="min-w-56">
            {props.projects.map((project, index) => (
              <div key={String(project.projectId)}>
                {index === 0 ? null : <OctantMenuSeparator />}
                <OctantMenuGroup>
                  <OctantMenuGroupLabel>
                    {project.repositoryOwner}/{project.repositoryName}
                  </OctantMenuGroupLabel>
                  <ProjectSettingsItems
                    busy={props.busy}
                    onRefresh={() => props.onRefresh(project)}
                    project={project}
                    {...(props.backgroundRefresh === undefined
                      ? {}
                      : { backgroundRefresh: props.backgroundRefresh })}
                    {...(props.agentMerge === undefined ? {} : { agentMerge: props.agentMerge })}
                    {...(props.agentForgeChoices === undefined
                      ? {}
                      : { agentForgeChoices: props.agentForgeChoices })}
                  />
                </OctantMenuGroup>
              </div>
            ))}
          </OctantMenuPopup>
        </OctantMenuPositioner>
      </OctantMenuPortal>
    </OctantMenuRoot>
  );
}

function RepositoryGroup(props: {
  readonly title: string;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly project: Extract<CodeProjectPullRequestConnection, { kind: "connected" }> | undefined;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly emptyCopy?: string;
  readonly selectedRowKey: string | undefined;
  readonly onSelectRow: ((row: CodeProjectPullRequestRow) => void) | undefined;
  readonly backgroundRefresh?: ProjectSetting;
  readonly backgroundRefreshState?: CodeProjectPullRequestBackgroundRefreshState;
  readonly agentMerge?: ProjectSetting;
  readonly agentForgeChoices?: AgentForgeChoices;
}) {
  const note = backgroundRefreshCopy(props.backgroundRefreshState);
  // A permission someone gave is read off the header, not found in a menu.
  const agentsMayMerge =
    props.project !== undefined && props.agentMerge?.enabledFor(props.project.projectId) === true;
  return (
    <WorkListGroup
      count={props.rows.length}
      marks={agentsMayMerge ? <StatusChip label="Agents may merge" status="neutral" /> : null}
      menu={
        props.project === undefined ? undefined : (
          <OctantMenuRoot>
            <WorkListMenuTrigger label={`${props.title} settings`} tooltip="Repository settings">
              <MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.5} />
            </WorkListMenuTrigger>
            <OctantMenuPortal>
              <OctantMenuPositioner align="end" className="z-50 outline-none window-no-drag">
                <OctantMenuPopup aria-label={`${props.title} settings`} className="min-w-56">
                  <OctantMenuGroup>
                    <OctantMenuGroupLabel>{props.title}</OctantMenuGroupLabel>
                    <ProjectSettingsItems
                      busy={props.busy}
                      onRefresh={props.onRefresh}
                      project={props.project}
                      {...(props.backgroundRefresh === undefined
                        ? {}
                        : { backgroundRefresh: props.backgroundRefresh })}
                      {...(props.agentMerge === undefined ? {} : { agentMerge: props.agentMerge })}
                      {...(props.agentForgeChoices === undefined
                        ? {}
                        : { agentForgeChoices: props.agentForgeChoices })}
                    />
                  </OctantMenuGroup>
                </OctantMenuPopup>
              </OctantMenuPositioner>
            </OctantMenuPortal>
          </OctantMenuRoot>
        )
      }
      title={props.title}
    >
      {note === undefined ? null : (
        <p className="code-project-pull-requests__status" role="status">
          {note}
        </p>
      )}
      {props.rows.length === 0 ? (
        props.emptyCopy === undefined ? null : (
          <p className="code-project-pull-requests__empty">{props.emptyCopy}</p>
        )
      ) : (
        <PullRequestRows
          onSelectRow={props.onSelectRow}
          qualifyRepository={false}
          rows={props.rows}
          selectedRowKey={props.selectedRowKey}
        />
      )}
    </WorkListGroup>
  );
}

function PullRequestRows(props: {
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly selectedRowKey: string | undefined;
  readonly onSelectRow: ((row: CodeProjectPullRequestRow) => void) | undefined;
  /** Name the owner too: the list spans repositories and no group head says it. */
  readonly qualifyRepository: boolean;
}) {
  // One callback for every row, so a parent render with the same rows does not
  // hand each of them a new function and render them all again.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const select = useCallback((key: string) => {
    const row = latest.current.rows.find((candidate) => projectPullRequestKey(candidate) === key);
    if (row !== undefined) latest.current.onSelectRow?.(row);
  }, []);
  return (
    <WorkList>
      {props.rows.map((row) => {
        const rowKey = projectPullRequestKey(row);
        return (
          <li key={rowKey}>
            <PullRequestRow
              onSelect={select}
              qualifyRepository={props.qualifyRepository}
              row={row}
              rowKey={rowKey}
              selected={props.selectedRowKey === rowKey}
            />
          </li>
        );
      })}
    </WorkList>
  );
}

function stateGlyph(row: CodeProjectPullRequestRow): WorkListState {
  if (row.state === "merged") return { label: "Merged", tone: "merged", Icon: GitMerge };
  if (row.state === "closed") {
    return { label: "Closed", tone: "closed", Icon: GitPullRequestClosed };
  }
  if (row.draft) return { label: "Draft", tone: "draft", Icon: GitPullRequestDraft };
  return { label: "Open", tone: "open", Icon: GitPullRequest };
}

/** A pull request in the shared row: what needs attention goes at the title's edge. */
const PullRequestRow = memo(function PullRequestRow(props: {
  readonly row: CodeProjectPullRequestRow;
  readonly rowKey: string;
  readonly selected: boolean;
  readonly qualifyRepository: boolean;
  readonly onSelect: (key: string) => void;
}) {
  const { row } = props;
  const attention = pullRequestAttention(row);
  const sentence = pullRequestStatusSentence(row);
  const branches = `${row.headBranch} → ${row.baseBranch}`;
  const resolved = attention === undefined && row.mergeability === "mergeable";
  const linked = row.linkedThreads.map((thread) => thread.title).join(", ");
  return (
    <WorkListRow
      author={row.author}
      // The branches and every fact the one word leaves out are text for a
      // screen reader, and the whole row opens them as a tooltip on hover and
      // on keyboard focus, so none of it is pointer-only.
      description={`${sentence} ${branches}.`}
      extras={
        row.linkedThreads.length === 0 ? null : (
          <span className="work-list__linked" title={`Linked: ${linked}`}>
            <Link2 aria-hidden="true" size={12} strokeWidth={1.7} />
            <span className="sr-only">Linked: {linked}</span>
          </span>
        )
      }
      id={props.rowKey}
      number={row.number}
      onSelect={props.onSelect}
      repository={
        props.qualifyRepository
          ? `${row.repositoryOwner}/${row.repositoryName}`
          : row.repositoryName
      }
      selected={props.selected}
      selection="pressed"
      state={stateGlyph(row)}
      title={row.title}
      tooltip={
        <span className="work-list__tooltip">
          <span>{sentence}</span>
          <span>{branches}</span>
        </span>
      }
      trailing={
        <>
          {attention === undefined ? null : (
            <span aria-hidden="true">
              <StatusChip label={attention.label} status={attention.tone} />
            </span>
          )}
          {resolved ? (
            <Check aria-hidden="true" className="work-list__ok" size={14} strokeWidth={1.8} />
          ) : null}
        </>
      }
      updatedAt={row.updatedAt}
    />
  );
});

export function StatusChip(props: {
  readonly label: string;
  readonly status: "positive" | "warning" | "negative" | "neutral";
}) {
  const variant: OctantBadgeProps["variant"] =
    props.status === "positive"
      ? "success"
      : props.status === "warning"
        ? "warning"
        : props.status === "negative"
          ? "destructive"
          : "secondary";
  // The semantic state is on the element as well as in its colour, so a
  // reader that is not looking at colour, and a test, can both tell which one
  // fact on this row is the blocking one.
  return (
    <OctantBadge data-status={props.status} variant={variant}>
      {props.label}
    </OctantBadge>
  );
}

function pullRequestMatches(row: CodeProjectPullRequestRow, query: string): boolean {
  if (query === "") return true;
  return [
    row.title,
    row.author,
    row.headBranch,
    row.baseBranch,
    row.repositoryOwner,
    row.repositoryName,
    String(row.number),
    ...row.linkedThreads.map((thread) => thread.title),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function projectFreshnessFor(
  view: CodeProjectPullRequestView,
  projectId: CodeProjectPullRequestConnection["projectId"],
): CodeProjectPullRequestFreshness {
  const entry = view.projectFreshness?.find(
    (candidate) => String(candidate.projectId) === String(projectId),
  );
  return entry?.freshness ?? view.freshness;
}

function backgroundRefreshStateFor(
  view: CodeProjectPullRequestView,
  projectId: CodeProjectPullRequestConnection["projectId"],
): CodeProjectPullRequestBackgroundRefreshState | undefined {
  return view.backgroundRefresh?.find(
    (candidate) => String(candidate.projectId) === String(projectId),
  );
}

/**
 * Only exceptional cadence states earn copy: an enabled cadence quietly doing
 * its job needs no banner, and "disabled" is already the toggle's own label.
 */
function backgroundRefreshCopy(
  state: CodeProjectPullRequestBackgroundRefreshState | undefined,
): string | undefined {
  if (state === undefined) return undefined;
  if (state.state === "unavailable") {
    return "Auto-refresh is unavailable: the GitHub CLI is missing or not authenticated.";
  }
  if (state.state === "backing-off") {
    return "Auto-refresh is backing off after a failed observation.";
  }
  return undefined;
}

export function checksStatus(
  row: CodeProjectPullRequestRow,
): "positive" | "warning" | "negative" | "neutral" {
  if (blockingFact(row) !== "checks") return "neutral";
  if (row.checks === "failing") return "negative";
  if (row.checks === "pending") return "warning";
  return "neutral";
}

export function reviewStatus(
  row: CodeProjectPullRequestRow,
): "positive" | "warning" | "negative" | "neutral" {
  if (blockingFact(row) !== "review") return "neutral";
  if (row.review === "changes-requested") return "negative";
  if (row.review === "pending") return "warning";
  return "neutral";
}

export function mergeabilityStatus(
  row: CodeProjectPullRequestRow,
): "positive" | "negative" | "neutral" {
  if (row.mergeability === "conflicting") return "negative";
  // Nothing blocks it, so this is the one row that may say so in colour.
  if (row.mergeability === "mergeable" && blockingFact(row) === undefined) return "positive";
  return "neutral";
}

export function truncationCopy(view: CodeProjectPullRequestView, dock: boolean): string {
  // The truncation bounds apply to the whole cached snapshot, but the dock
  // shows one Project. An unqualified "some pull requests were omitted" beside
  // that Project's rows reads as its own rows having been dropped from a list
  // that is still showing them, so the dock names the snapshot as the scope.
  const repositories = view.repositoriesTruncated
    ? dock
      ? " Some connected repositories in the snapshot were omitted after the preview bound of 25."
      : " Some connected repositories were omitted after the preview bound of 25."
    : "";
  const pullRequests = view.pullRequestsTruncated
    ? dock
      ? " Some of the snapshot's pull requests were omitted after the preview bound of 100."
      : " Some pull requests were omitted after the preview bound of 100."
    : "";
  return `${repositories}${pullRequests}`;
}

export function freshnessCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "No GitHub snapshot yet. Refresh a connected Project to load active pull requests."
      : `Last successful refresh ${relativeTimeLabel(freshness.lastSuccessfulRefreshAt)}.`;
  }
  if (freshness.status === "fresh") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Snapshot is fresh."
      : // Seconds precision on "when did this last refresh" is detail nobody
        // acts on; the exact time is a hover away on every row.
        `Last successful refresh ${relativeTimeLabel(freshness.lastSuccessfulRefreshAt)}.`;
  }
  const reason =
    freshness.staleReason === "rate-limited"
      ? "GitHub rate-limited the last refresh"
      : freshness.staleReason === "timeout"
        ? "The last refresh timed out"
        : freshness.staleReason === "malformed"
          ? "The last refresh returned unreadable output"
          : freshness.staleReason === "disconnected"
            ? "GitHub was disconnected on the last refresh"
            : "The last refresh failed";
  const last =
    freshness.lastSuccessfulRefreshAt === undefined
      ? ""
      : ` Last success ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
  const retry =
    freshness.retryAfter === undefined
      ? ""
      : ` Retry after ${formatUpdatedAt(freshness.retryAfter)}.`;
  if (freshness.staleReason === "disconnected") {
    return `GitHub access is unavailable. Check the GitHub CLI connection, then refresh.${last}${retry}`;
  }
  return `${reason}.${last}${retry} Cached results remain visible until a refresh succeeds.`;
}

export function pullRequestCountCopy(
  freshness: CodeProjectPullRequestFreshness,
  count: number,
): string {
  if (freshness.status === "empty" && freshness.lastSuccessfulRefreshAt === undefined) {
    return "Refresh to load pull requests";
  }
  if (freshness.status === "stale") {
    if (count === 0) return "No cached pull requests";
    return count === 1 ? "1 cached pull request" : `${String(count)} cached pull requests`;
  }
  return count === 1 ? "1 pull request" : `${String(count)} pull requests`;
}

export function projectEmptyCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Not refreshed yet. Refresh this Project to load pull requests."
      : "No open or draft pull requests.";
  }
  if (freshness.status === "stale") return "No cached pull requests for this Project.";
  return "No open or draft pull requests.";
}

/** The one sentence a list with nothing in it says about what will fill it. */
function listEmptyCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty" && freshness.lastSuccessfulRefreshAt === undefined) {
    return "Open and draft pull requests will list here once a Project is refreshed.";
  }
  if (freshness.status === "stale") return "No cached pull requests to show.";
  return "No open or draft pull requests.";
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

/**
 * The one key a Project pull-request row and the shell's selected pull request
 * share, so a row can mark itself selected wherever the selection was made.
 */
export function projectPullRequestKey(identity: {
  readonly projectId: ProjectId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}): string {
  return `${String(identity.projectId)}:${identity.repositoryOwner}/${identity.repositoryName}#${identity.number}`;
}
