import {
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeThread,
  type WorkThread,
  type Project,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";

interface Dependencies {
  readonly readCodeThread: (id: CodeThread["id"]) => CodeThread | undefined;
  readonly readWorkThread: (id: WorkThread["id"]) => WorkThread | undefined;
  readonly readProject: (id: ProjectId) => Project | undefined;
  readonly canUseWindow: (windowId: WindowId) => boolean;
  readonly windowHoldsProject: (
    windowId: WindowId,
    projectId: ProjectId,
    mode: "work" | "code",
  ) => boolean;
}

/** Reuses the host's task, Project and local-window ownership; creates no grant. */
export function createProductFeedbackThreadScope(deps: Dependencies) {
  return (windowId: WindowId, threadId: string) => {
    const read = () => {
      try {
        if (!deps.canUseWindow(windowId)) return undefined;
        const code = deps.readCodeThread(decodeCodeThreadId(threadId));
        const work = deps.readWorkThread(decodeWorkThreadId(threadId));
        if ((code === undefined) === (work === undefined)) return undefined;
        const found =
          code === undefined
            ? work === undefined || work.lifecycle !== "active"
              ? undefined
              : { mode: "work" as const, thread: work }
            : code.lifecycle === "archived"
              ? undefined
              : { mode: "code" as const, thread: code };
        if (found === undefined) return undefined;
        const project = deps.readProject(found.thread.projectId);
        if (
          project === undefined ||
          project.type === "chat" ||
          project.type !== found.mode ||
          project.lifecycle !== "active" ||
          !deps.windowHoldsProject(windowId, project.id, found.mode)
        )
          return undefined;
        return {
          mode: found.mode,
          proof: JSON.stringify([
            found.thread.id,
            found.thread.projectId,
            found.thread.bindingRevisionId,
            found.mode === "code"
              ? [found.thread.checkoutId, found.thread.repositoryId]
              : found.thread.workingDirectory,
            project.binding,
            project.bindingHistory.at(-1)?.revisionId,
          ]),
        };
      } catch {
        return undefined;
      }
    };
    const original = read();
    if (original === undefined) return undefined;
    return {
      mode: original.mode,
      current: () => {
        const latest = read();
        return (
          latest !== undefined && latest.mode === original.mode && latest.proof === original.proof
        );
      },
    };
  };
}
