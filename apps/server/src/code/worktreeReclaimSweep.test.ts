import { decodeCodeThreadId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ManagedWorktreeReceipt } from "./managedWorktreeReceiptStore";
import type { ManagedWorktreeReclaimResult } from "./managedWorktreeReclaim";
import { WorktreeReclaimSweep, type WorktreeReclaimSweepOptions } from "./worktreeReclaimSweep";

const now = Date.parse("2026-11-25T12:00:00.000Z");
const DAY = 86_400_000;
const ids = {
  idle: decodeCodeThreadId("78000000-0000-4000-8000-000000000001"),
  recent: decodeCodeThreadId("78000000-0000-4000-8000-000000000002"),
  working: decodeCodeThreadId("78000000-0000-4000-8000-000000000003"),
  plain: decodeCodeThreadId("78000000-0000-4000-8000-000000000004"),
  archived: decodeCodeThreadId("78000000-0000-4000-8000-000000000005"),
  broken: decodeCodeThreadId("78000000-0000-4000-8000-000000000006"),
};

function receipt(
  threadId: string,
  state: ManagedWorktreeReceipt["state"] = "ready",
  reclaim = false,
): ManagedWorktreeReceipt {
  return {
    version: 1,
    receiptId: `receipt-${threadId}`,
    state,
    repositoryId: "repo_" + "a".repeat(64),
    threadId,
    checkoutId: threadId,
    canonicalRepositoryPath: "/repos/r",
    canonicalWorktreePath: `/repos/.octant-worktrees/r/${threadId}`,
    branchIntent: "octant/x",
    refIntent: "refs/heads/development",
    expectedHead: "a".repeat(40),
    ...(reclaim ? { reclaim: { branch: "octant/x", head: "b".repeat(40) } } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function setup(
  options: {
    readonly choices?: WorktreeReclaimSweepOptions["cleanup"] extends () => infer R ? R : never;
    readonly activity?: Partial<Record<keyof typeof ids, number>>;
    readonly receipts?: Partial<Record<keyof typeof ids, ManagedWorktreeReceipt>>;
    readonly working?: ReadonlyArray<keyof typeof ids>;
    readonly reclaim?: (threadId: string) => Promise<ManagedWorktreeReclaimResult>;
  } = {},
) {
  const names = Object.keys(ids) as Array<keyof typeof ids>;
  const threads = names.map((name) => ({
    id: ids[name],
    checkoutId: ids[name],
    title: name,
    lifecycle: name === "archived" ? "archived" : "active",
    // Everything was last touched long ago unless a test says otherwise.
    updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  const reclaim = vi.fn(
    async (input: {
      receiptId: string;
      trigger: string;
      isIdle: () => boolean;
    }): Promise<ManagedWorktreeReclaimResult> => {
      const threadId = input.receiptId.replace("receipt-", "");
      if (options.reclaim !== undefined) return options.reclaim(threadId);
      return { status: "reclaimed", receipt: receipt(threadId, "reclaimed", true) };
    },
  );
  const abandon = vi.fn(
    async (receiptId: string): Promise<ManagedWorktreeReclaimResult> => ({
      status: "restored",
      receipt: receipt(receiptId.replace("receipt-", ""), "ready"),
    }),
  );
  const sweep = new WorktreeReclaimSweep({
    cleanup: () => options.choices,
    threads: () => threads as never,
    readCheckout: (checkoutId) =>
      String(checkoutId) === String(ids.plain)
        ? ({ kind: "existing-worktree" } as never)
        : ({ kind: "managed-worktree", ownershipReceiptId: `receipt-${checkoutId}` } as never),
    loadReceipt: async (receiptId) => {
      const name = names.find((candidate) => `receipt-${ids[candidate]}` === receiptId);
      if (name === undefined) return undefined;
      if (name === "broken") throw new Error("receipt unreadable");
      return options.receipts?.[name] ?? receipt(ids[name]);
    },
    lastActivityAt: (threadId) => {
      const name = names.find((candidate) => ids[candidate] === threadId);
      return name === undefined ? undefined : options.activity?.[name];
    },
    threadHasWork: (threadId) => options.working?.some((name) => ids[name] === threadId) === true,
    reclaim: reclaim as never,
    abandon: abandon as never,
    clock: () => now,
  });
  return { sweep, reclaim, abandon };
}

describe("worktree reclaim sweep", () => {
  it("removes nothing on a default install, however old the threads are", async () => {
    for (const choices of [undefined, {}, { whenMerged: false }]) {
      const { sweep, reclaim } = setup({ choices });
      await expect(sweep.pass()).resolves.toMatchObject({ reclaimed: [] });
      expect(reclaim).not.toHaveBeenCalled();
    }
  });

  it("cleans up open and archived threads idle for the chosen days, and leaves a recently used one", async () => {
    const { sweep, reclaim } = setup({
      choices: { inactivityDays: 14 },
      activity: { recent: now - 2 * DAY },
    });
    const summary = await sweep.pass();
    expect(summary.reclaimed).toEqual([ids.idle, ids.working, ids.archived]);
    expect(reclaim.mock.calls.every(([input]) => input.trigger === "inactivity")).toBe(true);
    expect(reclaim.mock.calls.map(([input]) => input.receiptId)).not.toContain(
      `receipt-${ids.recent}`,
    );
  });

  it("uses the thread's journaled activity, not only when its record last changed", async () => {
    const { sweep } = setup({
      choices: { inactivityDays: 14 },
      activity: { idle: now - DAY, archived: now - 20 * DAY },
    });
    expect((await sweep.pass()).reclaimed).not.toContain(ids.idle);
  });

  it("asks for delivered work only for the merged choice, after its wait", async () => {
    const { sweep, reclaim } = setup({
      choices: { whenMerged: true },
      activity: { idle: now - 2 * 3_600_000, recent: now - 2 * DAY },
    });
    const summary = await sweep.pass();
    expect(summary.reclaimed).not.toContain(ids.idle);
    expect(summary.reclaimed).toContain(ids.recent);
    expect(reclaim.mock.calls.every(([input]) => input.trigger === "delivered")).toBe(true);
  });

  it("skips a thread with a turn in progress and hands the service a fresh idle check", async () => {
    const { sweep, reclaim } = setup({
      choices: { inactivityDays: 14 },
      working: ["working"],
    });
    const summary = await sweep.pass();
    expect(summary.skipped).toContainEqual({ threadId: ids.working, reason: "working" });
    expect(reclaim.mock.calls.map(([input]) => input.receiptId)).not.toContain(
      `receipt-${ids.working}`,
    );
    const [first] = reclaim.mock.calls[0]!;
    expect(first.isIdle()).toBe(true);
  });

  it("leaves a thread alone when the service refuses it, and keeps going when one thread fails", async () => {
    const { sweep } = setup({
      choices: { inactivityDays: 14 },
      reclaim: async (threadId) => {
        if (threadId === ids.idle) return { status: "refused", reason: "dirty" };
        if (threadId === ids.working) throw new Error("git unavailable");
        if (threadId === ids.archived) return { status: "waiting" };
        return { status: "refused", reason: "working" };
      },
    });
    const summary = await sweep.pass();
    expect(summary.reclaimed).toEqual([]);
    expect(summary.skipped).toEqual(
      expect.arrayContaining([
        { threadId: ids.idle, reason: "refused" },
        { threadId: ids.working, reason: "failed" },
        { threadId: ids.archived, reason: "waiting" },
        { threadId: ids.recent, reason: "working" },
      ]),
    );
    // One unreadable receipt did not stop the pass: every other thread was tried.
    expect(summary.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it("looks only at worktrees Octant made, and only ones that are ready or being cleaned up", async () => {
    const { sweep, reclaim } = setup({
      choices: { inactivityDays: 14 },
      receipts: {
        idle: receipt(ids.idle, "reclaimed", true),
        recent: receipt(ids.recent, "restoring", true),
        working: receipt(ids.working, "removed"),
      },
    });
    await sweep.pass();
    const asked = reclaim.mock.calls.map(([input]) => input.receiptId);
    expect(asked).not.toContain(`receipt-${ids.plain}`);
    for (const skippedThread of [ids.idle, ids.recent, ids.working]) {
      expect(asked).not.toContain(`receipt-${skippedThread}`);
    }
  });

  it("finishes a cleanup a restart interrupted while the choice stands, and returns the folder when it no longer does", async () => {
    const interrupted = { idle: receipt(ids.idle, "cleanup-pending", true) };
    const stands = setup({ choices: { inactivityDays: 14 }, receipts: interrupted });
    await stands.sweep.pass();
    expect(stands.reclaim.mock.calls.map(([input]) => input.receiptId)).toContain(
      `receipt-${ids.idle}`,
    );
    expect(stands.abandon).not.toHaveBeenCalled();

    const turnedOff = setup({ choices: undefined, receipts: interrupted });
    const summary = await turnedOff.sweep.pass();
    expect(turnedOff.abandon).toHaveBeenCalledWith(`receipt-${ids.idle}`, expect.any(AbortSignal));
    expect(summary.abandoned).toEqual([ids.idle]);
    expect(turnedOff.reclaim).not.toHaveBeenCalled();
  });

  it("does nothing once stopped", async () => {
    const { sweep, reclaim } = setup({ choices: { inactivityDays: 14 } });
    sweep.stop();
    await expect(sweep.pass()).resolves.toEqual({ reclaimed: [], abandoned: [], skipped: [] });
    expect(reclaim).not.toHaveBeenCalled();
  });
});
