import type {
  CleanedUpWorktree,
  CleanedUpWorktreeRefusalReason,
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeThread,
  CodeThreadId,
  RestoreCleanedUpWorktreeResult,
} from "@octant/contracts";
import type { CleanedUpWorktreeStanding } from "@octant/domain";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { ManagedWorktreeReclaimResult } from "./managedWorktreeReclaim";

export interface CleanedUpWorktreesDependencies {
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCodeCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly restore: (
    receiptId: string,
    signal: AbortSignal,
  ) => Promise<ManagedWorktreeReclaimResult>;
  readonly abandon: (
    receiptId: string,
    signal: AbortSignal,
  ) => Promise<ManagedWorktreeReclaimResult>;
}

const REFUSALS: Record<CleanedUpWorktreeRefusalReason, string> = {
  malformed: "That worktree request is not valid.",
  unauthorized: "Worktrees can be restored only from a window on this computer.",
  "not-found": "That thread's worktree is not known to this computer.",
  "not-cleaned-up": "That thread's worktree was not cleaned up.",
  "branch-changed":
    "The branch no longer points where the worktree left it, so it was not restored. Check the branch in the repository, or start a new thread from it.",
  "folder-in-use":
    "Something else is using the worktree's folder or branch, or Git has it locked. Unlock or move it away, then restore again.",
  "cleanup-running":
    "A cleanup of this worktree is still running. Wait for it to finish, then restore again.",
  "restore-running":
    "This worktree is already being restored. Wait for that to finish, then check the thread.",
  "files-missing":
    "The thread has its worktree back, but Git could not put back every file a cut-short cleanup took. Run git checkout -- . in the worktree's folder to restore them.",
  "partial-folder":
    "A restore that was cut short left a folder with files that are not on the branch, so nothing was deleted. Move that folder away, then restore again.",
  "needs-attention":
    "Git could not put the worktree's folder back. Check the folder and the repository's worktrees, then restore again.",
  unverified: "The worktree could not be checked, so it was not restored.",
  busy: "The worktree could not be restored right now. Try again in a moment.",
};

export function cleanedUpRefusal(
  reason: CleanedUpWorktreeRefusalReason,
  /** Says what the person should do about this one worktree, in place of the general answer. */
  message?: string,
): Extract<RestoreCleanedUpWorktreeResult, { kind: "cleaned-up-worktree-refused" }> {
  const specific = message !== undefined && message.length <= 512 ? message : undefined;
  return { kind: "cleaned-up-worktree-refused", reason, message: specific ?? REFUSALS[reason] };
}

function branchChangedMessage(reclaim: { branch: string; head: string }): string {
  return `The branch ${reclaim.branch} no longer points at commit ${reclaim.head} (it moved or was deleted), so the worktree was not restored. Put it back with git branch -f ${reclaim.branch} ${reclaim.head}, then restore again.`;
}

function folderInTheWayMessage(path: string): string {
  return `The folder ${path} is in the way: Git no longer lists it as a worktree, but it is still there. Move it away, then restore again.`;
}

/** Where a receipt's cleanup stands, or nothing while the thread may use its folder. */
export function cleanedUpStanding(
  receipt: Pick<ManagedWorktreeReceipt, "state" | "reclaim"> | undefined,
): CleanedUpWorktreeStanding | undefined {
  if (receipt?.reclaim === undefined) return undefined;
  switch (receipt.state) {
    case "reclaimed":
      return "cleaned-up";
    case "restoring":
      return "restoring";
    case "cleanup-pending":
      return "cleaning-up";
    default:
      return undefined;
  }
}

/**
 * Where the cleanup of a checkout's managed worktree stands, for the thread
 * view, a turn's refusal and a queued message's refusal alike. A receipt that
 * cannot be read says nothing here: the callers keep their own refusals.
 */
export function cleanedUpWorktreeOf(
  loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>,
): (checkout: CodeCheckoutIdentity) => Promise<CleanedUpWorktreeStanding | undefined> {
  return async (checkout) =>
    checkout.kind === "managed-worktree"
      ? cleanedUpStanding(
          await loadReceipt(String(checkout.ownershipReceiptId)).catch(() => undefined),
        )
      : undefined;
}

