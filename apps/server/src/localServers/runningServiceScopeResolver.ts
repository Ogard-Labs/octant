import type { CodeCheckoutIdentity, CodeThread, WindowId } from "@octant/contracts";
import type { ProjectService } from "../projectService";
import type {
  LocalServerHostBinding,
  LocalServerHostScopeResolver,
  RunningServiceOrigin,
} from "./localServerService";

/**
 * How many threads' own worktrees one request resolves. Each is one small
 * receipt read, so the bound keeps a window with a very long thread history from
 * turning every start-screen refresh into hundreds of file reads; a thread past
 * it is still attributed to its Project, only not named as the thread.
 */
export const RUNNING_SERVICE_THREAD_LIMIT = 200;

type ManagedWorktreeCheckout = Extract<CodeCheckoutIdentity, { readonly kind: "managed-worktree" }>;

export interface RunningServiceSource {
  readonly readThreads: () => ReadonlyArray<CodeThread>;
  readonly readCheckout: (checkoutId: CodeThread["checkoutId"]) => CodeCheckoutIdentity | undefined;
  /**
   * Canonical folder of a thread's own managed worktree, proved by the
   * ownership receipt the host wrote when it made it. `undefined` when the
   * receipt does not vouch for it: an unproven folder is never a root a listener
   * can be attributed to.
   */
  readonly managedWorktreeRoot: (
    thread: CodeThread,
    checkout: ManagedWorktreeCheckout,
    repositoryRoot: string,
  ) => Promise<string | undefined>;
  /** PIDs of processes Octant started and still owns. */
  readonly ownedPids: () => ReadonlySet<number>;
}

export interface RunningServiceScopeOptions {
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly source: RunningServiceSource;
}

/**
 * Resolve what one window may see in the start screen's Running services.
 *
 * The origins are the active Code Projects the Project bootstrap lists, plus
 * the own worktree of each of their live threads. That bootstrap does not vary
 * by window today, so this is every active Code Project on the host, the same
 * set the per-thread Local servers route resolves against; a remote window is
 * not narrowed to fewer Projects here. Nothing here discovers a folder outside
 * those Projects, so a listener outside every origin is never attributed and
 * never listed.
 */
export function createRunningServiceScopeResolver(
  options: RunningServiceScopeOptions,
): LocalServerHostScopeResolver {
  return {
    async resolve(
      authenticatedWindowId: WindowId,
      signal?: AbortSignal,
    ): Promise<LocalServerHostBinding | undefined> {
      const bootstrap = await options.projects.bootstrap(authenticatedWindowId);
      if (signal?.aborted === true) return undefined;

      const projects = new Map<string, { readonly name: string; readonly root: string }>();
      const origins: RunningServiceOrigin[] = [];
      for (const project of bootstrap.active) {
        if (project.type !== "code" || project.lifecycle !== "active") continue;
        const root = project.binding.canonicalRoot;
        projects.set(String(project.id), { name: project.name, root });
        origins.push({
          root,
          projectId: project.id,
          projectName: project.name,
          posture: "approval-gated",
        });
      }

      const threads = options.source
        .readThreads()
        .filter(
          (thread) => thread.lifecycle !== "archived" && projects.has(String(thread.projectId)),
        )
        .slice(0, RUNNING_SERVICE_THREAD_LIMIT);
      const own = await Promise.all(
        threads.map(async (thread): Promise<RunningServiceOrigin | undefined> => {
          const project = projects.get(String(thread.projectId));
          const checkout = options.source.readCheckout(thread.checkoutId);
          if (project === undefined || checkout?.kind !== "managed-worktree") return undefined;
          const root = await options.source.managedWorktreeRoot(thread, checkout, project.root);
          if (root === undefined || root === project.root) return undefined;
          return {
            root,
            projectId: thread.projectId,
            projectName: project.name,
            thread: { threadId: thread.id, title: thread.title },
            ...(checkout.head.kind === "branch" ? { branch: checkout.head.name } : {}),
            posture: thread.executionPolicy,
          };
        }),
      );
      for (const origin of own) {
        if (origin !== undefined) origins.push(origin);
      }
      return { origins, ownedPids: options.source.ownedPids() };
    },
  };
}
