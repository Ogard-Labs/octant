import type { WorkThreadCommandResult, WorkThreadId, ProjectId, WindowId } from "@octant/contracts";
import type { WorkThreadRouteService } from "../workThreadRoutes";
import type { WorkflowThreadLifecycle } from "./workflowService";

export interface WorkThreadWorkflowPort {
  recordThreadLifecycle(input: {
    readonly projectId: ProjectId;
    readonly relatedThreadId: WorkThreadId;
    readonly label: string;
    readonly lifecycle: WorkflowThreadLifecycle;
  }): void;
  confirmCompletion?(input: { readonly relatedThreadId: WorkThreadId }): void;
}

export interface WorkThreadWorkflowHookDependencies {
  readonly threads: WorkThreadRouteService;
  readonly workflows: WorkThreadWorkflowPort;
}

/**
 * Wraps the authoritative `WorkThreadRouteService` so every successful
 * thread command also feeds the Work workflow projection with the thread's
 * resulting lifecycle fact. This is purely a downstream side channel: the
 * wrapped service performs the real authority check and journal write before
 * this ever runs, this hook never changes the returned result or an
 * underlying rejection, and any workflow-tracking failure is swallowed so it
 * can never turn a successful thread command into a failed one. Reacting to
 * the *resulting* lifecycle (rather than switching on command kind) makes
 * this correct for every command that can produce a `thread-created` or
 * `thread-updated` result, including future command kinds, without needing
 * to enumerate them here.
 */
export function withWorkflowLifecycle(
  dependencies: WorkThreadWorkflowHookDependencies,
): WorkThreadRouteService {
  return {
    bootstrap: (authenticatedWindowId: WindowId) =>
      dependencies.threads.bootstrap(authenticatedWindowId),
    async execute(authenticatedWindowId: WindowId, input: unknown) {
      const result = await dependencies.threads.execute(authenticatedWindowId, input);
      recordIfLifecycleFact(dependencies.workflows, input, result);
      return result;
    },
  };
}

function recordIfLifecycleFact(
  workflows: WorkThreadWorkflowPort,
  input: unknown,
  result: WorkThreadCommandResult,
): void {
  if (!("thread" in result)) return;
  try {
    if (result.kind === "thread-completion-confirmed") {
      workflows.confirmCompletion?.({ relatedThreadId: result.thread.id });
      return;
    }
    if (!isLifecycleCommand(input)) return;
    workflows.recordThreadLifecycle({
      projectId: result.thread.projectId,
      relatedThreadId: result.thread.id,
      label: result.thread.title,
      lifecycle: result.thread.lifecycle,
    });
  } catch {
    // Best-effort side channel; never let workflow tracking affect the
    // already-successful thread command result.
  }
}

function isLifecycleCommand(input: unknown): boolean {
  if (typeof input !== "object" || input === null || !("kind" in input)) return false;
  const kind = (input as { readonly kind?: unknown }).kind;
  return kind === "create-work-thread" || kind === "change-work-thread-lifecycle";
}
