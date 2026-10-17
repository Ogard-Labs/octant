import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectId, WindowId, WindowWorkspace } from "@octant/contracts";
import type { PrincipalRouteContext } from "./principalRouteContext";
import { isRoutineHostScope } from "./routineHostScope";
import { windowCanAccessCodeProject } from "./windowCodeProjectAccess";

export interface CodeProjectAccessOptions {
  readonly readWorkspace: (scopeId: WindowId) => WindowWorkspace | undefined;
  readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
  /**
   * Whether a local window still holds its authority. A closed window is
   * revoked, but its persisted workspace stays behind.
   */
  readonly isWindowLive: (scopeId: WindowId) => boolean;
}

/** Bridges authenticated requests to Code services that still accept an opaque scope ID.
 * No device workspace or persistent permission is created by a remote read or command.
 */
export class CodeProjectAccess {
  readonly #requests = new AsyncLocalStorage<{
    readonly context: PrincipalRouteContext;
    active: boolean;
  }>();
  readonly #standing = new AsyncLocalStorage<true>();
  readonly #options: CodeProjectAccessOptions;

  constructor(options: CodeProjectAccessOptions) {
    this.#options = options;
  }

  async run<T>(context: PrincipalRouteContext, dispatch: () => Promise<T>): Promise<T> {
    const request = { context, active: true };
    return this.#requests.run(request, async () => {
      try {
        return await dispatch();
      } finally {
        // Async descendants can outlive dispatch; they must not retain admission.
        request.active = false;
      }
    });
  }

  /**
   * Runs `read` on the window's standing authority: its persisted binding,
   * judged when each check runs, with no request's admission. A Code turn's
   * tool call is an async descendant of the request that started the turn
   * and runs after that request ended, so inside it every check refuses as
   * deferred work. The Code runtime runs each of a turn's tool calls here:
   * the call gets what the window holds now, never what a request held.
   * A window that has closed holds nothing: its persisted workspace outlives
   * it, and closing it does not stop its turns.
   */
  standingAuthority<T>(read: () => T): T {
    return this.#requests.exit(() => this.#standing.run(true, read));
  }

  /**
   * Keeps the admission of the request that is running now, for a stream that
   * outlives it. The stream has no request of its own to judge each recheck
   * by, and judged outside the request it would read as deferred work and be
   * refused. What is kept is the principal and its lifetime, never a verdict:
   * the returned check is asked again each time and re-reads whether the
   * Project is still active (for a device) or the window's binding (for a
   * local window), and it refuses once the request's own signal has aborted.
   * Absent when no request admitted this scope.
   */
  retain(scopeId: WindowId): ((projectId: ProjectId) => boolean) | undefined {
    const request = this.#requests.getStore();
    if (
      request === undefined ||
      !request.active ||
      String(request.context.scopeId) !== String(scopeId)
    ) {
      return undefined;
    }
    const { context } = request;
    return (projectId) => {
      if (context.abortSignal?.aborted === true) return false;
      if (context.principal.kind === "remote-device") {
        return this.#options.hasActiveCodeProject(projectId);
      }
      return (
        this.#options.isWindowLive(scopeId) &&
        windowCanAccessCodeProject({
          workspace: this.#options.readWorkspace(scopeId),
          projectId,
          hasActiveCodeProject: this.#options.hasActiveCodeProject,
        })
      );
    };
  }

  canAccessProject(scopeId: WindowId, projectId: ProjectId): boolean {
    // A routine runs as the host, which owns every Project; a window's binding
    // narrows what that window drives, not what the host may. The dispatcher
    // has already matched the routine's captured Project before using this
    // scope, and dispatch started from a request must not inherit its scope.
    if (isRoutineHostScope(scopeId)) return this.#options.hasActiveCodeProject(projectId);
    const request = this.#requests.getStore();
    if (request !== undefined) {
      if (!request.active || request.context.abortSignal?.aborted === true) return false;
      if (String(request.context.scopeId) !== String(scopeId)) return false;
      if (request.context.principal.kind === "remote-device") {
        return this.#options.hasActiveCodeProject(projectId);
      }
    } else if (this.#standing.getStore() === true && !this.#options.isWindowLive(scopeId)) {
      return false;
    }
    return windowCanAccessCodeProject({
      workspace: this.#options.readWorkspace(scopeId),
      projectId,
      hasActiveCodeProject: this.#options.hasActiveCodeProject,
    });
  }
}
