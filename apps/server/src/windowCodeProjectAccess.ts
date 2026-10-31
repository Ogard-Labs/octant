import type { ProjectId, WindowWorkspace } from "@octant/contracts";

/**
 * Decide whether an authenticated window may reach a Code Project.
 *
 * Binding is taken from the window's own persisted workspace, never from a
 * caller-supplied scope. A window already bound to Project A must not drive
 * Project B's terminals or turns even when B is an active Code Project on this
 * host. An unbound window — the default workspace, and any window that has not
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
  const bound = input.workspace?.contextByMode.code.projectId;
  if (bound == null) return false;
  return String(bound) === String(input.projectId) && input.hasActiveCodeProject(input.projectId);
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
  const bound = input.workspace?.contextByMode.work.projectId;
  return bound != null && String(bound) === String(input.projectId);
}
