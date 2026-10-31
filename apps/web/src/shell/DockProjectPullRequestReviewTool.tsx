import type {
  CodeProjectPullRequestActionCommand,
  CodeProjectPullRequestActionContext,
  CodeProjectPullRequestActionContextQuery,
  CodeProjectPullRequestActionOutcome,
  CodeProjectPullRequestDetailObserved,
  CodeProjectPullRequestDetailQuery,
  CodeProjectPullRequestDetailRefreshCommand,
  CodeProjectPullRequestDetailView,
  CodeProjectPullRequestLinkedThread,
  CodeProjectPullRequestAutoFixCommand,
  CodeProjectPullRequestMergeMethod,
  CodeProjectPullRequestMergeOutcome,
  CodeProjectPullRequestMergeWhenReadyCommand,
  CodeProjectPullRequestSwitchOutcome,
  CodeProjectPullRequestSwitchTarget,
  CodeProjectPullRequestSwitchesView,
} from "@octant/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectPullRequestPersonAction } from "../code/ProjectPullRequestActions";
import { ProjectPullRequestReviewPane } from "../code/ProjectPullRequestReviewPane";
import { ShellState } from "./ShellState";
import { OctantAlert } from "../ui/base/OctantAlert";

export interface DockProjectPullRequestReviewToolProps {
  readonly query: CodeProjectPullRequestDetailQuery;
  readonly load: (
    query: CodeProjectPullRequestDetailQuery,
  ) => Promise<CodeProjectPullRequestDetailView>;
  readonly refresh: (
    command: CodeProjectPullRequestDetailRefreshCommand,
  ) => Promise<CodeProjectPullRequestDetailView>;
  readonly onOpenLinkedThread?: (thread: CodeProjectPullRequestLinkedThread) => void;
  readonly onOpenChat?: (detail: CodeProjectPullRequestDetailObserved) => void;
  readonly onMerge?: (
    method: CodeProjectPullRequestMergeMethod,
    headSha: string,
  ) => Promise<CodeProjectPullRequestMergeOutcome>;
  readonly loadActionContext?: (
    query: CodeProjectPullRequestActionContextQuery,
  ) => Promise<CodeProjectPullRequestActionContext>;
  readonly act?: (
    command: CodeProjectPullRequestActionCommand,
  ) => Promise<CodeProjectPullRequestActionOutcome>;
  readonly loadSwitches?: (
    target: CodeProjectPullRequestSwitchTarget,
  ) => Promise<CodeProjectPullRequestSwitchesView>;
  readonly setMergeWhenReady?: (
    command: CodeProjectPullRequestMergeWhenReadyCommand,
  ) => Promise<CodeProjectPullRequestSwitchOutcome>;
  readonly setAutoFix?: (
    command: CodeProjectPullRequestAutoFixCommand,
  ) => Promise<CodeProjectPullRequestSwitchOutcome>;
}

/**
 * How often an open review re-reads its switches. The host observes the
 * forge about once a minute, so a faster read would only repeat itself.
 */
const SWITCHES_REFRESH_MS = 20_000;

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
  const [switches, setSwitches] = useState<CodeProjectPullRequestSwitchesView>();
  const refreshRef = useRef(props.refresh);
  const loadSwitchesRef = useRef(props.loadSwitches);
  useEffect(() => {
    refreshRef.current = props.refresh;
    loadSwitchesRef.current = props.loadSwitches;
  });
  const target: CodeProjectPullRequestSwitchTarget = {
    projectId: props.query.projectId,
    repositoryOwner: props.query.repositoryOwner,
    repositoryName: props.query.repositoryName,
    number: props.query.number,
  };

  // Stable across renders: the switches poll re-renders this tool every 20
  // seconds, and a new function identity would re-read the labels and review
  // threads from GitHub each time.
  const { loadActionContext } = props;
  const { projectId, repositoryOwner, repositoryName, number } = props.query;
  const readActionContext = useCallback(
    () =>
      loadActionContext === undefined
        ? Promise.resolve({ status: "unavailable", reason: "unavailable" } as const)
        : loadActionContext({ projectId, repositoryOwner, repositoryName, number }),
    [loadActionContext, projectId, repositoryOwner, repositoryName, number],
  );

  useEffect(() => {
    const load = loadSwitchesRef.current;
    if (load === undefined) return;
    let active = true;
    const read = () => {
      load({
        projectId: props.query.projectId,
        repositoryOwner: props.query.repositoryOwner,
        repositoryName: props.query.repositoryName,
        number: props.query.number,
      }).then(
        (view) => {
          if (active) setSwitches(view);
        },
        () => undefined,
      );
    };
    read();
    const timer = setInterval(read, SWITCHES_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [
    props.query.number,
    props.query.projectId,
    props.query.repositoryName,
    props.query.repositoryOwner,
  ]);

  async function applySwitch(
    run: () => Promise<CodeProjectPullRequestSwitchOutcome>,
  ): Promise<CodeProjectPullRequestSwitchOutcome> {
    try {
      const outcome = await run();
      if (outcome.status === "applied") setSwitches(outcome.view);
      return outcome;
    } catch (error) {
      // A paired device is refused before the host reads the command.
      if (
        typeof error === "object" &&
        error !== null &&
        "category" in error &&
        error.category === "unauthorized"
      ) {
        return { status: "refused", reason: "not-authorized" };
      }
      return { status: "unavailable", reason: "unavailable" };
    }
  }

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
    return <ShellState state="loading" title="Loading review" />;
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
        <OctantAlert className="code-project-pull-requests__status" tone="warning">
          {workspace.message}
        </OctantAlert>
      ) : null}
      <ProjectPullRequestReviewPane
        detail={view.detail}
        freshness={view.freshness}
        linkedThreads={view.linkedThreads}
        {...(props.onOpenLinkedThread === undefined
          ? {}
          : { onOpenLinkedThread: props.onOpenLinkedThread })}
        {...(props.onOpenChat === undefined ? {} : { onOpenChat: props.onOpenChat })}
        {...(props.onMerge === undefined ? {} : { onMerge: props.onMerge })}
        {...(switches === undefined ? {} : { switches })}
        {...(props.setMergeWhenReady === undefined
          ? {}
          : {
              onMergeWhenReady: (
                enabled: boolean,
                method: CodeProjectPullRequestMergeMethod,
                headSha: string,
              ) => {
                const set = props.setMergeWhenReady;
                if (set === undefined) {
                  return Promise.resolve({ status: "unavailable", reason: "unavailable" } as const);
                }
                return applySwitch(() =>
                  set(
                    enabled
                      ? { kind: "enable", target, headSha, method, confirmed: true }
                      : { kind: "disable", target },
                  ),
                );
              },
            })}
        {...(props.loadActionContext === undefined || props.act === undefined
          ? {}
          : {
              onLoadActionContext: readActionContext,
              onAct: (action: ProjectPullRequestPersonAction) => {
                const act = props.act;
                return act === undefined
                  ? Promise.resolve({ status: "unavailable", reason: "unavailable" } as const)
                  : act({ ...action, ...target });
              },
            })}
        {...(props.setAutoFix === undefined
          ? {}
          : {
              onAutoFix: (
                enabled: boolean,
                threadId: CodeProjectPullRequestLinkedThread["threadId"],
              ) => {
                const set = props.setAutoFix;
                if (set === undefined) {
                  return Promise.resolve({ status: "unavailable", reason: "unavailable" } as const);
                }
                return applySwitch(() =>
                  set(enabled ? { kind: "enable", target, threadId } : { kind: "disable", target }),
                );
              },
            })}
        onRefresh={() => void runRefresh()}
      />
    </>
  );
}
