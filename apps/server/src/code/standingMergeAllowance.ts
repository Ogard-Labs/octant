import type {
  AutomationDefinition,
  AutomationRun,
  CodeMergeStandingSource,
  CodeThread,
  Project,
} from "@octant/contracts";

/**
 * The stored choices that let an agent merge the pull request this thread owns
 * without asking for each act. The host reads them again at every merge, so
 * switching a choice off stops the next merge even in a thread that already
 * relied on it.
 *
 * The Project's setting covers every thread in that Project. A routine's choice
 * covers only the thread one of its runs created, and only while the routine
 * still allows it: the run's own copy and the live definition must both say so,
 * and the routine must be enabled and still bound to this Project.
 */
export function standingMergeAllowanceFor(input: {
  readonly thread: Pick<CodeThread, "projectId">;
  readonly project: Project | undefined;
  readonly run: AutomationRun | undefined;
  readonly routine: AutomationDefinition | undefined;
}): ReadonlyArray<CodeMergeStandingSource> {
  const allowances: CodeMergeStandingSource[] = [];
  if (input.project?.type === "code" && input.project.agentMerge === "enabled") {
    allowances.push("project");
  }
  const { run, routine } = input;
  if (
    run !== undefined &&
    routine !== undefined &&
    run.definitionSnapshot.agentMerge === "allowed" &&
    routine.agentMerge === "allowed" &&
    routine.lifecycle === "enabled" &&
    run.definitionSnapshot.mode === "code" &&
    run.definitionSnapshot.targetPolicy === "new-thread" &&
    String(run.definitionSnapshot.projectId) === String(input.thread.projectId) &&
    String(routine.projectId) === String(input.thread.projectId)
  ) {
    allowances.push("routine");
  }
  return allowances;
}
