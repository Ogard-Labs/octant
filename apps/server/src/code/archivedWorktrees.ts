import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  ArchivedWorktree,
  ArchivedWorktreeRefusalReason,
  CodeCheckoutId,
  CodeCheckoutIdentity,
  CodeThread,
  CodeThreadId,
  RemoveArchivedWorktreeResult,
} from "@octant/contracts";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { ManagedWorktreeService } from "./managedWorktreeService";

/** The entries one folder's size walk reads before it reports a partial size. */
const MAX_SIZE_ENTRIES = 200_000;
const MAX_LISTED = 1_000;

export interface ArchivedWorktreesDependencies {
  readonly readCodeThreads: () => ReadonlyArray<CodeThread>;
  readonly readCodeThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly readCodeCheckout: (checkoutId: CodeCheckoutId) => CodeCheckoutIdentity | undefined;
  readonly loadReceipt: (receiptId: string) => Promise<ManagedWorktreeReceipt | undefined>;
  readonly cleanup: ManagedWorktreeService["cleanup"];
  /**
   * Whether a turn on the thread is starting, running, or waiting on the
   * person. Archiving does not stop one, and its commands still use the
   * worktree, so neither removal touches the folder while it does.
   */
  readonly turnInProgress: (threadId: CodeThreadId) => boolean;
  /** Override for tests; production walks the folder. */
  readonly measure?: (path: string) => Promise<FolderSize | undefined>;
}

export interface FolderSize {
  readonly bytes: number;
  readonly complete: boolean;
}

/**
 * The managed worktrees archived Code threads still keep on disk. Archiving
 * removes a thread's worktree only when it is clean and its work is pushed or
 * merged; everything else stays here until a person removes it. Removal goes
 * through the managed-worktree cleanup, which refuses uncommitted changes and
 * keeps the branch, so committed work is never lost.
 */
export function createArchivedWorktrees(dependencies: ArchivedWorktreesDependencies) {
  const measure = dependencies.measure ?? measureFolder;

  async function ownedReceipt(thread: CodeThread): Promise<ManagedWorktreeReceipt | undefined> {
    const checkout = dependencies.readCodeCheckout(thread.checkoutId);
    if (checkout?.kind !== "managed-worktree") return undefined;
    const receipt = await dependencies
      .loadReceipt(String(checkout.ownershipReceiptId))
      .catch(() => undefined);
    return receipt?.state === "ready" || receipt?.state === "cleanup-pending" ? receipt : undefined;
  }

  return {
    async list(): Promise<ReadonlyArray<ArchivedWorktree>> {
      const listed: ArchivedWorktree[] = [];
      for (const thread of dependencies.readCodeThreads()) {
        if (thread.lifecycle !== "archived") continue;
        const receipt = await ownedReceipt(thread);
        if (receipt === undefined) continue;
        const size = await measure(receipt.canonicalWorktreePath);
        // A receipt whose folder is gone has nothing left to reclaim.
        if (size === undefined) continue;
        listed.push({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title.slice(0, 512),
          branch: receipt.branchIntent,
          path: receipt.canonicalWorktreePath,
          sizeBytes: size.bytes,
          sizeComplete: size.complete,
        });
        if (listed.length === MAX_LISTED) break;
      }
      return listed.sort((a, b) => b.sizeBytes - a.sizeBytes);
    },

    async remove(threadId: CodeThreadId): Promise<RemoveArchivedWorktreeResult> {
      const thread = dependencies.readCodeThread(threadId);
      if (thread === undefined) return refused("not-found");
      if (thread.lifecycle !== "archived") return refused("not-archived");
      if (dependencies.turnInProgress(threadId)) return refused("turn-running");
      const receipt = await ownedReceipt(thread);
      if (receipt === undefined) return refused("not-found");
      const result = await dependencies.cleanup(
        { receiptId: receipt.receiptId, confirmedByLocalUser: true },
        new AbortController().signal,
      );
      if (result.status === "removed") return { kind: "archived-worktree-removed", threadId };
      if (result.status !== "refused") return refused("busy");
      if (result.reason === "dirty") return refused("dirty");
      if (result.reason === "active-thread") return refused("not-archived");
      if (result.reason === "unowned") return refused("not-found");
      return refused("busy");
    },

    /**
     * Called once a Code thread is archived, by a person or the host's timer.
     * The cleanup decides: it removes only a clean worktree whose commit is
     * pushed or merged, and refuses everything else, which then stays listed.
     */
    async reclaimOnArchive(threadId: CodeThreadId): Promise<void> {
      const thread = dependencies.readCodeThread(threadId);
      if (thread?.lifecycle !== "archived") return;
      // A turn still running keeps its worktree; it stays listed in Settings.
      if (dependencies.turnInProgress(threadId)) return;
      const receipt = await ownedReceipt(thread);
      if (receipt?.state !== "ready") return;
      await dependencies
        .cleanup(
          { receiptId: receipt.receiptId, confirmedByLocalUser: false, onArchive: true },
          new AbortController().signal,
        )
        .catch(() => undefined);
    },
  };
}

export type ArchivedWorktrees = ReturnType<typeof createArchivedWorktrees>;

const REFUSALS: Record<ArchivedWorktreeRefusalReason, string> = {
  malformed: "That worktree request is not valid.",
  unauthorized: "Worktrees can be removed only from a window on this computer.",
  "not-archived": "Archive the thread before removing its worktree.",
  "not-found": "That worktree is already gone.",
  dirty:
    "The worktree has uncommitted changes. Commit or discard them in the thread first, or keep it.",
  "turn-running": "A turn is still running in this thread. Stop it or let it finish first.",
  busy: "The worktree could not be removed right now. Try again in a moment.",
};

export function refused(reason: ArchivedWorktreeRefusalReason): RemoveArchivedWorktreeResult {
  return { kind: "archived-worktree-refused", reason, message: REFUSALS[reason] };
}

/**
 * The folder's size without following links, or undefined when it is not
 * there. A worktree with dependencies installed can hold hundreds of thousands
 * of files, so the walk stops after a bound and says the size is partial.
 */
export async function measureFolder(root: string): Promise<FolderSize | undefined> {
  try {
    if (!(await lstat(root)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const folder = pending.pop();
    if (folder === undefined) break;
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(folder);
    } catch {
      continue;
    }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_SIZE_ENTRIES) return { bytes, complete: false };
      const path = join(folder, name);
      try {
        const status = await lstat(path);
        if (status.isDirectory()) pending.push(path);
        else bytes += status.size;
      } catch {
        // Gone between the read and the stat; it no longer takes space.
      }
    }
  }
  return { bytes, complete: true };
}
