import type {
  CodeProjectPullRequestQuery,
  CodeProjectPullRequestRefreshCommand,
  CodeProjectPullRequestRow,
  CodeProjectPullRequestView,
  ProjectId,
} from "@octant/contracts";
import { ArrowUpRight, GitPullRequest, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  checksStatus,
  freshnessCopy,
  mergeabilityCopy,
  mergeabilityStatus,
  projectEmptyCopy,
  projectFreshnessFor,
  projectPullRequestKey,
  pullRequestCountCopy,
  reviewCopy,
  reviewStatus,
  StatusChip,
  truncationCopy,
} from "../code/CodeProjectPullRequests";
import { OctantButton } from "../ui/base/OctantButton";
import { EnvironmentGroup } from "./EnvironmentGroup";

export interface EnvironmentPullRequestsProps {
  /**
   * The journaled pull-request inventory the Pull requests overview renders:
   * one manually refreshed snapshot shared by every consumer, so opening this
   * panel never sends a GitHub read of its own.
   */
  readonly load: (query: CodeProjectPullRequestQuery) => Promise<CodeProjectPullRequestView>;
  readonly refresh: (
    command: CodeProjectPullRequestRefreshCommand,
  ) => Promise<CodeProjectPullRequestView>;
  readonly projectId: ProjectId;
  /** Marks the row the active thread is linked to. */
  readonly threadId?: string;
  /** Routes to the complete Pull requests overview across connected Projects. */
  readonly onOpenAll?: () => void;
  /** Opens a row's pull request in Review. Absent leaves rows inert. */
  readonly onSelectRow?: (row: CodeProjectPullRequestRow) => void;
  /** The panel's open state; the snapshot is only read while it is visible. */
  readonly enabled: boolean;
}

type LoadState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestView }
  | { readonly status: "refreshing"; readonly view: CodeProjectPullRequestView }
  | {
      readonly status: "error";
      readonly message: string;
      readonly view?: CodeProjectPullRequestView;
    };

/**
 * The connected Project's open pull requests inside a thread's Environment,
 * read from the same journaled snapshot the Pull requests overview renders.
 * Rows stay scoped to this Project; the complete cross-Project overview is
 * one action away so unlinked and other-Project pull requests stay findable.
 */
