import type { ProjectId, WindowWorkspace } from "@octant/contracts";
import { windowAdmitsProject } from "@octant/domain/shell-policy";

/**
 * Decide whether an authenticated window may reach a Code Project.
 *
 * Binding is taken from the window's own persisted workspace, never from a
 * caller-supplied scope: the window's lead Project and the Projects of the
 * panes it shows. A window showing only Project A must not drive Project B's
 * terminals or turns even when B is an active Code Project on this host. An unbound window — the default workspace, and any window that has not
 * persisted a Code Project — cannot list or drive those terminals and turns
 * either. First-run still binds a Project through the Project catalog and
 * shell context switch; that bind is the authority transition, not Code
 * bootstrap listing every active Project.
 */
export function windowCanAccessCodeProject(input: {
  readonly workspace: WindowWorkspace | undefined;
  readonly projectId: ProjectId;
  readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
}): boolean {
  const workspace = input.workspace;
  if (workspace === undefined) return false;
  return (
    windowAdmitsProject(workspace, "code", input.projectId) &&
    input.hasActiveCodeProject(input.projectId)
  );
}

/**
 * Decide whether an authenticated window may reach a Work Project's terminal:
 * the Work Project its own persisted workspace binds, never one a caller
 * names, exactly as {@link windowCanAccessCodeProject} decides for Code.
 */
export function windowCanAccessWorkProject(input: {
  readonly workspace: WindowWorkspace | undefined;
  readonly projectId: ProjectId;
}): boolean {
  return (
    input.workspace !== undefined && windowAdmitsProject(input.workspace, "work", input.projectId)
  );
}
