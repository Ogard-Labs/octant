import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type {
  WorkThread,
  EnvironmentPresentationState,
  ProjectSummary,
  WorkspaceTab,
} from "@octant/contracts";
import { deriveWorkEnvironmentProjection } from "@octant/domain/shell-policy";
import { useEffect, useState, type ReactNode } from "react";
import { resolveTabPresentation } from "./EnvironmentPresentationModel";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { WorkingDirectoryControl } from "./WorkingDirectoryControl";

type WorkThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
type WorkProject = Extract<ProjectSummary, { readonly type: "work" }>;

export interface WorkThreadEnvironmentProps {
  readonly tab: WorkThreadWorkspaceTab;
  readonly presentation: EnvironmentPresentationState;
  readonly onChangePresentation: (next: EnvironmentPresentationState) => void;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly threadClient: WorkThreadClient;
  readonly children: ReactNode;
}

/**
 * Resolves the Work Project through authoritative thread state, then mounts
 * the confined folder identity inside the thread tab. Failure to resolve the
 * thread or its Project is represented as unavailable instead of guessing a
 * folder from renderer state.
 */
export function WorkThreadEnvironment(props: WorkThreadEnvironmentProps) {
  const [project, setProject] = useState<WorkProject | undefined>(undefined);
  const [thread, setThread] = useState<WorkThread | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setProject(undefined);
    setThread(undefined);
    void props.threadClient
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        const thread = bootstrap.threads.find((candidate) => candidate.id === props.tab.threadId);
        const candidate = props.projects.find(
          (entry): entry is WorkProject => entry.type === "work" && entry.id === thread?.projectId,
        );
        setProject(candidate);
        setThread(thread);
      })
      .catch(() => {
        if (!cancelled) setProject(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [props.projects, props.tab.threadId, props.threadClient]);

  const projection = deriveWorkEnvironmentProjection({
    projectName: project?.name ?? "Work",
    ...(project === undefined ? {} : { boundRoot: project.binding.canonicalRoot }),
  });
  const resolved = resolveTabPresentation(props.presentation, "work", props.tab.id);

  return (
    <div className={`code-thread-environment code-thread-environment--${resolved}`}>
      <div className="code-thread-environment__content">{props.children}</div>
      <ThreadEnvironmentPanel
        identity={projection.identity}
        mode="work"
        onChangePresentation={props.onChangePresentation}
        presentation={props.presentation}
        tabId={props.tab.id}
      >
        {thread === undefined ? null : (
          <WorkingDirectoryControl
            value={thread.workingDirectory ?? "."}
            onApply={async (workingDirectory) => {
              const result = await props.threadClient.execute({
                kind: "change-work-thread-working-directory",
                threadId: thread.id,
                expectedVersion: thread.version,
                workingDirectory,
              });
              if ("kind" in result && result.kind === "thread-updated") {
                setThread(result.thread);
                return;
              }
              throw new Error("Work working directory was not updated.");
            }}
          />
        )}
      </ThreadEnvironmentPanel>
    </div>
  );
}
