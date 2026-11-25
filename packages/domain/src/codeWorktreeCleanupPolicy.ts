/**
 * Pure rule for when a managed worktree folder qualifies for a restorable
 * cleanup. It reads the person's settings and the thread's age; the host still
 * refuses any folder that is working, dirty, locked, holds files a branch
 * cannot give back, or cannot be verified. Nothing here touches a folder.
 */

const DAY_MS = 86_400_000;

/**
 * A thread whose work is pushed or merged is left this long before its folder
 * goes. A worktree nobody has committed to is trivially "merged" into the
 * branch it started from, so without a wait a new thread would lose its folder
 * before its first turn.
 */
export const MERGED_CLEANUP_GRACE_MS = DAY_MS;

export interface WorktreeCleanupChoices {
  readonly whenMerged?: boolean | undefined;
  readonly inactivityDays?: number | undefined;
}

export type WorktreeReclaimTrigger = "inactivity" | "delivered";

export function worktreeReclaimTrigger(input: {
  readonly choices: WorktreeCleanupChoices | undefined;
  /** Epoch milliseconds of the thread's latest activity. */
  readonly lastActivityAt: number;
  readonly now: number;
}): WorktreeReclaimTrigger | undefined {
  const idleFor = input.now - input.lastActivityAt;
  if (!Number.isFinite(idleFor) || idleFor < 0) return undefined;
  const days = input.choices?.inactivityDays;
  if (days !== undefined && Number.isInteger(days) && days >= 1 && idleFor >= days * DAY_MS) {
    return "inactivity";
  }
  if (input.choices?.whenMerged === true && idleFor >= MERGED_CLEANUP_GRACE_MS) return "delivered";
  return undefined;
}
