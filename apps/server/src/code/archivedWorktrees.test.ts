import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCodeThreadId } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createArchivedWorktrees, measureFolder } from "./archivedWorktrees";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";

const threadId = decodeCodeThreadId("76000000-0000-4000-8000-000000000001");
const receiptId = "76000000-0000-4000-8000-000000000002";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type CleanupResult = Awaited<ReturnType<Parameters<typeof createArchivedWorktrees>[0]["cleanup"]>>;

function receipt(state: "ready" | "cleanup-pending" | "removed"): ManagedWorktreeReceipt {
  return {
    version: 1,
    receiptId,
    state,
    repositoryId: "76000000-0000-4000-8000-000000000005",
    threadId,
    checkoutId: "76000000-0000-4000-8000-000000000004",
    canonicalRepositoryPath: "/repos/r",
    canonicalWorktreePath: "/repos/.octant-worktrees/r/t",
    branchIntent: "octant/fix-sidebar",
    refIntent: "refs/heads/octant/fix-sidebar",
    expectedHead: "a".repeat(40),
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  };
}

function setup(options: {
  readonly lifecycle?: "active" | "archived";
  readonly receiptState?: "ready" | "cleanup-pending" | "removed";
  readonly cleanup?: CleanupResult;
  readonly turnRunning?: boolean;
}) {
  const thread = {
    id: threadId,
    projectId: "76000000-0000-4000-8000-000000000003",
    checkoutId: "76000000-0000-4000-8000-000000000004",
    title: "Fix the sidebar",
    lifecycle: options.lifecycle ?? "archived",
  };
  const cleanup = vi.fn(
    async (): Promise<CleanupResult> =>
      options.cleanup ?? { status: "removed", receipt: receipt(options.receiptState ?? "ready") },
  );
  const worktrees = createArchivedWorktrees({
    readCodeThreads: () => [thread] as never,
    readCodeThread: () => thread as never,
    readCodeCheckout: () => ({ kind: "managed-worktree", ownershipReceiptId: receiptId }) as never,
    loadReceipt: async () => receipt(options.receiptState ?? "ready"),
    cleanup,
    turnInProgress: () => options.turnRunning === true,
    measure: async () => ({ bytes: 2_048, complete: true }),
  });
  return { worktrees, cleanup };
}

describe("archived worktrees", () => {
  it("lists an archived thread's worktree with its branch and size", async () => {
    const { worktrees } = setup({});
    await expect(worktrees.list()).resolves.toEqual([
      {
        threadId,
        projectId: "76000000-0000-4000-8000-000000000003",
        title: "Fix the sidebar",
        branch: "octant/fix-sidebar",
        path: "/repos/.octant-worktrees/r/t",
        sizeBytes: 2_048,
        sizeComplete: true,
      },
    ]);
  });

  it("leaves out an active thread's worktree and one already removed", async () => {
    await expect(setup({ lifecycle: "active" }).worktrees.list()).resolves.toEqual([]);
    await expect(setup({ receiptState: "removed" }).worktrees.list()).resolves.toEqual([]);
  });

  it("removes on a person's request as a confirmed cleanup that keeps changes safe", async () => {
    const { worktrees, cleanup } = setup({});
    await expect(worktrees.remove(threadId)).resolves.toEqual({
      kind: "archived-worktree-removed",
      threadId,
    });
    expect(cleanup).toHaveBeenCalledWith(
      { receiptId, confirmedByLocalUser: true },
      expect.any(AbortSignal),
    );
  });

  it("refuses to remove a worktree with uncommitted changes, or one whose thread is active", async () => {
    await expect(
      setup({ cleanup: { status: "refused", reason: "dirty" } }).worktrees.remove(threadId),
    ).resolves.toMatchObject({ kind: "archived-worktree-refused", reason: "dirty" });
    const active = setup({ lifecycle: "active" });
    await expect(active.worktrees.remove(threadId)).resolves.toMatchObject({
      reason: "not-archived",
    });
    expect(active.cleanup).not.toHaveBeenCalled();
  });

  it("asks for a delivered-only cleanup when a thread is archived", async () => {
    const { worktrees, cleanup } = setup({});
    await worktrees.reclaimOnArchive(threadId);
    expect(cleanup).toHaveBeenCalledWith(
      { receiptId, confirmedByLocalUser: false, onArchive: true },
      expect.any(AbortSignal),
    );
  });

  it("keeps the worktree of a thread archived while its turn still runs", async () => {
    // Archiving does not stop a running turn, and its commands still read and
    // write the folder; removing it then would pull the files out from under it.
    const running = setup({ turnRunning: true });
    await running.worktrees.reclaimOnArchive(threadId);
    await expect(running.worktrees.remove(threadId)).resolves.toMatchObject({
      kind: "archived-worktree-refused",
      reason: "turn-running",
    });
    expect(running.cleanup).not.toHaveBeenCalled();
  });

  it("measures a folder without following links and reports a missing one as absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-archived-worktree-"));
    directories.push(root);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "a.txt"), "12345");
    await writeFile(join(root, "nested", "b.txt"), "123");
    await expect(measureFolder(root)).resolves.toEqual({ bytes: 8, complete: true });
    await expect(measureFolder(join(root, "missing"))).resolves.toBeUndefined();
  });
});
