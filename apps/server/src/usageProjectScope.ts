import type { WindowWorkspace } from "@octant/contracts";

/**
 * The usage a read is allowed to cover.
 *
 * Stated by the caller and never derived from the request, because the request
 * is caller-supplied and cannot carry authority. There is deliberately no
 * host-wide member: every usage read is narrowed by one of these two, so a
 * caller cannot spell "all Projects" at all.
 *
 * - `projects` narrows to subjects the durable thread projections place in one
 *   of the listed Projects. An empty list reads nothing rather than everything.
 * - `unfiled` narrows to subjects the host cannot place in any Project — an
 *   unfiled thread, or a subject type that carries no Project at all. It is the
 *   complement of `projects`, never a superset of it.
 */
export type UsageProjectScope =
  | { readonly kind: "unfiled" }
  | { readonly kind: "projects"; readonly projectIds: ReadonlyArray<string> };

/**
 * Resolve the scope of an authenticated window from the window's own workspace.
 *
 * A window capability proves the caller is a live renderer of this host; it says
 * nothing about which Project that renderer is in. Usage detail names providers,
 * models, Projects, threads, and token counts, so every usage read resolves its
 * scope here — from the workspace the host persisted for that window, never from
 * anything the caller supplied.
 *
 * Usage surfaces are cross-mode, so a bound window's scope is every Project it
 * is bound to right now: a window in Chat on one Project and Code on another may
 * see both, because both are its own.
 *
 * A window bound to no Project — the default workspace, and any window that has
 * not persisted one — resolves to `unfiled`, not to the host ledger. "Bound to
 * nothing" is not authority over everything, and `/api/usage/` is
 * remote-forwarded, so widening here would hand an unbound remote window every
 * Project's rows. Denying the read instead would break the default workspace
 * that every window starts in, and reading nothing would hide the window's own
 * unfiled usage, which is real and belongs to no one else. `unfiled` is the
 * honest answer: exactly the rows the host cannot attribute to any Project.
 */
export function resolveWindowProjectScope(
  workspace: WindowWorkspace | undefined,
): UsageProjectScope {
  if (workspace === undefined) return { kind: "unfiled" };
  const projectIds = [
    ...new Set(
      Object.values(workspace.contextByMode)
        .map((context) => context.projectId)
        .filter((projectId) => projectId !== null)
        .map(String),
    ),
  ];
  return projectIds.length === 0 ? { kind: "unfiled" } : { kind: "projects", projectIds };
}
