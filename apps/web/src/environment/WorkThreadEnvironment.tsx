import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { WorkThread, ProjectSummary, WorkspaceTab } from "@octant/contracts";
import { deriveWorkEnvironmentProjection } from "@octant/domain/shell-policy";
import { useEffect, useState, type ReactNode } from "react";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { ChangeWorkingFolder } from "./WorkingDirectoryControl";

type WorkThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
type WorkProject = Extract<ProjectSummary, { readonly type: "work" }>;

export interface WorkThreadEnvironmentProps {
  readonly tab: WorkThreadWorkspaceTab;
  readonly active?: boolean;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly threadClient: WorkThreadClient;
  readonly children: ReactNode;
}

/**
 * Resolves the Work Project through authoritative thread state, then mounts
 * the confined folder identity as a compact summary with a transient
 * disclosure. Failure to resolve the thread or its Project is represented as
 * unavailable instead of guessing a folder from renderer state.
 */
export function WorkThreadEnvironment(props: WorkThreadEnvironmentProps) {
  const [disclosureOpen, setDisclosureOpen] = useState(false);
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
        const nextThread = bootstrap.threads.find(
          (candidate) => candidate.id === props.tab.threadId,
        );
        const candidate = props.projects.find(
          (entry): entry is WorkProject =>
            entry.type === "work" && entry.id === nextThread?.projectId,
        );
        setProject(candidate);
        setThread(nextThread);
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

  return (
    <div className="code-thread-environment">
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        onOpenChange={setDisclosureOpen}
        open={disclosureOpen}
        summary={{
          identity: projection.identity,
          ...(thread === undefined
            ? {}
            : { workingLocation: String(thread.workingDirectory ?? ".") }),
        }}
      >
        {thread === undefined ? null : (
          <ChangeWorkingFolder
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
      <div className="code-thread-environment__content">{props.children}</div>
    </div>
  );
}
