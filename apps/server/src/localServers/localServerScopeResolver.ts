import type {
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeThread,
  CodeThreadId,
  ProjectId,
  WindowId,
} from "@octant/contracts";
import type { ProjectService } from "../projectService";
import type { LocalServerScopeBinding, LocalServerScopeResolver } from "./localServerService";

export interface CodeThreadLocalServerSource {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  /** Canonical root of the checkout this thread is bound to, or undefined. */
  readonly resolveCheckoutRoot: (
    authenticatedWindowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  /** PIDs of processes Octant started and still owns, e.g. thread terminals. */
  readonly ownedPids: () => ReadonlySet<number>;
}

export interface CodeThreadLocalServerScopeOptions {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly source: CodeThreadLocalServerSource;
}

/**
 * Resolve the authority scope for one Local servers request.
 *
 * Returning `undefined` is the fail-closed answer for every reason a request
 * cannot be served: the thread is not in this Project, the Project is not an
 * active Code Project reachable from this window, or the checkout root cannot
 * be resolved. Local servers requires a bound Code Project, so a thread the
 * window cannot resolve one for simply has no scope rather than a degraded one.
 *
 * The thread's own execution policy becomes the posture, which is what makes a
 * Plan thread able to list and open but never stop.
 *
 * The requesting actor is deliberately absent here. It belongs to the request's
 * authenticated principal, not to this long-lived binding, so the service
 * supplies it per request and no construction-time default can silently make a
 * paired device look like the host user.
 */
export function createCodeThreadLocalServerScopeResolver(
  options: CodeThreadLocalServerScopeOptions,
): LocalServerScopeResolver {
  return {
    async resolve(
      authenticatedWindowId: WindowId,
      threadId: CodeThreadId,
      projectId: ProjectId,
      signal?: AbortSignal,
    ): Promise<LocalServerScopeBinding | undefined> {
      const thread = options.source.readThread(threadId);
      if (thread === undefined || thread.projectId !== projectId) return undefined;

      const bootstrap = await options.projects.bootstrap(authenticatedWindowId);
      const project = bootstrap.active.find((candidate) => candidate.id === projectId);
      if (project === undefined || project.type !== "code" || project.lifecycle !== "active") {
        return undefined;
      }

      const checkout = options.source.readCheckout(thread.checkoutId);
      if (checkout === undefined) return undefined;
      const currentCheckoutRoot = await options.source.resolveCheckoutRoot(
        authenticatedWindowId,
        thread,
        checkout,
        signal,
      );
      if (currentCheckoutRoot === undefined) return undefined;

      // Other Code Projects this window can already see are the only "user
      // project" roots the classifier trusts; nothing here discovers folders
      // the window has no binding for.
      const userProjectRoots = bootstrap.active
        .filter((candidate) => candidate.type === "code")
        .map((candidate) => candidate.binding.canonicalRoot);

      return {
        threadId,
        projectId,
        currentCheckoutRoot,
        userProjectRoots: [...new Set([currentCheckoutRoot, ...userProjectRoots])],
        posture: thread.executionPolicy,
        ownedPids: options.source.ownedPids(),
      };
    },
  };
}
