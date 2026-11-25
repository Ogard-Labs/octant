import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveManagedWorktreeCheckoutId } from "./managedCodeThreadCreation";
import {
  ManagedWorktreeReceiptStore,
  type ManagedWorktreeReceipt,
} from "./managedWorktreeReceiptStore";
import {
  ManagedWorktreeReclaimService,
  type ManagedWorktreeReclaimTrigger,
} from "./managedWorktreeReclaim";
import {
  ManagedWorktreeService,
  managedTargetPath,
  type ManagedWorktreeGitPort,
} from "./managedWorktreeService";
import { ManagedRootGrantStore } from "./managedRootGrantStore";
import type { RepositoryIdentityObservation } from "./repositoryIdentity";

const repositoryId = `repo_${"a".repeat(64)}` as `repo_${string}`;
const threadId = "70000000-0000-4000-8000-000000000001";
const repositoryRoot = "/workspace/repository";
const branch = `octant/${threadId}`;
const head = "a".repeat(40);
const moved = "b".repeat(40);
const target = managedTargetPath(repositoryRoot, repositoryId, threadId);
const checkoutId = deriveManagedWorktreeCheckoutId({ repositoryId, threadId });

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Listed {
  branch: string | undefined;
  head: string;
  locked?: string;
  prunable?: string;
  detached?: boolean;
}

