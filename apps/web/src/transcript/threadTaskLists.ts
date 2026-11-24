import { useEffect, useState, useSyncExternalStore } from "react";
import type { ThreadTaskProgress } from "./ThreadTasksPanel";

/**
 * The newest task list each open thread shows, for the optional Tasks dock
 * panel. The thread view already holds the list (from the turns it read and
 * watches), so it publishes what it shows here rather than the panel reading
 * the host a second time and drawing a different version of the same list.
 *
 * Renderer state only: it holds what is on screen and nothing the journal
 * does not already have. A thread's entry goes when its view unmounts.
 */
// Keyed by thread, then by the view that published, since one thread can be
// open in two panes and closing one must not clear the list the other shows.
const lists = new Map<string, Map<symbol, ThreadTaskProgress>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(threadId: string, view: symbol, progress: ThreadTaskProgress | undefined): void {
  const views = lists.get(threadId) ?? new Map<symbol, ThreadTaskProgress>();
  if (progress === undefined) views.delete(view);
  else views.set(view, progress);
  if (views.size === 0) lists.delete(threadId);
  else lists.set(threadId, views);
  notify();
}

/** Publishes a thread's newest task list while its view is mounted. */
export function usePublishThreadTaskList(
  threadId: string,
  progress: ThreadTaskProgress | undefined,
): void {
  const [view] = useState(() => Symbol("thread view"));
  useEffect(() => publish(threadId, view, progress), [threadId, view, progress]);
  useEffect(() => () => publish(threadId, view, undefined), [threadId, view]);
}

/** The newest task list the thread's view shows, or nothing when it shows none. */
export function useThreadTaskList(threadId: string): ThreadTaskProgress | undefined {
  return useSyncExternalStore(subscribe, () => {
    const views = lists.get(threadId);
    return views === undefined ? undefined : [...views.values()].at(-1);
  });
}
