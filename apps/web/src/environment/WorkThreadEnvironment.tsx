import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { WorkThread, ProjectSummary, WorkspaceTab } from "@octant/contracts";
import { deriveWorkEnvironmentProjection } from "@octant/domain/shell-policy";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { FolderOpen, Target } from "../ui/icons";
import { EnvironmentCard, EnvironmentGroup, EnvironmentRow } from "./EnvironmentGroup";
import { EnvironmentExtraFolders } from "./EnvironmentExtraFolders";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";
import {
  ThreadMoveComputerCard,
  type ThreadMoveEnvironment,
} from "./threadMove/ThreadMoveComputerCard";
import { ChangeWorkingFolder, workingFolderLabel } from "./WorkingDirectoryControl";
import { EnvironmentSubagents } from "./EnvironmentSubagents";
import { EnvironmentRoutines } from "./EnvironmentRoutines";
import { GOAL_REFRESH_INTERVAL_MS, ThreadGoalPanel } from "../goal/ThreadGoalPanel";
import { useGoalController } from "../goal/useGoalController";
import { scheduleVisibleInterval } from "../polling/documentVisibility";
import { ThreadUsagePanel } from "../usage/ThreadUsagePanel";
import type { GoalClient } from "@octant/client-runtime/goal-client";
import type { GoalLoopClient } from "@octant/client-runtime/goal-loop-client";
import type {
  AutomationClient,
  UsageDashboardClient,
  UsageQueryFilter,
} from "@octant/client-runtime";

type WorkThreadWorkspaceTab = Extract<WorkspaceTab, { readonly kind: "work-thread" }>;
type WorkProject = Extract<ProjectSummary, { readonly type: "work" }>;

export interface WorkThreadEnvironmentProps {
  /** Where the thread runs and how it moves to another computer; absent, no Computer card. */
  readonly threadMove?: ThreadMoveEnvironment;
  readonly tab: WorkThreadWorkspaceTab;
  readonly active?: boolean;
  readonly projects: ReadonlyArray<ProjectSummary>;
  readonly threadClient: WorkThreadClient;
  readonly initialThread?: WorkThread;
  readonly children: ReactNode;
  readonly agentRunClient?: AgentRunClient;
  /** Opens the Agents tool; with a run id, on that subagent. */
  readonly onOpenAgents?: (runId?: string) => void;
  readonly automationClient?: AutomationClient;
  /** Opens the Automation Center on this routine. */
  readonly onOpenRoutine?: (automationId: string) => void;
  readonly environmentOpen?: boolean;
  readonly goalClient?: GoalClient;
  readonly goalLoopClient?: GoalLoopClient;
  readonly usageDashboardClient?: UsageDashboardClient;
  readonly spendCeilingClient?: import("@octant/client-runtime").SpendCeilingClient;
  /** Whether the Usage group shows its spend ceiling row when no ceiling is set. */
  readonly spendCeilingShown?: boolean;
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
  const workingFolderRow = useRef<HTMLButtonElement>(null);

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

  // The goal group exists only once there is a goal (or one is being set), so a
  // task without one reads the host once and shows nothing for it. Until then
  // the read repeats while the window is visible, because the lead can set a
  // goal mid-thread.
  const goalController = useGoalController({
    client: props.goalClient,
    enabled: props.goalClient !== undefined,
    threadId: String(props.tab.threadId),
  });
  const [settingGoal, setSettingGoal] = useState(false);
  const goalShown = goalController.goal !== null || settingGoal;
  const { reload: reloadGoal } = goalController;
  // A refused or unavailable read will not change on its own, so asking again
  // every few seconds would only repeat the refusal.
  const goalReadRefused =
    goalController.status === "unauthorized" || goalController.status === "unavailable";
  useEffect(() => {
    if (props.goalClient === undefined || goalShown || goalReadRefused) return;
    const stop = scheduleVisibleInterval(reloadGoal, GOAL_REFRESH_INTERVAL_MS);
    return () => stop();
  }, [goalReadRefused, goalShown, props.goalClient, reloadGoal]);
  const routinesShown = props.automationClient !== undefined && project !== undefined;
  const showGoalFallback = props.goalClient !== undefined && !goalShown && !routinesShown;

  const projection = deriveWorkEnvironmentProjection({
    projectName: project?.name ?? "Work",
    ...(project === undefined ? {} : { boundRoot: project.binding.canonicalRoot }),
  });

