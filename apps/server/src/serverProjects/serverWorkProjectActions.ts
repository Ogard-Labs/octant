import { posix } from "node:path";
import type { ProjectId, WindowId, WorkThreadId, WindowWorkspace } from "@octant/contracts";
import type { WorkThread } from "@octant/contracts/work-threads";
import { workThreadAccessOf } from "@octant/domain";
import { windowCanAccessWorkProject } from "../windowCodeProjectAccess";
import { serverWorkProjectOf } from "./serverWorkThreads";
import type { ServerProjectStore } from "./serverProjectStore";
import type { ServerWorkActionTask } from "./serverProjectActions";

/** A person's saved action uses the Work task's real server binding, never a local Project stand-in. */
export function createServerWorkActionTask(options: {
  readonly store: Pick<ServerProjectStore, "workProject">;
  readonly readThread: (id: WorkThreadId) => WorkThread | undefined;
  readonly workspace: (id: WindowId) => WindowWorkspace | undefined;
  readonly isWindowLive: (id: WindowId) => boolean;
  readonly workEnabled: () => boolean;
}): (
  windowId: WindowId,
  projectId: ProjectId,
  threadId: WorkThreadId,
) => Promise<ServerWorkActionTask | undefined> {
  const authorityOf = (thread: WorkThread) =>
    JSON.stringify({
      projectId: thread.projectId,
      binding: thread.bindingRevisionId,
      workingDirectory: thread.workingDirectory,
      workingFolderId: thread.workingFolderId,
      access: thread.access,
      provider: thread.providerInstanceId,
      model: thread.modelId,
      modelOptions: thread.modelOptionValues,
      handoff: thread.providerHandoff,
    });
  return async (windowId, projectId, threadId) => {
    const thread = options.readThread(threadId);
    if (thread === undefined) return undefined;
    const project = serverWorkProjectOf(options.store, thread);
    if (
      project === undefined ||
      String(thread.projectId) !== String(projectId) ||
      thread.workingFolderId !== undefined
    )
      return undefined;
    const authorityRevision = authorityOf(thread);
    const current = () => {
      const fresh = options.readThread(threadId);
      return (
        fresh !== undefined &&
        fresh.lifecycle === "active" &&
        fresh.completedAt === undefined &&
        fresh.completionConfirmed !== true &&
        serverWorkProjectOf(options.store, fresh)?.folder === project.folder &&
        authorityOf(fresh) === authorityRevision &&
        options.workEnabled() &&
        options.isWindowLive(windowId) &&
        windowCanAccessWorkProject({ workspace: options.workspace(windowId), projectId })
      );
    };
    if (!current()) return undefined;
    return {
      workThreadId: thread.id,
      root: posix.resolve(project.folder, thread.workingDirectory ?? "."),
      executionPolicy: workThreadAccessOf(thread.access).executionPolicy,
      authorityRevision,
      current,
    };
  };
}
