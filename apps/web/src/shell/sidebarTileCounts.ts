import { threadRowActivity, type ChatThreadNavigationItem } from "./navigationModel";
import { isWaitingForReview } from "./runningNow";

export interface SidebarTileCounts {
  /** Threads the host projects as executing right now. */
  readonly running: number;
  /** Threads that finished a turn the person has not opened since. */
  readonly toReview: number;
  /** Threads the person completed since local midnight. */
  readonly doneToday: number;
}

/**
 * The counts the sidebar's tiles show for the current mode's rows. They read
 * the same facts the rows' status marks read, so a tile never claims a state
 * the list below it would contradict. A rested thread (snoozed or completed)
 * is neither running nor waiting for review: it left the list on purpose.
 */
export function countSidebarTiles(
  threads: ReadonlyArray<ChatThreadNavigationItem>,
  now: Date,
): SidebarTileCounts {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  let running = 0;
  let toReview = 0;
  let doneToday = 0;
  for (const thread of threads) {
    if (thread.shelf === "completed") {
      const completedAt =
        thread.completedAt === undefined ? Number.NaN : Date.parse(thread.completedAt);
      if (completedAt >= midnight && completedAt <= now.getTime()) doneToday += 1;
      continue;
    }
    if (thread.shelf !== undefined) continue;
    if (threadRowActivity(thread) === "working") running += 1;
    else if (isWaitingForReview(thread)) toReview += 1;
  }
  return { running, toReview, doneToday };
}
