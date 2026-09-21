import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectId, WindowId, WindowWorkspace } from "@octant/contracts";
import type { PrincipalRouteContext } from "./principalRouteContext";
import { windowCanAccessCodeProject } from "./windowCodeProjectAccess";

/** Bridges authenticated requests to Code services that still accept an opaque scope ID.
 * No device workspace or persistent permission is created by a remote read or command.
 */
export class CodeProjectAccess {
  readonly #requests = new AsyncLocalStorage<{
    readonly context: PrincipalRouteContext;
    active: boolean;
  }>();
  readonly #options: {
    readonly readWorkspace: (scopeId: WindowId) => WindowWorkspace | undefined;
    readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
  };

  constructor(options: {
    readonly readWorkspace: (scopeId: WindowId) => WindowWorkspace | undefined;
    readonly hasActiveCodeProject: (projectId: ProjectId) => boolean;
  }) {
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

  canAccessProject(scopeId: WindowId, projectId: ProjectId): boolean {
    const request = this.#requests.getStore();
    if (request !== undefined) {
      if (!request.active || request.context.abortSignal?.aborted === true) return false;
      if (String(request.context.scopeId) !== String(scopeId)) return false;
      if (request.context.principal.kind === "remote-device") {
        return this.#options.hasActiveCodeProject(projectId);
      }
    }
    return windowCanAccessCodeProject({
      workspace: this.#options.readWorkspace(scopeId),
      projectId,
      hasActiveCodeProject: this.#options.hasActiveCodeProject,
    });
  }
}
