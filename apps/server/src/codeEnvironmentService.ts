import {
  type CodeCheckoutIdentity,
  decodeCodeEnvironmentObservation,
  type CodeEnvironmentObservation,
  type CodeThread,
  type CodeThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { GitEnvironmentPort } from "./gitEnvironmentPort";
import { ProjectServiceError, type ProjectServiceApi } from "./projectService";

export interface CodeEnvironmentServiceApi {
  readonly observe: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
    signal?: AbortSignal,
    fresh?: boolean,
  ) => Promise<CodeEnvironmentObservation>;
  readonly observeThread: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
    fresh?: boolean,
  ) => Promise<CodeEnvironmentObservation>;
}

export interface CodeEnvironmentThreadSource {
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCheckout: (checkoutId: CodeThread["checkoutId"]) => CodeCheckoutIdentity | undefined;
  readonly resolveCheckoutRoot: (
    authenticatedWindowId: WindowId,
    thread: CodeThread,
    checkout: CodeCheckoutIdentity,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
}

const DEFAULT_MAX_CACHED_ROOTS = 64;

export class CodeEnvironmentService implements CodeEnvironmentServiceApi {
  readonly #gitObservations = new Map<
    string,
    { readonly expiresAt: number; readonly observation: ReturnType<GitEnvironmentPort["observe"]> }
  >();
  readonly #now: () => number;
  readonly #cacheMs: number;
  readonly #maxCachedRoots: number;

  constructor(
    private readonly options: {
      readonly projects: Pick<ProjectServiceApi, "bootstrap">;
      readonly git: Pick<GitEnvironmentPort, "observe">;
      readonly clock: () => string;
      readonly code?: CodeEnvironmentThreadSource;
      readonly now?: () => number;
      readonly cacheMs?: number;
      readonly maxCachedRoots?: number;
    },
  ) {
    this.#now = options.now ?? Date.now;
    this.#cacheMs = options.cacheMs ?? 5_000;
    this.#maxCachedRoots = options.maxCachedRoots ?? DEFAULT_MAX_CACHED_ROOTS;
    if (!Number.isSafeInteger(this.#maxCachedRoots) || this.#maxCachedRoots < 1) {
      throw new Error("Git observation cache size must be positive.");
    }
  }

  async observe(
    windowId: WindowId,
    projectId: ProjectId,
    signal?: AbortSignal,
    fresh = false,
  ): Promise<CodeEnvironmentObservation> {
    const bootstrap = await this.options.projects.bootstrap(windowId);
    const project = [...bootstrap.active, ...bootstrap.archived].find(
      (candidate) => candidate.id === projectId,
    );
    if (project === undefined)
      throw new ProjectServiceError({
        category: "not-found",
        message: "Project was not found.",
      });
    if (project.type !== "code" || project.lifecycle !== "active")
      throw new ProjectServiceError({
        category: "invalid",
        message: "Environment inspection requires an active Code Project.",
      });

    const result = await waitForGitObservation(
      this.#observeGit(project.binding.canonicalRoot, fresh),
      signal,
    );
    const base = {
      projectId: project.id,
      projectName: project.name,
      observedAt: this.options.clock(),
    };
    return decodeCodeEnvironmentObservation(
      result.status === "ready"
        ? { ...base, ...result }
        : {
            ...base,
            status: result.status,
            reason:
              result.status === "unavailable"
                ? "Git is not initialized or the Project root is unavailable."
                : "Octant could not inspect Git state.",
          },
    );
  }

  async observeThread(
    windowId: WindowId,
    projectId: ProjectId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
    fresh = false,
  ): Promise<CodeEnvironmentObservation> {
    const code = this.options.code;
    if (code === undefined)
      throw new ProjectServiceError({
        category: "unavailable",
        message: "Code thread environment authority is unavailable.",
      });
    const thread = code.readThread(threadId);
    if (thread === undefined || thread.projectId !== projectId)
      throw new ProjectServiceError({
        category: "not-found",
        message: "Code thread was not found.",
      });

    const bootstrap = await this.options.projects.bootstrap(windowId);
    const project = [...bootstrap.active, ...bootstrap.archived].find(
      (candidate) => candidate.id === projectId,
    );
    if (project === undefined)
      throw new ProjectServiceError({
        category: "not-found",
        message: "Project was not found.",
      });
    if (project.type !== "code" || project.lifecycle !== "active")
      throw new ProjectServiceError({
        category: "invalid",
        message: "Environment inspection requires an active Code Project.",
      });

    const checkout = code.readCheckout(thread.checkoutId);
    if (
      checkout === undefined ||
      checkout.availability !== "available" ||
      checkout.repositoryId !== thread.repositoryId
    )
      throw new ProjectServiceError({
        category: "unavailable",
        message: "The Code thread checkout is unavailable.",
      });
    const root = await code.resolveCheckoutRoot(windowId, thread, checkout, signal);
    if (root === undefined)
      throw new ProjectServiceError({
        category: "unavailable",
        message: "The Code thread checkout is unavailable.",
      });

    const result = await waitForGitObservation(this.#observeGit(root, fresh), signal);
    const base = {
      projectId: project.id,
      projectName: project.name,
      threadId: thread.id,
      checkoutId: checkout.id,
      workingDirectory: thread.workingDirectory ?? ".",
      threadVersion: thread.version,
      observedAt: this.options.clock(),
    };
    return decodeCodeEnvironmentObservation(
      result.status === "ready"
        ? { ...base, ...result }
        : {
            ...base,
            status: result.status,
            reason:
              result.status === "unavailable"
                ? "Git is not initialized or the Code thread checkout is unavailable."
                : "Octant could not inspect the Code thread checkout.",
          },
    );
  }

  #observeGit(root: string, fresh = false): ReturnType<GitEnvironmentPort["observe"]> {
    const now = this.#now();
    for (const [cachedRoot, entry] of this.#gitObservations) {
      if (entry.expiresAt <= now) this.#gitObservations.delete(cachedRoot);
    }
    const cached = this.#gitObservations.get(root);
    if (!fresh && cached !== undefined && cached.expiresAt > now) return cached.observation;
    this.#gitObservations.delete(root);
    while (this.#gitObservations.size >= this.#maxCachedRoots) {
      const oldestRoot = this.#gitObservations.keys().next().value;
      if (typeof oldestRoot !== "string") break;
      this.#gitObservations.delete(oldestRoot);
    }
    // A cached observation belongs to the service, not whichever renderer
    // happened to ask first. Callers may abandon their own wait without
    // canceling the shared Git probe for every other tab.
    const observation = this.options.git.observe(root);
    this.#gitObservations.set(root, { expiresAt: now + this.#cacheMs, observation });
    void observation.catch(() => {
      if (this.#gitObservations.get(root)?.observation === observation) {
        this.#gitObservations.delete(root);
      }
    });
    return observation;
  }
}

function waitForGitObservation(
  observation: ReturnType<GitEnvironmentPort["observe"]>,
  signal?: AbortSignal,
): ReturnType<GitEnvironmentPort["observe"]> {
  if (signal === undefined) return observation;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    observation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
