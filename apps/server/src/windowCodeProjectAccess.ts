import type { ProjectId, WindowWorkspace } from "@octant/contracts";

/**
 * Decide whether an authenticated window may reach a Code Project.
 *
 * Binding is taken from the window's own persisted workspace, never from a
 * caller-supplied scope. A window already bound to Project A must not drive
 * Project B's terminals or turns even when B is an active Code Project on this
 * host. An unbound window — the default workspace, and any window that has not
 * persisted a Code Project — keeps today's host-local listing of active Code
 * Projects so first-run can still bootstrap.
 */
export function windowCanAccessCodeProject(input: {
  readonly workspace: WindowWorkspace | undefined;
  readonly projectId: ProjectId;
  readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
}): boolean {
  const bound = input.workspace?.contextByMode.code.projectId;
  if (bound != null) {
    return String(bound) === String(input.projectId) && input.hasActiveCodeProject(input.projectId);
  }
  return input.hasActiveCodeProject(input.projectId);
}
