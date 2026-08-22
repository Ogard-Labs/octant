import type {
  CodeProjectPullRequestDetailQuery,
  CodeProjectPullRequestDetailRefreshCommand,
  CodeProjectPullRequestDetailView,
  CodeProjectPullRequestLinkedThread,
} from "@octant/contracts";
import { useEffect, useRef, useState } from "react";
import { ProjectPullRequestReviewPane } from "../code/ProjectPullRequestReviewPane";
import { ShellState } from "./ShellState";

export interface DockProjectPullRequestReviewToolProps {
  readonly query: CodeProjectPullRequestDetailQuery;
  readonly load: (
    query: CodeProjectPullRequestDetailQuery,
  ) => Promise<CodeProjectPullRequestDetailView>;
  readonly refresh: (
    command: CodeProjectPullRequestDetailRefreshCommand,
  ) => Promise<CodeProjectPullRequestDetailView>;
  readonly onOpenLinkedThread?: (thread: CodeProjectPullRequestLinkedThread) => void;
}

type DetailState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly view: CodeProjectPullRequestDetailView }
  | { readonly status: "refreshing"; readonly view: CodeProjectPullRequestDetailView }
  | {
      readonly status: "error";
      readonly message: string;
      readonly view?: CodeProjectPullRequestDetailView;
    };

export function DockProjectPullRequestReviewTool(props: DockProjectPullRequestReviewToolProps) {
  const [workspace, setWorkspace] = useState<DetailState>({ status: "loading" });
  const refreshRef = useRef(props.refresh);
  useEffect(() => {
    refreshRef.current = props.refresh;
  });

  useEffect(() => {
    let active = true;
    setWorkspace({ status: "loading" });
    refreshRef
      .current({
        projectId: props.query.projectId,
        repositoryOwner: props.query.repositoryOwner,
        repositoryName: props.query.repositoryName,
        number: props.query.number,
      })
      .then(
        (view) => {
          if (active) setWorkspace({ status: "ready", view });
        },
        () => {
          if (active) {
            setWorkspace({
              status: "error",
              message: "The pull-request detail could not be refreshed from GitHub.",
            });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [
    props.query.number,
    props.query.projectId,
    props.query.repositoryName,
    props.query.repositoryOwner,
  ]);

  async function runRefresh(): Promise<void> {
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
      const view = await props.refresh({
        projectId: props.query.projectId,
        repositoryOwner: props.query.repositoryOwner,
        repositoryName: props.query.repositoryName,
        number: props.query.number,
      });
      setWorkspace({ status: "ready", view });
    } catch {
      setWorkspace((previous) => ({
        status: "error",
        message: "The pull-request detail could not be refreshed from GitHub.",
        ...(previous.status === "ready" || previous.status === "refreshing"
          ? { view: previous.view }
          : previous.status === "error" && previous.view !== undefined
            ? { view: previous.view }
            : {}),
      }));
    }
  }

  if (workspace.status === "loading") {
    return (
      <ShellState
        message="Loading pull-request detail from GitHub."
        state="loading"
        title="Review"
      />
    );
  }

  const view =
    workspace.status === "ready" || workspace.status === "refreshing"
      ? workspace.view
      : workspace.status === "error"
        ? workspace.view
        : undefined;

  if (view === undefined) {
    return (
      <ShellState
        message={workspace.status === "error" ? workspace.message : "Detail is unavailable."}
        state="neutral"
        title="Review is unavailable"
      />
    );
  }

  if (view.detail.state === "empty") {
    return (
      <ShellState
        message="No authorized detail is cached for this pull request yet."
        state="neutral"
        title="Review"
      />
    );
  }

  if (view.detail.state === "unavailable") {
    return (
      <ShellState
        message="GitHub could not return detail for this pull request."
        state="neutral"
        title="Review is unavailable"
      />
    );
  }

  return (
    <>
      {workspace.status === "error" ? (
        <p className="code-project-pull-requests__status" role="alert">
          {workspace.message}
        </p>
      ) : null}
      <ProjectPullRequestReviewPane
        detail={view.detail}
        freshness={view.freshness}
        linkedThreads={view.linkedThreads}
        {...(props.onOpenLinkedThread === undefined
          ? {}
          : { onOpenLinkedThread: props.onOpenLinkedThread })}
        onRefresh={() => void runRefresh()}
      />
    </>
  );
}
