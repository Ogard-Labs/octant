import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { WorkThread, ProjectSummary, WorkspaceTab } from "@octant/contracts";
import { deriveWorkEnvironmentProjection } from "@octant/domain/shell-policy";
import { useEffect, useState, type ReactNode } from "react";
import { EnvironmentGroup } from "./EnvironmentGroup";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import { ChangeWorkingFolder, workingFolderLabel } from "./WorkingDirectoryControl";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { ThreadGoalPanel } from "../goal/ThreadGoalPanel";
import { ThreadUsagePanel } from "../usage/ThreadUsagePanel";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import type { UsageDashboardClient, UsageQueryFilter } from "@octant/client-runtime";

type WorkThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
type WorkProject = Extract<ProjectSummary, { readonly type: "work" }>;

export interface WorkThreadEnvironmentProps {
  readonly tab: WorkThreadWorkspaceTab;
  readonly active?: boolean;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly threadClient: WorkThreadClient;
  readonly initialThread?: WorkThread;
  readonly children: ReactNode;
  readonly agentRunClient?: AgentRunClient;
  readonly onOpenAgents?: () => void;
  readonly environmentOpen?: boolean;
  readonly goalClient?: GoalClient;
  readonly goalLoopClient?: GoalLoopClient;
  readonly usageDashboardClient?: UsageDashboardClient;
  readonly onOpenUsageDashboard?: (filter: UsageQueryFilter) => void;
}

/**
 * Resolves the Work Project through authoritative thread state, then mounts
 * the confined folder identity as a compact summary with a transient
 * disclosure. Failure to resolve the thread or its Project is represented as
 * unavailable instead of guessing a folder from renderer state.
 */
export function WorkThreadEnvironment(props: WorkThreadEnvironmentProps) {
  const environmentOpen = props.environmentOpen === true;
  const [project, setProject] = useState<WorkProject | undefined>(undefined);
  const [thread, setThread] = useState<WorkThread | undefined>(undefined);

  useEffect(() => {
    const initialThread = props.initialThread;
    if (initialThread !== undefined && String(initialThread.id) === String(props.tab.threadId)) {
      const initialProject = props.projects.find(
        (entry): entry is WorkProject =>
          entry.type === "work" && String(entry.id) === String(initialThread.projectId),
      );
      setProject(initialProject);
      setThread(initialThread);
      return;
    }
    let cancelled = false;
    setProject(undefined);
    setThread(undefined);
    void props.threadClient
      .bootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        const nextThread = bootstrap.threads.find(
          (candidate) => String(candidate.id) === String(props.tab.threadId),
        );
        const candidate = props.projects.find(
          (entry): entry is WorkProject =>
            entry.type === "work" && String(entry.id) === String(nextThread?.projectId),
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
  }, [props.initialThread, props.projects, props.tab.threadId, props.threadClient]);

  const projection = deriveWorkEnvironmentProjection({
    projectName: project?.name ?? "Work",
    ...(project === undefined ? {} : { boundRoot: project.binding.canonicalRoot }),
  });

  return (
    <div className="code-thread-environment">
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        open={environmentOpen}
        summary={{
          identity: projection.identity,
          ...(thread === undefined
            ? {}
            : { workingLocation: String(thread.workingDirectory ?? ".") }),
        }}
      >
        {props.agentRunClient === undefined ? null : (
          <EnvironmentSubagents
            client={props.agentRunClient}
            {...(props.onOpenAgents === undefined ? {} : { onOpenAgents: props.onOpenAgents })}
            threadId={String(props.tab.threadId)}
          />
        )}
        {props.usageDashboardClient === undefined ? null : (
          <ThreadUsagePanel
            client={props.usageDashboardClient}
            subjectType="work-thread"
            subjectId={String(props.tab.threadId)}
            {...(props.onOpenUsageDashboard === undefined
              ? {}
              : { onOpenUsageDashboard: props.onOpenUsageDashboard })}
          />
        )}
        {props.goalClient === undefined ? null : (
          /* Setting a Goal has no effect on an ordinary turn: nothing reads the
             objective until a loop runs it as the prompt of each round. It is
             an autopilot control, so it lives behind a disclosure that mounts
             only when opened rather than greeting every new task with a form. */
          <EnvironmentGroup title="Keep working on this unattended">
            <ThreadGoalPanel
              client={props.goalClient}
              {...(props.goalLoopClient === undefined ? {} : { loopClient: props.goalLoopClient })}
              threadId={String(props.tab.threadId)}
            />
          </EnvironmentGroup>
        )}
        {thread === undefined ? null : (
          <EnvironmentGroup
            summary={workingFolderLabel(thread.workingDirectory ?? ".")}
            title="Working folder"
          >
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
          </EnvironmentGroup>
        )}
      </ThreadEnvironmentPanel>
      <div className="code-thread-environment__content">{props.children}</div>
    </div>
  );
}