export function EnvironmentPullRequests(props: EnvironmentPullRequestsProps) {
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const loadRef = useRef(props.load);
  const refreshRef = useRef(props.refresh);
  useEffect(() => {
    loadRef.current = props.load;
    refreshRef.current = props.refresh;
  });

  const enabled = props.enabled;
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState((current) =>
      current.status === "ready" || current.status === "refreshing"
        ? { status: "refreshing", view: current.view }
        : current.status === "error" && current.view !== undefined
          ? { status: "refreshing", view: current.view }
          : { status: "loading" },
    );
    void loadRef.current({ version: 1 }).then(
      (view) => {
        if (active) setState({ status: "ready", view });
      },
      () => {
        if (active) {
          setState({ status: "error", message: "The pull-request list could not be read." });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [enabled]);

  async function runRefresh(): Promise<void> {
    setState((current) =>
      current.status === "ready" || current.status === "refreshing"
        ? { status: "refreshing", view: current.view }
        : current.status === "error" && current.view !== undefined
          ? { status: "refreshing", view: current.view }
          : { status: "loading" },
    );
    try {
      const view = await refreshRef.current({
        kind: "refresh-project",
        projectId: props.projectId,
      });
      setState({ status: "ready", view });
    } catch {
      setState((current) => ({
        status: "error",
        message: "The pull-request list could not be refreshed.",
        ...(current.status === "ready" || current.status === "refreshing"
          ? { view: current.view }
          : current.status === "error" && current.view !== undefined
            ? { view: current.view }
            : {}),
      }));
    }
  }

  const view =
    state.status === "ready" || state.status === "refreshing"
      ? state.view
      : state.status === "error"
        ? state.view
        : undefined;
  const connection = view?.projects.find(
    (project) => String(project.projectId) === String(props.projectId),
  );
  const connected = connection?.kind === "connected";
  const freshness = view === undefined ? undefined : projectFreshnessFor(view, props.projectId);
  const rows = view?.rows.filter((row) => String(row.projectId) === String(props.projectId)) ?? [];
  const busy = state.status === "loading" || state.status === "refreshing";
  const summary =
    view === undefined
      ? "Reading"
      : !connected
        ? "Not on GitHub"
        : rows.length === 0
          ? "None"
          : `${String(rows.length)} open`;

  return (
    <EnvironmentGroup
      action={
        <>
          {connected ? (
            <OctantButton
              aria-label="Refresh pull requests"
              className="environment-pull-requests__refresh"
              disabled={busy}
              onClick={() => void runRefresh()}
              size="icon"
              title="Refresh this Project's pull requests"
              type="button"
              variant="ghost"
            >
              <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
            </OctantButton>
          ) : null}
          {props.onOpenAll === undefined ? null : (
            <OctantButton
              className="environment-pull-requests__all"
              onClick={props.onOpenAll}
              size="sm"
              type="button"
              variant="ghost"
            >
              <span>All pull requests</span>
              <ArrowUpRight aria-hidden="true" size={14} strokeWidth={1.8} />
            </OctantButton>
          )}
        </>
      }
      icon={GitPullRequest}
      summary={summary}
      title="Pull requests"
    >
      <div className="environment-pull-requests">
        {state.status === "loading" ? (
          <p className="environment-pull-requests__status" role="status">
            Reading pull requests…
          </p>
        ) : view === undefined ? (
          <p className="environment-pull-requests__status" role="alert">
            {state.status === "error" ? state.message : "Pull requests unavailable."}
          </p>
        ) : !connected ? (
          <p className="environment-pull-requests__status" role="status">
            This Project is not on GitHub.
          </p>
        ) : (
          <>
            <p className="environment-pull-requests__status" role="status">
              {`${pullRequestCountCopy(freshness ?? view.freshness, rows.length)} in this Project (${connection.repositoryOwner}/${connection.repositoryName}).`}
              {` ${freshnessCopy(freshness ?? view.freshness)}`}
              {truncationCopy(view, true)}
            </p>
            {state.status === "error" ? (
              <p className="environment-pull-requests__status" role="alert">
                {state.message}
              </p>
            ) : null}
            {rows.length === 0 ? (
              <p className="environment-pull-requests__status">
                {projectEmptyCopy(freshness ?? view.freshness)}
              </p>
            ) : (
              <ul className="environment-pull-requests__list">
                {rows.map((row) => (
                  <EnvironmentPullRequestRow
                    key={projectPullRequestKey(row)}
                    {...(props.onSelectRow === undefined ? {} : { onOpen: props.onSelectRow })}
                    row={row}
                    {...(props.threadId === undefined ? {} : { threadId: props.threadId })}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </EnvironmentGroup>
  );
}

function EnvironmentPullRequestRow(props: {
  readonly row: CodeProjectPullRequestRow;
  readonly threadId?: string;
  readonly onOpen?: (row: CodeProjectPullRequestRow) => void;
}) {
  const row = props.row;
  const linked =
    row.linkedThreads.length === 0
      ? undefined
      : `Linked: ${row.linkedThreads
          .map((thread) =>
            props.threadId !== undefined && String(thread.threadId) === props.threadId
              ? "this thread"
              : thread.title,
          )
          .join(", ")}`;
  const body = (
    <>
      <span className="environment-pull-requests__title">
        <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>{`#${row.number} ${row.title}`}</span>
      </span>
      <span className="environment-pull-requests__branches">
        {row.headBranch} → {row.baseBranch}
      </span>
      <span className="environment-pull-requests__meta">
        {row.draft ? <StatusChip label="Draft" status="neutral" /> : null}
        <StatusChip label={`Checks ${row.checks}`} status={checksStatus(row)} />
        <StatusChip label={`Review ${reviewCopy(row.review)}`} status={reviewStatus(row)} />
        <StatusChip label={mergeabilityCopy(row.mergeability)} status={mergeabilityStatus(row)} />
      </span>
      {linked === undefined ? null : (
        <span className="environment-pull-requests__linked">{linked}</span>
      )}
    </>
  );
  return (
    <li>
      {props.onOpen === undefined ? (
        <span className="environment-pull-requests__row">{body}</span>
      ) : (
        <OctantButton
          className="environment-pull-requests__row"
          onClick={() => props.onOpen?.(row)}
          type="button"
          variant="ghost"
        >
          {body}
        </OctantButton>
      )}
    </li>
  );
}
