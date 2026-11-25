/**
 * Pure rule for when a managed worktree folder qualifies for a restorable
 * cleanup. It reads the person's settings and the thread's age; the host still
 * refuses any folder that is working, dirty, locked, holds files a branch
 * cannot give back, or cannot be verified. Nothing here touches a folder.
 */

const DAY_MS = 86_400_000;

/**
 * A thread whose work is pushed or merged is left this long before its folder
 * goes, so work that was just delivered can still be looked at where it was
 * made. The host also needs a commit of the branch's own before it counts the
 * work as delivered at all.
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

/** How far a worktree's cleanup has got, as the thread's own view names it. */
export type CleanedUpWorktreeStanding = "cleaned-up" | "cleaning-up" | "restoring";

/**
 * What a thread says, and what the host answers a send, a queued message or a
 * wake with, while its worktree folder is gone or on its way out. One wording,
 * so the thread and the refusal never describe it differently.
 */
export function cleanedUpWorktreeSentence(standing: CleanedUpWorktreeStanding): string {
  switch (standing) {
    case "cleaned-up":
      return "This thread's worktree was cleaned up to save space. The branch and the thread are kept, and the thread takes no new turn until the worktree is restored.";
    case "cleaning-up":
      return "This thread's worktree is being cleaned up to save space. The branch and the thread are kept, and the thread takes no new turn until the worktree is restored.";
    case "restoring":
      return "This thread's worktree is being restored. The thread takes no new turn until that finishes.";
  }
}
