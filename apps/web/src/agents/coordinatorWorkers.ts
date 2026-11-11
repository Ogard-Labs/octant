import { threadRowActivity, type ChatThreadNavigationItem } from "../shell/navigationModel";
import type { SubagentWorkerThread } from "./AgentHierarchyPanel";

/**
 * The workers a coordinator started, from the thread list a window already
 * holds, in that list's order. `undefined` for a thread that is not a
 * coordinator or has no listed workers, so the Agents tool shows no Workers
 * section and asks the host for nothing.
 *
 * Nothing here is new to the window: the same rows sit folded under the
 * coordinator in the sidebar.
 */
export function coordinatorWorkersOf(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  coordinatorThreadId: string | undefined,
): ReadonlyArray<SubagentWorkerThread> | undefined {
  if (coordinatorThreadId === undefined) return undefined;
  const coordinator = threads.find((thread) => thread.threadId === coordinatorThreadId);
  if (coordinator?.coordinator !== true) return undefined;
  const workers = threads
    .filter((thread) => thread.coordinatorThreadId === coordinatorThreadId)
    .map((thread): SubagentWorkerThread => {
      const activity = threadRowActivity(thread);
      return {
        threadId: thread.threadId,
        title: thread.title,
        ...(thread.provider === undefined ? {} : { provider: thread.provider }),
        state:
          activity === "working" || activity === "attention"
            ? activity
            : thread.completedAt === undefined
              ? "idle"
              : "done",
      };
    });
  return workers.length === 0 ? undefined : workers;
}
