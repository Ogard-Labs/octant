import { threadRowActivity, type ChatThreadNavigationItem } from "./navigationModel";

/**
 * Threads that finished a turn the person has not opened since. A running
 * thread is not waiting for review yet, and a snoozed or completed one left
 * the list on purpose, the same rule the sidebar's To review count follows.
 */
export function reviewWaitingCount(threads: ReadonlyArray<ChatThreadNavigationItem>): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.shelf !== undefined) continue;
    if (threadRowActivity(thread) === "working") continue;
    if (thread.unread === true) count += 1;
  }
  return count;
}

/** A row is running only while the host projects it as executing; a rested row never is. */
export function isRunningThread(thread: ChatThreadNavigationItem): boolean {
  return thread.shelf === undefined && threadRowActivity(thread) === "working";
}

/** How many navigation rows are running. */
export function runningThreadCount(threads: ReadonlyArray<ChatThreadNavigationItem>): number {
  return threads.filter(isRunningThread).length;
}