  return (
    <div className="code-thread-environment">
      <ThreadEnvironmentPanel
        {...(props.active === undefined ? {} : { active: props.active })}
        {...(props.threadMove === undefined
          ? {}
          : {
              computer: (
                <ThreadMoveComputerCard
                  {...props.threadMove}
                  thread={{ mode: "work", threadId: String(props.tab.threadId) }}
                  threadTitle={props.tab.title}
                />
              ),
            })}
        open={environmentOpen}
        mode="work"
        projectName={project?.name}
        summary={{
          identity: projection.identity,
          ...(thread === undefined
            ? {}
            : { workingLocation: String(thread.workingDirectory ?? ".") }),
        }}
      >
        <EnvironmentCard>
          {props.agentRunClient === undefined ? null : (
            <EnvironmentSubagents
              client={props.agentRunClient}
              {...(props.onOpenAgents === undefined ? {} : { onOpenAgents: props.onOpenAgents })}
              threadId={String(props.tab.threadId)}
            />
          )}
          {props.automationClient === undefined || project === undefined ? null : (
            <EnvironmentRoutines
              client={props.automationClient}
              mode="work"
              {...(props.goalClient === undefined || goalShown
                ? {}
                : { onSetGoal: () => setSettingGoal(true) })}
              {...(props.onOpenRoutine === undefined ? {} : { onOpenRoutine: props.onOpenRoutine })}
              projectId={String(project.id)}
              threadId={String(props.tab.threadId)}
            />
          )}
          {props.usageDashboardClient === undefined &&
          props.spendCeilingClient === undefined ? null : (
            <ThreadUsagePanel
              client={props.usageDashboardClient}
              subjectType="work-thread"
              subjectId={String(props.tab.threadId)}
              {...(project === undefined ? {} : { projectId: String(project.id) })}
              {...(props.spendCeilingClient === undefined
                ? {}
                : { spendCeilingClient: props.spendCeilingClient })}
              {...(props.spendCeilingShown === true ? { spendCeilingShown: true } : {})}
              {...(props.onOpenUsageDashboard === undefined
                ? {}
                : { onOpenUsageDashboard: props.onOpenUsageDashboard })}
            />
          )}
          {props.goalClient === undefined || !goalShown ? null : (
            /* Setting a Goal has no effect on an ordinary turn: nothing reads the
             objective until a loop runs it as the prompt of each round. So the
             group shows only once a goal exists, or while one is being set from
             the "+" menu, and carries the one heading "Goal" like Code's does
             (maintainer request 2026-11-17: quieter Environment panel). */
            <EnvironmentGroup defaultOpen icon={Target} title="Goal">
              <ThreadGoalPanel
                client={props.goalClient}
                {...(props.goalLoopClient === undefined
                  ? {}
                  : { loopClient: props.goalLoopClient })}
                threadId={String(props.tab.threadId)}
              />
            </EnvironmentGroup>
          )}
          {showGoalFallback ? (
            /* Without a routines row there is no "+" to set a goal from, and the
               goal must stay reachable. */
            <EnvironmentRow
              icon={Target}
              label="Set a goal…"
              onClick={() => setSettingGoal(true)}
            />
          ) : null}
          {thread === undefined ? null : (
            <EnvironmentGroup
              headerRef={workingFolderRow}
              icon={FolderOpen}
              summary={
                thread.workingFolderId === undefined
                  ? workingFolderLabel(thread.workingDirectory ?? ".")
                  : `${project?.workingFolders?.find((folder) => folder.id === thread.workingFolderId)?.label ?? "Working folder unavailable"}${String(thread.workingDirectory ?? ".") === "." ? "" : ` / ${thread.workingDirectory}`}`
              }
              title="Working folder"
              {...(thread.workingFolderId === undefined
                ? {}
                : {
                    // The long form of the fixed-folder note, kept where a person
                    // can still read it (maintainer request 2026-11-17).
                    hint: "This task's provider, terminal, actions and new artifacts use its recorded folder. Existing artifacts keep their own recorded destination.",
                  })}
            >
              {thread.workingFolderId === undefined ? (
                <ChangeWorkingFolder
                  row={workingFolderRow}
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
              ) : (
                <p>Fixed for this task. Start a new task to change it.</p>
              )}
            </EnvironmentGroup>
          )}
          <EnvironmentExtraFolders folders={project?.extraFolders} />
        </EnvironmentCard>
      </ThreadEnvironmentPanel>
      <div className="code-thread-environment__content">{props.children}</div>
    </div>
  );
}
