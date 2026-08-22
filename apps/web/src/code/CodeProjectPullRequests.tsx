import type {
  CodeProjectPullRequestConnection,
  CodeProjectPullRequestFreshness,
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestView,
} from "@octant/contracts";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";

export interface CodeProjectPullRequestsProps {
  readonly load: (query: CodeProjectPullRequestQuery) => Promise<CodeProjectPullRequestView>;
  readonly refresh: (
    command: CodeProjectPullRequestRefreshCommand,
  ) => Promise<CodeProjectPullRequestView>;
  readonly onClose?: () => void;
  readonly isNarrow?: boolean;
  readonly selectedRowKey?: string;
  readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
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

  return (
    <section
      aria-label="Pull requests"
      className="code-project-pull-requests"
      data-narrow={props.isNarrow === true ? "true" : "false"}
    >
      <header className="code-board__header">
        <div className="code-board__identity">
          <h1 className="code-board__title">Pull requests</h1>
          <p className="code-board__subtitle">
            Active open and draft pull requests from connected Code Projects.
          </p>
        </div>
        <div className="code-project-pull-requests__actions">
          <OctantButton
            disabled={workspace.status === "loading" || workspace.status === "refreshing"}
            onClick={() => void runRefresh({ kind: "refresh-all" })}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
            Refresh all
          </OctantButton>
          {props.onClose === undefined ? null : (
            <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
              Back to workspace
            </OctantButton>
          )}
        </div>
      </header>

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
      ) : (
        <>
          <p className="code-project-pull-requests__status" role="status">
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
          <div className="code-project-pull-requests__groups">
            {view.projects.map((project) => (
              <ProjectGroup
                key={String(project.projectId)}
                busy={workspace.status === "refreshing"}
                onRefresh={() =>
                  void runRefresh({ kind: "refresh-project", projectId: project.projectId })
                }
                project={project}
                rows={view.rows.filter(
                  (row) => String(row.projectId) === String(project.projectId),
                )}
                {...(props.onSelectRow === undefined ? {} : { onSelectRow: props.onSelectRow })}
                {...(props.selectedRowKey === undefined
                  ? {}
                  : { selectedRowKey: props.selectedRowKey })}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ProjectGroup(props: {
  readonly project: CodeProjectPullRequestConnection;
  readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
  readonly busy: boolean;
  readonly onRefresh: () => void;
  readonly selectedRowKey?: string;
  readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
}) {
  const repositories = groupByRepository(props.rows);
  return (
    <section
      aria-label={`Project ${props.project.projectName}`}
      className="code-project-pull-requests__project"
    >
      <header className="code-project-pull-requests__project-header">
        <h2>{props.project.projectName}</h2>
        <OctantButton
          disabled={props.busy}
          onClick={props.onRefresh}
          size="sm"
          type="button"
          variant="ghost"
        >
          Refresh {props.project.projectName}
        </OctantButton>
      </header>
      {props.project.kind === "unconnected" ? (
        <p className="code-project-pull-requests__unconnected">
          Not connected to a github.com origin. The Project stays usable.
        </p>
      ) : repositories.length === 0 ? (
        <p className="code-project-pull-requests__empty">
          No active pull requests in this snapshot.
        </p>
      ) : (
        repositories.map((group) => (
          <section
            aria-label={`${group.owner}/${group.name}`}
            className="code-project-pull-requests__repository"
            key={`${group.owner}/${group.name}`}
          >
            <h3>
              {group.owner}/{group.name}
            </h3>
            <ul className="code-project-pull-requests__list">
              {group.rows.map((row) => {
                const rowKey = pullRequestRowKey(row);
                const selected = props.selectedRowKey === rowKey;
                return (
                  <li key={rowKey}>
                    <button
                      aria-pressed={selected}
                      className="code-project-pull-requests__row"
                      onClick={() => props.onSelectRow?.(row)}
                      type="button"
                    >
                      <div className="code-project-pull-requests__title-line">
                        <span className="code-project-pull-requests__title">{row.title}</span>
                        <span>#{row.number}</span>
                        {row.draft ? <span>Draft</span> : null}
                      </div>
                      <div className="code-project-pull-requests__meta">
                        <span>{row.author}</span>
                        <span>
                          {row.headBranch} → {row.baseBranch}
                        </span>
                        <time dateTime={row.updatedAt}>{formatUpdatedAt(row.updatedAt)}</time>
                        <span>Checks {row.checks}</span>
                        <span>Review {reviewCopy(row.review)}</span>
                        <span>
                          {row.linkedThreads.length === 0
                            ? "No linked thread"
                            : `Linked: ${row.linkedThreads.map((thread) => thread.title).join(", ")}`}
                        </span>
                      </div>
                    </button>
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
    return "No GitHub snapshot yet. Refresh to load active pull requests.";
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
  return `${reason}.${last}${retry}`;
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
