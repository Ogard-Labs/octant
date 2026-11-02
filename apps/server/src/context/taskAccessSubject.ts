import type {
  CodeThread,
  CodeThreadId,
  CodeSettings,
  ContextSubjectRef,
  Project,
  ProjectId,
  WindowId,
  WorkAccess,
  WorkSettings,
  WorkThread,
  WorkThreadId,
} from "@octant/contracts";
import { decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import {
  defaultPermissionModeFor,
  defaultWorkPermissionModeFor,
  workThreadAccessOf,
} from "@octant/domain/guardrail-policy";
import type { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import type { TaskAccessSubjectFacts } from "./taskAccessFacts";

export interface TaskAccessSubjectDependencies {
  readonly code: (id: CodeThreadId) => CodeThread | undefined;
  readonly work: (id: WorkThreadId) => WorkThread | undefined;
  readonly project: (id: ProjectId) => Project | undefined;
  readonly codeSettings: () =>
    | Pick<CodeSettings, "defaultExecutionPolicy" | "defaultAutoApprove">
    | undefined;
  readonly workSettings: () => Pick<WorkSettings, "defaultAccess"> | undefined;
  readonly canAccessCodeProject: (scope: WindowId, project: ProjectId) => boolean;
  readonly session: Pick<CodeSessionAuthorityStore, "effectiveThread">;
  readonly activeCode: (thread: CodeThread) => CodeThread;
  readonly runningWork: (id: string) => WorkAccess | undefined;
  readonly workStanding?: (
    thread: WorkThread,
  ) => "project-unavailable" | "binding-changed" | undefined;
  readonly tainted: (id: string) => boolean;
}

/** Re-read the same existing Project rules synchronously after the route's awaited read gate. */
export function createTaskAccessSubjectReader(deps: TaskAccessSubjectDependencies) {
  return (subject: ContextSubjectRef, windowId: WindowId): TaskAccessSubjectFacts | undefined => {
    const id = String(subject.aggregateId);
    if (subject.aggregateType === "code-thread") {
      const thread = deps.code(decodeCodeThreadId(id));
      if (thread === undefined || !deps.canAccessCodeProject(windowId, thread.projectId))
        return undefined;
      const effective = deps.activeCode(deps.session.effectiveThread(windowId, thread));
      const project = deps.project(thread.projectId);
      const settings = deps.codeSettings();
      return {
        selected: thread,
        standing: thread.completionConfirmed
          ? "completed"
          : thread.lifecycle === "active"
            ? "active"
            : "inactive",
        effective,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        outsideContent: deps.tainted(id),
        ...(settings === undefined
          ? {}
          : {
              default: {
                mode: defaultPermissionModeFor({
                  project: project?.type === "code" ? project : undefined,
                  settings,
                }),
                scope:
                  project?.type === "code" &&
                  (project.defaultPermissionMode !== undefined ||
                    project.codeAccessPersistence === "project-default")
                    ? ("project" as const)
                    : ("global" as const),
              },
            }),
      };
    }
    if (subject.aggregateType !== "work-thread") return undefined;
    const thread = deps.work(decodeWorkThreadId(id));
    if (thread === undefined) return undefined;
    const project = deps.project(thread.projectId);
    if (project?.type !== "work" || project.lifecycle !== "active") return undefined;
    const settings = deps.workSettings();
    const access = deps.runningWork(id) ?? thread.access;
    return {
      selected: workThreadAccessOf(thread.access),
      turnRefusal: deps.workStanding?.(thread),
      standing: thread.completionConfirmed
        ? "completed"
        : thread.lifecycle === "active"
          ? "active"
          : "inactive",
      effective: workThreadAccessOf(access),
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
      outsideContent: deps.tainted(id),
      ...(settings === undefined
        ? {}
        : {
            default: {
              mode: defaultWorkPermissionModeFor({ project, settings }),
              scope:
                project.defaultPermissionMode !== undefined
                  ? ("project" as const)
                  : ("global" as const),
            },
          }),
    };
  };
}
