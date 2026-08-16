import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  DEFAULT_CODE_NEW_THREAD_WORKSPACE,
  type CodeNewThreadWorkspace,
  type CodeProject,
  type Project,
  type ProjectSummary,
} from "@octant/contracts/projects";
import { ProjectPolicyRejected } from "./projectPolicy";

/**
 * Per-Project default for how new Code threads start.
 *
 * This is a Project habit, not a second workspace product: the only values are
 * the checkout kinds Code already creates, the create dialog still overrides
 * the habit for one thread without rewriting it, and nothing here discovers
 * worktrees or changes isolated-worktree rules for child runs.
 */

/** A Project record or summary that may carry the habit. */
type CodeWorkspaceHabitCarrier = Pick<CodeProject, "type" | "newThreadWorkspace">;

/**
 * Resolve the habit a Code Project's create path should preselect.
 *
 * Absence is not an error: Projects created before this habit existed, and
 * Projects whose
 * owner never chose, fall back to the current checkout because that is the
 * option which creates no worktree and no host state the user did not ask for.
 * A non-Code Project has no habit at all, which is also the conservative
 * default rather than a throw — the create dialog asks before it decides.
 */
export function resolveCodeNewThreadWorkspace(
  project: Project | ProjectSummary | CodeWorkspaceHabitCarrier | undefined,
): CodeNewThreadWorkspace {
  if (project === undefined || project.type !== "code") {
    return DEFAULT_CODE_NEW_THREAD_WORKSPACE;
  }
  return project.newThreadWorkspace ?? DEFAULT_CODE_NEW_THREAD_WORKSPACE;
}

/**
 * Record a new habit on a Code Project. Rejects a non-Code Project and a
 * no-op change so the journal never carries an event that changed nothing —
 * the same discipline `changeCodeProjectAccess` applies to the neighbouring
 * Project setting.
 */
export function changeCodeProjectNewThreadWorkspace(
  project: Project,
  newThreadWorkspace: CodeNewThreadWorkspace,
  updatedAt: UtcTimestamp,
): CodeProject {
  if (project.type !== "code") {
    throw new ProjectPolicyRejected(
      "binding-not-allowed",
      "Only Code Projects have a new-thread workspace default",
    );
  }
  if (resolveCodeNewThreadWorkspace(project) === newThreadWorkspace) {
    throw new ProjectPolicyRejected(
      "invalid-lifecycle",
      "Code Project new-thread workspace is already selected",
    );
  }
  return {
    ...project,
    newThreadWorkspace,
    version: (project.version + 1) as AggregateVersion,
    updatedAt,
  };
}
