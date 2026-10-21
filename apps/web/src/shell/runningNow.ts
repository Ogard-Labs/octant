import { threadRowActivity, type ChatThreadNavigationItem } from "./navigationModel";

/**
 * The one rule behind the sidebar's To review count and the Review page's
 * list, so the number and the rows can never disagree.
 */
export function isWaitingForReview(thread: ChatThreadNavigationItem): boolean {
  return (
    thread.shelf === undefined && threadRowActivity(thread) !== "working" && thread.unread === true
  );
}

/** A row is running only while the host projects it as executing; a rested row never is. */
export function isRunningThread(thread: ChatThreadNavigationItem): boolean {
  return thread.shelf === undefined && threadRowActivity(thread) === "working";
}
