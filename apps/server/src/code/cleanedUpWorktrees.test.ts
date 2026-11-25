import { decodeCodeThreadId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCleanedUpWorktrees } from "./cleanedUpWorktrees";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { ManagedWorktreeReclaimResult } from "./managedWorktreeReclaim";

const threadId = decodeCodeThreadId("77000000-0000-4000-8000-000000000001");
const receiptId = "77000000-0000-4000-8000-000000000002";

function receipt(
  state: ManagedWorktreeReceipt["state"],
  withRecord = true,
): ManagedWorktreeReceipt {
  return {
    version: 1,
    receiptId,
    state,
    repositoryId: "repo_" + "a".repeat(64),
    threadId,
    checkoutId: "77000000-0000-4000-8000-000000000004",
    canonicalRepositoryPath: "/repos/r",
    canonicalWorktreePath: "/repos/.octant-worktrees/r/t",
    branchIntent: "octant/fix-sidebar",
    refIntent: "refs/heads/development",
    expectedHead: "a".repeat(40),
    ...(withRecord ? { reclaim: { branch: "octant/fix-sidebar", head: "b".repeat(40) } } : {}),
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
}

function setup(
  state: ManagedWorktreeReceipt["state"],
  options: {
    readonly withRecord?: boolean;
    readonly restore?: ManagedWorktreeReclaimResult;
    readonly abandon?: ManagedWorktreeReclaimResult;
  } = {},
) {
  const thread = {
    id: threadId,
    projectId: "77000000-0000-4000-8000-000000000003",
    checkoutId: "77000000-0000-4000-8000-000000000004",
    title: "Fix the sidebar",
    lifecycle: "active",
  };
  const loaded = receipt(state, options.withRecord ?? true);
  const restore = vi.fn(
    async (): Promise<ManagedWorktreeReclaimResult> =>
      options.restore ?? { status: "restored", receipt: receipt("ready", false) },
  );
  const abandon = vi.fn(
    async (): Promise<ManagedWorktreeReclaimResult> =>
      options.abandon ?? { status: "reclaimed", receipt: receipt("reclaimed") },
  );
  const worktrees = createCleanedUpWorktrees({
    readCodeThreads: () => [thread] as never,
    readCodeThread: () => thread as never,
    readCodeCheckout: () => ({ kind: "managed-worktree", ownershipReceiptId: receiptId }) as never,
    loadReceipt: async () => loaded,
    restore,
    abandon,
  });
  return { worktrees, restore, abandon };
}

describe("cleaned-up worktrees", () => {
  it("lists a cleaned-up, an interrupted cleaning-up and a restoring worktree of an open thread, and nothing for a working one", async () => {
    for (const [state, listed] of [
      ["reclaimed", "cleaned-up"],
      ["cleanup-pending", "cleaning-up"],
      ["restoring", "restoring"],
    ] as const) {
      await expect(setup(state).worktrees.list()).resolves.toEqual([
        {
          threadId,
          projectId: "77000000-0000-4000-8000-000000000003",
          title: "Fix the sidebar",
          branch: "octant/fix-sidebar",
          path: "/repos/.octant-worktrees/r/t",
          state: listed,
        },
      ]);
    }
    await expect(setup("ready", { withRecord: false }).worktrees.list()).resolves.toEqual([]);
    await expect(setup("removed", { withRecord: false }).worktrees.list()).resolves.toEqual([]);
  });

  it("restores through the verified restore and says when the branch changed or the folder is in use", async () => {
    const { worktrees, restore } = setup("reclaimed");
    await expect(worktrees.restore(threadId)).resolves.toEqual({
      kind: "cleaned-up-worktree-restored",
      threadId,
    });
    expect(restore).toHaveBeenCalledWith(receiptId, expect.any(AbortSignal));

    for (const [reason, expected] of [
      ["restore-mismatch", "branch-changed"],
      ["path-collision", "folder-in-use"],
      ["branch-collision", "folder-in-use"],
      ["unverified", "unverified"],
    ] as const) {
      await expect(
        setup("reclaimed", { restore: { status: "refused", reason } }).worktrees.restore(threadId),
      ).resolves.toMatchObject({ kind: "cleaned-up-worktree-refused", reason: expected });
    }
    await expect(
      setup("reclaimed", { restore: { status: "waiting" } }).worktrees.restore(threadId),
    ).resolves.toMatchObject({ reason: "busy" });
  });

  it("refuses a thread whose worktree was never cleaned up, without touching anything", async () => {
    const { worktrees, restore, abandon } = setup("ready", { withRecord: false });
    await expect(worktrees.restore(threadId)).resolves.toMatchObject({
      kind: "cleaned-up-worktree-refused",
      reason: "not-cleaned-up",
    });
    expect(restore).not.toHaveBeenCalled();
    expect(abandon).not.toHaveBeenCalled();
  });

  it("settles an interrupted cleanup first: a folder still there is kept, one already gone is restored", async () => {
    const kept = setup("cleanup-pending", {
      abandon: { status: "restored", receipt: receipt("ready", false) },
    });
    await expect(kept.worktrees.restore(threadId)).resolves.toEqual({
      kind: "cleaned-up-worktree-restored",
      threadId,
    });
    expect(kept.restore).not.toHaveBeenCalled();

    const gone = setup("cleanup-pending");
    await expect(gone.worktrees.restore(threadId)).resolves.toEqual({
      kind: "cleaned-up-worktree-restored",
      threadId,
    });
    expect(gone.abandon).toHaveBeenCalledTimes(1);
    expect(gone.restore).toHaveBeenCalledTimes(1);
  });
});
