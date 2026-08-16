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
  ) => Promise<CodeEnvironmentObservation>;
  readonly observeThread: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
    threadId: CodeThreadId,
    signal?: AbortSignal,
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

export class CodeEnvironmentService implements CodeEnvironmentServiceApi {
  constructor(
    private readonly options: {
      readonly projects: Pick<ProjectServiceApi, "bootstrap">;
      readonly git: Pick<GitEnvironmentPort, "observe">;
      readonly clock: () => string;
      readonly code?: CodeEnvironmentThreadSource;
    },
  ) {}

  async observe(
    windowId: WindowId,
    projectId: ProjectId,
    signal?: AbortSignal,
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

    const result = await this.options.git.observe(project.binding.canonicalRoot, signal);
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

    const result = await this.options.git.observe(root, signal);
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
}
