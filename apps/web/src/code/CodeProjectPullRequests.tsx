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
import { GitPullRequest, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { Surface, SurfaceEmpty, SurfaceHeader } from "../surface/SurfaceHeader";
import { OctantBadge, type OctantBadgeProps } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

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
   * Present when the shell can toggle the opt-in background refresh for a
   * Project. The server owns the setting; this only issues the command.
   */
  readonly backgroundRefresh?: {
    readonly enabledFor: (projectId: ProjectId) => boolean;
    readonly setEnabled: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  };
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

  const view =
    workspace.status === "ready" || workspace.status === "refreshing"
      ? workspace.view
      : workspace.status === "error"
        ? workspace.view
        : undefined;
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const visibleRows = view?.rows.filter((row) => pullRequestMatches(row, normalizedSearch)) ?? [];
  const freshnessStatus = view?.freshness.status ?? "loading";
  const hasProjects = view !== undefined && view.projects.length > 0;

  return (
    <Surface ariaLabel="Pull requests">
      <SurfaceHeader
        subtitle="Active open and draft pull requests from connected Code Projects."
        title="Pull requests"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />
      <div
        className="code-project-pull-requests"
        data-freshness={freshnessStatus}
        data-narrow={props.isNarrow === true ? "true" : "false"}
      >
        {view === undefined || !hasProjects ? null : (
          <div className="surface-toolbar">
            <label className="surface-toolbar__search code-project-pull-requests__search">
              <Search aria-hidden="true" size={14} strokeWidth={1.7} />
              <span className="sr-only">Search pull requests</span>
              <OctantInput
                aria-label="Search pull requests"
                onChange={(event) => setSearch(event.currentTarget.value)}
                placeholder="Search pull requests"
                type="search"
                value={search}
              />
              {search === "" ? null : (
                <OctantButton
                  aria-label="Clear pull-request search"
                  className="code-project-pull-requests__search-clear"
                  onClick={() => setSearch("")}
                  type="button"
                  variant="ghost"
                >
                  <X aria-hidden="true" size={14} strokeWidth={1.7} />
                </OctantButton>
              )}
            </label>
            <span
              className="oct-meta code-project-pull-requests__count"
              data-freshness={view.freshness.status}
            >
              {pullRequestCountCopy(view.freshness, visibleRows.length)}
            </span>
            <OctantButton
              aria-label="Refresh all"
              disabled={workspace.status === "loading" || workspace.status === "refreshing"}
              onClick={() => void runRefresh({ kind: "refresh-all" })}
              size="icon"
              title="Refresh all pull requests"
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
            </OctantButton>
          </div>
        )}

        {workspace.status === "loading" ? (
          <ShellState
            eyebrow="Pull requests"
            message="Reading the last authorized snapshot."
            state="neutral"
            title="Loading pull requests"
          />
        ) : null}

        {view === undefined ? (
          workspace.status === "error" ? (
            <p className="code-project-pull-requests__status" role="alert">
              {workspace.message}
            </p>
          ) : null
        ) : !hasProjects ? (
          <SurfaceEmpty
            detail="Add a Code Project to see pull requests here."
            title="No Code Projects yet"
          />
        ) : (
          <>
            <p
              className="code-project-pull-requests__status"
              data-state={view.freshness.status}
              role="status"
            >
              {freshnessCopy(view.freshness)}
              {view.repositoriesTruncated
                ? " Some connected repositories were omitted after the preview bound of 25."
                : ""}
              {view.pullRequestsTruncated
                ? " Some pull requests were omitted after the preview bound of 100."
                : ""}
            </p>
            {workspace.status === "error" ? (
              <p className="code-project-pull-requests__status" role="alert">
                {workspace.message}
              </p>
            ) : null}
            {visibleRows.length === 0 && normalizedSearch !== "" ? (
              <SurfaceEmpty
                action={
                  <OctantButton
                    onClick={() => setSearch("")}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Clear search
                  </OctantButton>
                }
                title={`No pull requests match “${search.trim()}”.`}
              />
            ) : null}
            <div className="code-project-pull-requests__groups">
              {view.projects.map((project) => {
                const backgroundRefreshState = backgroundRefreshStateFor(view, project.projectId);
                return (
                  <ProjectGroup
                    key={String(project.projectId)}
                    busy={workspace.status === "refreshing"}
                    onRefresh={() =>
                      void runRefresh({ kind: "refresh-project", projectId: project.projectId })
                    }
                    project={project}
                    rows={visibleRows.filter(
                      (row) => String(row.projectId) === String(project.projectId),
                    )}
                    freshness={projectFreshnessFor(view, project.projectId)}
                    {...(props.backgroundRefresh === undefined
                      ? {}
                      : { backgroundRefresh: props.backgroundRefresh })}
                    {...(backgroundRefreshState === undefined ? {} : { backgroundRefreshState })}
                    {...(props.onSelectRow === undefined ? {} : { onSelectRow: props.onSelectRow })}
                    {...(props.selectedRowKey === undefined
                      ? {}
                      : { selectedRowKey: props.selectedRowKey })}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </Surface>
  );
}

function ProjectGroup(props: {
  readonly project: CodeProjectPullRequestConnection;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly freshness: CodeProjectPullRequestFreshness;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly selectedRowKey?: string;
  readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
  readonly backgroundRefresh?: {
    readonly enabledFor: (projectId: ProjectId) => boolean;
    readonly setEnabled: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  };
  readonly backgroundRefreshState?: CodeProjectPullRequestBackgroundRefreshState;
}) {
  const repositories = groupByRepository(props.rows);
  const backgroundRefresh =
    props.project.kind === "connected" ? props.backgroundRefresh : undefined;
  const backgroundRefreshEnabled = backgroundRefresh?.enabledFor(props.project.projectId) ?? false;
  return (
    <section
      aria-label={`Project ${props.project.projectName}`}
      className="surface-section code-project-pull-requests__project"
    >
      <div className="surface-row">
        <div className="surface-row__copy">
          <h2 className="oct-section-label">{props.project.projectName}</h2>
          {props.project.kind === "connected" ? (
            <span className="oct-meta oct-meta--mono">
              {props.project.repositoryOwner}/{props.project.repositoryName}
            </span>
          ) : null}
        </div>
        <div className="surface-row__control">
          {backgroundRefresh === undefined ? null : (
            <OctantButton
              aria-label={`Background refresh for ${props.project.projectName}`}
              aria-pressed={backgroundRefreshEnabled}
              onClick={() =>
                void backgroundRefresh.setEnabled(
                  props.project.projectId,
                  !backgroundRefreshEnabled,
                )
              }
              size="sm"
              type="button"
              variant="ghost"
            >
              {backgroundRefreshEnabled ? "Background refresh on" : "Background refresh off"}
            </OctantButton>
          )}
          <OctantButton
            disabled={props.busy}
            onClick={props.onRefresh}
            size="sm"
            type="button"
            variant="ghost"
          >
            Refresh {props.project.projectName}
          </OctantButton>
        </div>
      </div>
      {backgroundRefreshCopy(props.backgroundRefreshState) === undefined ? null : (
        <p className="surface-section__note" role="status">
          {backgroundRefreshCopy(props.backgroundRefreshState)}
        </p>
      )}
      {props.project.kind === "unconnected" ? (
        <p className="surface-section__note">
          No github.com origin detected. Add one to this Project to enable pull-request refresh.
        </p>
      ) : repositories.length === 0 ? (
        <p className="surface-section__note">{projectEmptyCopy(props.freshness)}</p>
      ) : (
        repositories.map((group) => (
          <section
            aria-label={`${group.owner}/${group.name}`}
            className="code-project-pull-requests__repository"
            key={`${group.owner}/${group.name}`}
          >
            <h3 className="oct-meta oct-meta--mono">
              {group.owner}/{group.name}
            </h3>
            <ul className="code-project-pull-requests__list">
              {group.rows.map((row) => {
                const rowKey = pullRequestRowKey(row);
                const selected = props.selectedRowKey === rowKey;
                return (
                  <li key={rowKey}>
                    <OctantButton
                      aria-pressed={selected}
                      className="code-project-pull-requests__row"
                      onClick={() => props.onSelectRow?.(row)}
                      type="button"
                    >
                      <GitPullRequest
                        aria-hidden="true"
                        className="code-project-pull-requests__icon"
                        size={16}
                        strokeWidth={1.7}
                      />
                      <div className="code-project-pull-requests__row-content">
                        <div className="code-project-pull-requests__title-line">
                          <span className="code-project-pull-requests__title">{row.title}</span>
                          <span className="code-project-pull-requests__number">#{row.number}</span>
                        </div>
                        <div className="code-project-pull-requests__byline">
                          <span>{row.author}</span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={row.updatedAt}>{formatUpdatedAt(row.updatedAt)}</time>
                        </div>
                        <div className="code-project-pull-requests__branch">
                          {row.headBranch} → {row.baseBranch}
                        </div>
                        <div className="code-project-pull-requests__meta">
                          {row.draft ? <StatusChip label="Draft" status="neutral" /> : null}
                          <StatusChip label={`Checks ${row.checks}`} status={checksStatus(row)} />
                          <StatusChip
                            label={`Review ${reviewCopy(row.review)}`}
                            status={reviewStatus(row)}
                          />
                          <StatusChip
                            label={mergeabilityCopy(row.mergeability)}
                            status={mergeabilityStatus(row.mergeability)}
                          />
                        </div>
                        <div className="code-project-pull-requests__linked">
                          {row.linkedThreads.length === 0
                            ? "No linked thread"
                            : `Linked: ${row.linkedThreads.map((thread) => thread.title).join(", ")}`}
                        </div>
                      </div>
                    </OctantButton>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}

function StatusChip(props: {
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
  return <OctantBadge variant={variant}>{props.label}</OctantBadge>;
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

function projectFreshnessFor(
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
    return "Background refresh is unavailable: the GitHub CLI is missing or not authenticated.";
  }
  if (state.state === "backing-off") {
    return "Background refresh is backing off after a failed observation.";
  }
  return undefined;
}

function checksStatus(
  row: CodeProjectPullRequestRow,
): "positive" | "warning" | "negative" | "neutral" {
  if (row.checks === "passing") return "positive";
  if (row.checks === "failing") return "negative";
  if (row.checks === "pending") return "warning";
  return "neutral";
}

function reviewStatus(
  row: CodeProjectPullRequestRow,
): "positive" | "warning" | "negative" | "neutral" {
  if (row.review === "approved") return "positive";
  if (row.review === "changes-requested") return "negative";
  if (row.review === "pending") return "warning";
  return "neutral";
}

function mergeabilityCopy(value: CodeProjectPullRequestRow["mergeability"]): string {
  if (value === "mergeable") return "Mergeable";
  if (value === "conflicting") return "Conflicts";
  return "Mergeability unknown";
}

function mergeabilityStatus(
  value: CodeProjectPullRequestRow["mergeability"],
): "positive" | "negative" | "neutral" {
  if (value === "mergeable") return "positive";
  if (value === "conflicting") return "negative";
  return "neutral";
}

function groupByRepository(rows: ReadonlyArray<CodeProjectPullRequestRow>): ReadonlyArray<{
  readonly owner: string;
  readonly name: string;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
}> {
  const groups: Array<{
    owner: string;
    name: string;
    rows: CodeProjectPullRequestRow[];
  }> = [];
  for (const row of rows) {
    const existing = groups.find(
      (group) => group.owner === row.repositoryOwner && group.name === row.repositoryName,
    );
    if (existing === undefined) {
      groups.push({ owner: row.repositoryOwner, name: row.repositoryName, rows: [row] });
    } else {
      existing.rows.push(row);
    }
  }
  return groups;
}

function freshnessCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return "No GitHub snapshot yet. Refresh a connected Project to load active pull requests.";
  }
  if (freshness.status === "fresh") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Snapshot is fresh."
      : `Last successful refresh ${formatUpdatedAt(freshness.lastSuccessfulRefreshAt)}.`;
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

function pullRequestCountCopy(freshness: CodeProjectPullRequestFreshness, count: number): string {
  if (freshness.status === "empty") return "Refresh to load pull requests";
  if (freshness.status === "stale") {
    if (count === 0) return "No cached pull requests";
    return count === 1 ? "1 cached pull request" : `${String(count)} cached pull requests`;
  }
  return count === 1 ? "1 pull request" : `${String(count)} pull requests`;
}

function projectEmptyCopy(freshness: CodeProjectPullRequestFreshness): string {
  if (freshness.status === "empty") {
    return freshness.lastSuccessfulRefreshAt === undefined
      ? "Not refreshed yet. Refresh this Project to load pull requests."
      : "No open or draft pull requests.";
  }
  if (freshness.status === "stale") return "No cached pull requests for this Project.";
  return "No open or draft pull requests.";
}

function reviewCopy(review: CodeProjectPullRequestRow["review"]): string {
  if (review === "changes-requested") return "changes requested";
  return review;
}

function formatUpdatedAt(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function pullRequestRowKey(row: CodeProjectPullRequestRow): string {
  return `${String(row.projectId)}:${row.repositoryOwner}/${row.repositoryName}#${row.number}`;
}