/** A repository that exists only in memory, so every refusal and crash is exact. */
async function world(
  options: {
    readonly worktreePath?: string;
    readonly receiptThread?: string;
    /** A Git port that cannot look for untracked and ignored files at all. */
    readonly withoutIgnoredCheck?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-reclaim-"));
  directories.push(directory);
  const receipts = new ManagedWorktreeReceiptStore({ dataDirectory: directory });
  const created = await receipts.create({
    repositoryId,
    threadId: options.receiptThread ?? threadId,
    checkoutId:
      options.receiptThread === undefined ? checkoutId : "70000000-0000-4000-8000-0000000000ff",
    canonicalRepositoryPath: repositoryRoot,
    canonicalWorktreePath: options.worktreePath ?? target,
    branchIntent: branch,
    refIntent: "refs/heads/development",
    expectedHead: head,
  });
  await receipts.transition(created.receiptId, "ready");
  const state = {
    repositoryId: repositoryId as string,
    worktrees: new Map<string, Listed>([[target, { branch: `refs/heads/${branch}`, head }]]),
    disk: new Set<string>([target]),
    branchHeads: new Map<string, string | undefined>([[branch, head]]),
    holders: new Map<string, string>(),
    dirty: false,
    unrecoverable: false as boolean | "unavailable",
    restoreRejected: false,
    delivered: true,
    authorityCheckout: checkoutId as string,
    calls: [] as string[],
    failures: new Set<string>(),
  };
  const observe = async (): Promise<RepositoryIdentityObservation> => {
    const main = {
      status: "present" as const,
      reportedPath: repositoryRoot,
      canonicalPath: repositoryRoot,
      head,
      branch: "refs/heads/development",
      detached: false,
    };
    const listed = [...state.worktrees.entries()].map(([path, value]) => ({
      status: "present" as const,
      reportedPath: path,
      canonicalPath: path,
      head: value.head,
      detached: value.detached ?? false,
      ...(value.branch === undefined ? {} : { branch: value.branch }),
      ...(value.locked === undefined ? {} : { locked: value.locked }),
      ...(value.prunable === undefined ? {} : { prunable: value.prunable }),
    }));
    const others = [...state.holders.entries()].map(([path, held]) => ({
      status: "present" as const,
      reportedPath: path,
      canonicalPath: path,
      head,
      branch: `refs/heads/${held}`,
      detached: false,
    }));
    return {
      status: "available",
      repositoryId: state.repositoryId as `repo_${string}`,
      repositoryRoot,
      commonDirectory: `${repositoryRoot}/.git`,
      objectDirectory: `${repositoryRoot}/.git/objects`,
      checkout: main,
      worktrees: [main, ...listed, ...others],
    };
  };
  const failing = <T>(name: string, run: () => T): T => {
    state.calls.push(name);
    if (state.failures.delete(name)) throw new Error(`${name} interrupted`);
    return run();
  };
  const git: ManagedWorktreeGitPort = {
    resolveRef: async () => ({ status: "missing" }),
    branchExists: async () => true,
    fetchRemote: async () => ({ status: "failed" }),
    addWorktree: async () => ({ status: "rejected" }),
    isDirty: async () => ({ status: "observed", dirty: state.dirty }),
    removeWorktree: async (input) =>
      failing("removeWorktree", () => {
        if (input.force === true) throw new Error("reclaim never forces");
        state.worktrees.delete(input.targetPath);
        state.disk.delete(input.targetPath);
        return { status: "removed" as const };
      }),
    isDelivered: async () => ({ status: "observed", delivered: state.delivered }),
    deleteBranch: async () => {
      state.calls.push("deleteBranch");
      return { status: "deleted" };
    },
    removeCheckpointRefs: async () => {
      state.calls.push("removeCheckpointRefs");
    },
    ...(options.withoutIgnoredCheck === true
      ? {}
      : {
          hasUnrecoverableFiles: async () =>
            state.unrecoverable === "unavailable"
              ? { status: "unavailable" as const }
              : { status: "observed" as const, found: state.unrecoverable === true },
        }),
    resolveBranchHead: async (input) =>
      failing("resolveBranchHead", () => {
        const tip = state.branchHeads.get(input.branch);
        return { status: "observed" as const, ...(tip === undefined ? {} : { head: tip }) };
      }),
    restoreWorktree: async (input) =>
      failing("restoreWorktree", () => {
        if (state.restoreRejected || [...state.holders.values()].includes(input.branch)) {
          return { status: "rejected" as const };
        }
        state.worktrees.set(input.targetPath, {
          branch: `refs/heads/${input.branch}`,
          head: state.branchHeads.get(input.branch) ?? head,
        });
        state.disk.add(input.targetPath);
        return { status: "created" as const };
      }),
  };
  const options_ = {
    receipts,
    repository: { observe },
    filesystem: {
      observeParent: async () => ({ status: "unavailable" as const }),
      pathExists: async (path: string) => state.disk.has(path),
    },
    git,
    authority: {
      observeCleanupEligibility: async () => ({
        status: "eligible" as const,
        // An open thread: reclaim does not need it archived.
        active: true,
        delivered: true,
        checkoutId: state.authorityCheckout as never,
        repositoryId: repositoryId as never,
      }),
    },
  };
  const service = new ManagedWorktreeReclaimService(options_);
  const signal = new AbortController().signal;
  const reclaim = (
    overrides: { trigger?: ManagedWorktreeReclaimTrigger; isIdle?: () => boolean } = {},
  ) =>
    service.reclaim(
      {
        receiptId: created.receiptId,
        trigger: overrides.trigger ?? "inactivity",
        isIdle: overrides.isIdle ?? (() => true),
      },
      signal,
    );
  const restore = () => service.restore({ receiptId: created.receiptId }, signal);
  const current = async (): Promise<ManagedWorktreeReceipt> => {
    const loaded = await receipts.load(created.receiptId);
    if (loaded === undefined) throw new Error("receipt vanished");
    return loaded;
  };
  const plainCleanup = () =>
    new ManagedWorktreeService({
      grants: new ManagedRootGrantStore(() => "grant", Date.now),
      receipts,
      repository: options_.repository,
      filesystem: options_.filesystem,
      git,
      authority: options_.authority,
    }).cleanup({ receiptId: created.receiptId, confirmedByLocalUser: true }, signal);
  return { state, reclaim, restore, current, receipts, receiptId: created.receiptId, plainCleanup };
}

describe("restorable cleanup of a managed worktree", () => {
  it("removes a clean, idle worktree of an open thread, and keeps its branch, its checkpoint refs and a record to restore from", async () => {
    const w = await world();
    const result = await w.reclaim();
    expect(result.status).toBe("reclaimed");
    expect(w.state.disk.has(target)).toBe(false);
    expect(await w.current()).toMatchObject({
      state: "reclaimed",
      reclaim: { branch, head },
    });
    expect(w.state.branchHeads.get(branch)).toBe(head);
    expect(w.state.calls).not.toContain("deleteBranch");
    expect(w.state.calls).not.toContain("removeCheckpointRefs");
  });

  it("leaves a working thread's worktree alone, before and after the receipt leaves ready", async () => {
    const working = await world();
    await expect(working.reclaim({ isIdle: () => false })).resolves.toEqual({
      status: "refused",
      reason: "working",
    });
    expect((await working.current()).state).toBe("ready");
    expect(working.state.disk.has(target)).toBe(true);

    const startsMeanwhile = await world();
    const idle = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await expect(startsMeanwhile.reclaim({ isIdle: idle })).resolves.toEqual({
      status: "refused",
      reason: "working",
    });
    expect(await startsMeanwhile.current()).toMatchObject({ state: "ready" });
    expect((await startsMeanwhile.current()).reclaim).toBeUndefined();
    expect(startsMeanwhile.state.calls).not.toContain("removeWorktree");
  });

  it("refuses a dirty or untracked checkout", async () => {
    const w = await world();
    w.state.dirty = true;
    await expect(w.reclaim()).resolves.toEqual({ status: "refused", reason: "dirty" });
    expect(w.state.disk.has(target)).toBe(true);
    expect((await w.current()).state).toBe("ready");
  });

  it("refuses a checkout with ignored files, and one that cannot be checked for them", async () => {
    const ignored = await world();
    ignored.state.unrecoverable = true;
    await expect(ignored.reclaim()).resolves.toEqual({
      status: "refused",
      reason: "unrecoverable-files",
    });
    const unreadable = await world();
    unreadable.state.unrecoverable = "unavailable";
    await expect(unreadable.reclaim()).resolves.toEqual({
      status: "refused",
      reason: "unverified",
    });
    const unchecked = await world({ withoutIgnoredCheck: true });
    await expect(unchecked.reclaim()).resolves.toEqual({ status: "refused", reason: "unverified" });
    for (const w of [ignored, unreadable, unchecked]) {
      expect(w.state.disk.has(target)).toBe(true);
      expect((await w.current()).state).toBe("ready");
    }
  });

  it("refuses a locked, prunable, detached, duplicated or switched checkout", async () => {
    const cases: Array<[string, (w: Awaited<ReturnType<typeof world>>) => void, string]> = [
      [
        "locked",
        (w) => (w.state.worktrees.get(target)!.locked = "editor open"),
        "inventory-ambiguous",
      ],
      [
        "prunable",
        (w) => (w.state.worktrees.get(target)!.prunable = "gitdir missing"),
        "inventory-ambiguous",
      ],
      [
        "detached",
        (w) => Object.assign(w.state.worktrees.get(target)!, { detached: true, branch: undefined }),
        "inventory-ambiguous",
      ],
      [
        "switched",
        (w) => (w.state.worktrees.get(target)!.branch = "refs/heads/other"),
        "mismatched",
      ],
    ];
    for (const [name, arrange, reason] of cases) {
      const w = await world();
      arrange(w);
      await expect(w.reclaim(), name).resolves.toEqual({ status: "refused", reason });
      expect(w.state.disk.has(target), name).toBe(true);
    }
  });

  it("refuses a repository that is not the one the receipt names, a thread that moved on, and a receipt for a folder Octant would not have made", async () => {
    const other = await world();
    other.state.repositoryId = `repo_${"c".repeat(64)}`;
    await expect(other.reclaim()).resolves.toEqual({ status: "refused", reason: "mismatched" });

    const moved_ = await world();
    moved_.state.authorityCheckout = "70000000-0000-4000-8000-0000000000aa";
    await expect(moved_.reclaim()).resolves.toEqual({ status: "refused", reason: "mismatched" });

    const foreign = await world({ worktreePath: "/home/person/projects/precious" });
    foreign.state.worktrees.set("/home/person/projects/precious", {
      branch: `refs/heads/${branch}`,
      head,
    });
    foreign.state.disk.add("/home/person/projects/precious");
    await expect(foreign.reclaim()).resolves.toEqual({ status: "refused", reason: "mismatched" });
    expect(foreign.state.disk.has("/home/person/projects/precious")).toBe(true);
  });

  it("asks for delivery only when the trigger is that the work is pushed or merged", async () => {
    const w = await world();
    w.state.delivered = false;
    await expect(w.reclaim({ trigger: "delivered" })).resolves.toEqual({
      status: "refused",
      reason: "undelivered",
    });
    w.state.delivered = true;
    await expect(w.reclaim({ trigger: "delivered" })).resolves.toMatchObject({
      status: "reclaimed",
    });
  });

  it("finishes a cleanup a crash interrupted after Git removed the folder, and never turns it into a removal", async () => {
    const w = await world();
    vi.spyOn(w.receipts, "transition").mockImplementationOnce(async () => {
      throw new Error("crash before the receipt was written");
    });
    expect((await w.reclaim()).status).toBe("interrupted");
    expect(w.state.disk.has(target)).toBe(false);
    expect(await w.current()).toMatchObject({
      state: "cleanup-pending",
      reclaim: { branch, head },
    });
    vi.restoreAllMocks();

    // The plain cleanup would finish this receipt as a removal and lose the restore.
    await expect(w.plainCleanup()).resolves.toEqual({ status: "refused", reason: "mismatched" });
    expect((await w.current()).state).toBe("cleanup-pending");

    await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
    expect(await w.current()).toMatchObject({ state: "reclaimed", reclaim: { branch, head } });
  });

  it("resumes a cleanup interrupted before Git removed anything, and stops when the folder changed meanwhile", async () => {
    const resumed = await world();
    resumed.state.failures.add("removeWorktree");
    expect((await resumed.reclaim()).status).toBe("interrupted");
    expect((await resumed.current()).state).toBe("cleanup-pending");
    expect(resumed.state.disk.has(target)).toBe(true);
    await expect(resumed.reclaim()).resolves.toMatchObject({ status: "reclaimed" });

    const changed = await world();
    changed.state.failures.add("removeWorktree");
    await changed.reclaim();
    changed.state.worktrees.get(target)!.head = moved;
    await expect(changed.reclaim()).resolves.toEqual({ status: "refused", reason: "mismatched" });
    expect(await changed.current()).toMatchObject({ state: "ready" });
    expect(changed.state.disk.has(target)).toBe(true);
  });

  it("returns an interrupted cleanup to ready when the thread starts working again, so it can take turns", async () => {
    const w = await world();
    w.state.failures.add("removeWorktree");
    await w.reclaim();
    await expect(w.reclaim({ isIdle: () => false })).resolves.toEqual({
      status: "refused",
      reason: "working",
    });
    expect((await w.current()).state).toBe("ready");
  });
});

describe("restoring a cleaned worktree", () => {
  async function reclaimed() {
    const w = await world();
    await w.reclaim();
    return w;
  }

  it("brings the folder back on the recorded branch and commit and makes the checkout available again", async () => {
    const w = await reclaimed();
    const result = await w.restore();
    expect(result.status).toBe("restored");
    expect(w.state.worktrees.get(target)).toMatchObject({ branch: `refs/heads/${branch}`, head });
    expect(await w.current()).toMatchObject({ state: "ready" });
    expect((await w.current()).reclaim).toBeUndefined();
    await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
  });

  it("refuses when the branch moved or was deleted, and leaves the checkout cleaned up", async () => {
    for (const tip of [moved, undefined]) {
      const w = await reclaimed();
      w.state.branchHeads.set(branch, tip);
      await expect(w.restore()).resolves.toEqual({ status: "refused", reason: "restore-mismatch" });
      expect(w.state.disk.has(target)).toBe(false);
      expect((await w.current()).state).toBe("reclaimed");
    }
  });

  it("refuses when another worktree holds the branch or something now sits in the folder", async () => {
    const held = await reclaimed();
    held.state.holders.set("/workspace/elsewhere", branch);
    await expect(held.restore()).resolves.toEqual({
      status: "refused",
      reason: "branch-collision",
    });
    const occupied = await reclaimed();
    occupied.state.disk.add(target);
    await expect(occupied.restore()).resolves.toEqual({
      status: "refused",
      reason: "path-collision",
    });
    expect((await occupied.current()).state).toBe("reclaimed");
  });

  it("refuses a different repository, a thread that moved on, and a checkout that was never cleaned up", async () => {
    const other = await reclaimed();
    other.state.repositoryId = `repo_${"c".repeat(64)}`;
    await expect(other.restore()).resolves.toEqual({ status: "refused", reason: "mismatched" });
    const moved_ = await reclaimed();
    moved_.state.authorityCheckout = "70000000-0000-4000-8000-0000000000aa";
    await expect(moved_.restore()).resolves.toEqual({ status: "refused", reason: "mismatched" });
    const never = await world();
    never.state.branchHeads.set(branch, moved);
    await never.receipts.beginReclaim(never.receiptId, { branch, head });
    await expect(never.restore()).resolves.toEqual({ status: "refused", reason: "not-reclaimed" });
  });

  it("resumes a restore a crash interrupted after Git made the folder, and trusts it only when it matches", async () => {
    const good = await reclaimed();
    good.state.failures.add("restoreWorktree");
    expect((await good.restore()).status).toBe("interrupted");
    expect((await good.current()).state).toBe("restoring");
    // Git made the folder before the process died.
    good.state.worktrees.set(target, { branch: `refs/heads/${branch}`, head });
    good.state.disk.add(target);
    await expect(good.restore()).resolves.toMatchObject({ status: "restored" });
    expect((await good.current()).state).toBe("ready");

    const wrong = await reclaimed();
    wrong.state.failures.add("restoreWorktree");
    await wrong.restore();
    wrong.state.worktrees.set(target, { branch: `refs/heads/${branch}`, head: moved });
    wrong.state.disk.add(target);
    await expect(wrong.restore()).resolves.toEqual({
      status: "refused",
      reason: "restore-mismatch",
    });
    expect(wrong.state.disk.has(target)).toBe(false);
    expect((await wrong.current()).state).toBe("reclaimed");
  });

  it("goes back to cleaned up when Git cannot make the folder", async () => {
    const w = await reclaimed();
    w.state.restoreRejected = true;
    await expect(w.restore()).resolves.toMatchObject({ status: "waiting" });
    expect((await w.current()).state).toBe("reclaimed");
    expect(w.state.disk.has(target)).toBe(false);
    w.state.restoreRejected = false;
    await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
  });
});