/**
 * The managed worktrees the host cleaned up and can restore: the receipt still
 * names the branch and commit to return to. Listing and restoring are the
 * person's, at a window on this computer; the sweep never restores.
 */
export function createCleanedUpWorktrees(dependencies: CleanedUpWorktreesDependencies) {
  async function receiptOf(thread: CodeThread): Promise<ManagedWorktreeReceipt | undefined> {
    const checkout = dependencies.readCodeCheckout(thread.checkoutId);
    if (checkout?.kind !== "managed-worktree") return undefined;
    const receipt = await dependencies
      .loadReceipt(String(checkout.ownershipReceiptId))
      .catch(() => undefined);
    return receipt?.reclaim === undefined ? undefined : receipt;
  }

  return {
    async list(): Promise<ReadonlyArray<CleanedUpWorktree>> {
      const listed: CleanedUpWorktree[] = [];
      for (const thread of dependencies.readCodeThreads()) {
        const receipt = await receiptOf(thread);
        if (receipt?.reclaim === undefined) continue;
        const state = cleanedUpStanding(receipt);
        if (state === undefined) continue;
        listed.push({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title.slice(0, 512),
          branch: receipt.reclaim.branch,
          path: receipt.canonicalWorktreePath,
          state,
        });
        if (listed.length === 1_000) break;
      }
      return listed;
    },

    async restore(threadId: CodeThreadId): Promise<RestoreCleanedUpWorktreeResult> {
      const thread = dependencies.readCodeThread(threadId);
      if (thread === undefined) return cleanedUpRefusal("not-found");
      const receipt = await receiptOf(thread);
      if (receipt === undefined) return cleanedUpRefusal("not-cleaned-up");
      const signal = new AbortController().signal;
      let current = receipt;
      if (current.state === "cleanup-pending") {
        // A cleanup a restart interrupted: the person wants the thread back, so
        // a folder still there is kept and one already gone is brought back.
        const settled = await dependencies.abandon(current.receiptId, signal);
        if (settled.status === "restored") {
          return { kind: "cleaned-up-worktree-restored", threadId };
        }
        if (settled.status !== "reclaimed") return mapRefusal(settled, current);
        current = settled.receipt;
      }
      return mapRefusal(await dependencies.restore(current.receiptId, signal), current, threadId);
    },
  };
}

export type CleanedUpWorktrees = ReturnType<typeof createCleanedUpWorktrees>;

function mapRefusal(
  result: ManagedWorktreeReclaimResult,
  receipt: ManagedWorktreeReceipt,
  threadId?: CodeThreadId,
): RestoreCleanedUpWorktreeResult {
  if (result.status === "restored" && threadId !== undefined) {
    return { kind: "cleaned-up-worktree-restored", threadId };
  }
  if (result.status === "refused") {
    switch (result.reason) {
      case "restore-mismatch":
        return cleanedUpRefusal(
          "branch-changed",
          receipt.reclaim === undefined ? undefined : branchChangedMessage(receipt.reclaim),
        );
      case "path-collision":
        return cleanedUpRefusal("folder-in-use", folderInTheWayMessage(receipt.canonicalWorktreePath));
      case "branch-collision":
      case "inventory-ambiguous":
        return cleanedUpRefusal("folder-in-use");
      case "cleanup-running":
        return cleanedUpRefusal("cleanup-running");
      case "restore-running":
        return cleanedUpRefusal("restore-running");
      case "files-missing":
        return cleanedUpRefusal("files-missing");
      case "partial-folder":
        return cleanedUpRefusal("partial-folder");
      case "not-reclaimed":
        return cleanedUpRefusal("not-cleaned-up");
      case "unowned":
        return cleanedUpRefusal("not-found");
      case "unverified":
      case "mismatched":
        return cleanedUpRefusal("unverified");
      default:
        // Waiting would not help: the person has to look at the folder.
        return cleanedUpRefusal("needs-attention");
    }
  }
  return cleanedUpRefusal("busy");
}
