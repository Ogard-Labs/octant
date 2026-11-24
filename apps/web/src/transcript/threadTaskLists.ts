import { useEffect, useId, useSyncExternalStore } from "react";
import type { ThreadTaskProgress } from "./ThreadTasksPanel";

/**
 * The newest task list each open thread shows, for the optional Tasks dock
 * panel. The thread view already holds the list (from the turns it read and
 * watches), so it publishes what it shows here rather than the panel reading
 * the host a second time and drawing a different version of the same list.
 *
 * Renderer state only: it holds what is on screen and nothing the journal
 * does not already have. A view's entry goes when it unmounts.
 *
 * Entries are kept per view, since one thread can be open in two panes and
 * closing one must not clear the list the other shows, and each is stamped
 * when published, so the panel follows the freshest view rather than
 * whichever pane happened to mount last. The shell bundle carries this
 * module (Chat's dock offers Tasks from it), so it is kept small.
 */
const views = new Map<string, readonly [string, ThreadTaskProgress, number]>();
const listeners = new Set<() => void>();
let stamp = 0;

function notify(): void {
  for (const listener of listeners) listener();
}

/** Publishes a thread's newest task list while its view is mounted. */
export function usePublishThreadTaskList(
  threadId: string,
  progress: ThreadTaskProgress | undefined,
): void {
  const view = useId();
  useEffect(() => {
    if (progress === undefined) return undefined;
    views.set(view, [threadId, progress, (stamp += 1)]);
    notify();
    return () => {
      views.delete(view);
      notify();
    };
  }, [view, threadId, progress]);
}

/** The freshest task list any view of the thread shows, or nothing when none shows one. */
export function useThreadTaskList(threadId: string): ThreadTaskProgress | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => {
      let freshest: readonly [string, ThreadTaskProgress, number] | undefined;
      for (const entry of views.values()) {
        if (entry[0] === threadId && (freshest === undefined || entry[2] > freshest[2])) {
          freshest = entry;
        }
      }
      return freshest?.[1];
    },
  );
}
