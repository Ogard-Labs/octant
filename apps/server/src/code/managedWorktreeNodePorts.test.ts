import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CodeCheckoutId,
  decodeBindingRevisionId,
  decodeCodeRepositoryId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { deriveManagedWorktreeCheckoutId } from "./managedCodeThreadCreation";
import { ManagedRootGrantStore } from "./managedRootGrantStore";
import { createManagedWorktreeNodePorts } from "./managedWorktreeNodePorts";
import { ManagedWorktreeReceiptStore } from "./managedWorktreeReceiptStore";
import { ManagedWorktreeReclaimService } from "./managedWorktreeReclaim";
import { createCleanedUpWorktrees } from "./cleanedUpWorktrees";
import { ManagedWorktreeService } from "./managedWorktreeService";

const execFileAsync = promisify(execFile);
const decodeCheckoutId = Schema.decodeUnknownSync(CodeCheckoutId);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("managed worktree Node ports", () => {
  it("creates, observes, and safely removes one owned disposable linked worktree", async () => {
    const fixture = await createRepository();
    const ports = createManagedWorktreeNodePorts();
    const observed = await ports.repository.observe(fixture.repository, signal);
    expect(observed.status).toBe("available");
    if (observed.status !== "available") throw new Error("repository fixture unavailable");
    const repositoryId = decodeCodeRepositoryId(observed.repositoryId);
    const threadId = decodeCodeThreadId("80000000-0000-4000-8000-000000000001");
    const checkoutId = decodeCheckoutId("80000000-0000-4000-8000-000000000002");
    const service = new ManagedWorktreeService({
      grants: new ManagedRootGrantStore(() => "80000000-0000-4000-8000-000000000003"),
      receipts: new ManagedWorktreeReceiptStore({
        dataDirectory: fixture.data,
        uuid: () => "80000000-0000-4000-8000-000000000004",
        clock: () => "2026-07-20T22:00:00.000Z",
      }),
      ...ports,
      authority: {
        observeCleanupEligibility: async () => ({
          status: "eligible",
          active: false,
          delivered: true,
          checkoutId,
          repositoryId,
        }),
      },
      now: () => 1_000,
    });
    const input = {
      authenticatedWindowId: decodeWindowId("80000000-0000-4000-8000-000000000005"),
      projectId: decodeProjectId("80000000-0000-4000-8000-000000000006"),
      bindingRevisionId: decodeBindingRevisionId("80000000-0000-4000-8000-000000000007"),
      repositoryId,
      repositoryRoot: await realpath(fixture.repository),
      threadId,
      checkoutId,
      branchIntent: "feature/managed-fixture",
      startPoint: observed.checkout.head,
      sourceBranch: "development",
      sourceMode: "local" as const,
    } as const;

    const plan = await service.planCreation(input, signal);
    expect(plan.status).toBe("planned");
    if (plan.status !== "planned") throw new Error("expected creation plan");
    expect(plan.targetPath).toBe(
      join(
        dirname(await realpath(fixture.repository)),
        ".octant-worktrees",
        repositoryId,
        threadId,
      ),
    );

    const created = await service.create({ ...input, grantId: plan.grant.grantId }, signal);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") throw new Error("expected ready worktree");
    expect((await ports.repository.observe(created.targetPath, signal)).status).toBe("available");

    // Checkpoint anchors of both this checkout and a sibling sharing the
    // repository's one ref store, which is the arrangement a wholesale cleanup
    // has to be careful with.
    const sibling = "80000000-0000-4000-8000-000000000008";
    const tree = (
      await execFileAsync("git", ["-C", created.targetPath, "write-tree"])
    ).stdout.trim();
    for (const id of [checkoutId, sibling]) {
      await execFileAsync("git", [
        "-C",
        fixture.repository,
        "update-ref",
        `refs/octant/checkpoints/${id}/80000000-0000-4000-8000-000000000009/worktree`,
        tree,
      ]);
    }

    const cleaned = await service.cleanup(
      { receiptId: created.receipt.receiptId, confirmedByLocalUser: true },
      signal,
    );
    expect(cleaned.status).toBe("removed");
    expect(await ports.filesystem.pathExists(created.targetPath, signal)).toBe(false);
    // Removing the worktree does not reach the refs, so cleanup must: the
    // gone checkout's anchors go, and only its own.
    expect(await refs(fixture.repository, `refs/octant/checkpoints/${checkoutId}`)).toEqual([]);
    expect(await refs(fixture.repository, `refs/octant/checkpoints/${sibling}`)).toEqual([
      `refs/octant/checkpoints/${sibling}/80000000-0000-4000-8000-000000000009/worktree`,
    ]);
  });

  describe("discarding a Benchmarks cell's worktree", () => {
    const cellBranch = "benchmark/aabbccdd/001122334455";

    async function readyWorktree(branch: string, threadSuffix: string) {
      const fixture = await createRepository();
      const ports = createManagedWorktreeNodePorts();
      const observed = await ports.repository.observe(fixture.repository, signal);
      if (observed.status !== "available") throw new Error("repository fixture unavailable");
      const repositoryId = decodeCodeRepositoryId(observed.repositoryId);
      const threadId = decodeCodeThreadId(`81000000-0000-4000-8000-00000000000${threadSuffix}`);
      const checkoutId = deriveManagedWorktreeCheckoutId({ repositoryId, threadId });
      let next = 0;
      const receipts = new ManagedWorktreeReceiptStore({
        dataDirectory: fixture.data,
        uuid: () => `81000000-0000-4000-8000-0000000001${String(++next).padStart(2, "0")}`,
        clock: () => "2026-07-20T22:00:00.000Z",
      });
      const service = new ManagedWorktreeService({
        grants: new ManagedRootGrantStore(() => "81000000-0000-4000-8000-0000000000a1"),
        receipts,
        ...ports,
        authority: {
          observeCleanupEligibility: async () => ({
            status: "eligible",
            active: false,
            delivered: true,
            checkoutId,
            repositoryId,
          }),
        },
        now: () => 1_000,
      });
      const input = {
        authenticatedWindowId: decodeWindowId("81000000-0000-4000-8000-0000000000a2"),
        projectId: decodeProjectId("81000000-0000-4000-8000-0000000000a3"),
        bindingRevisionId: decodeBindingRevisionId("81000000-0000-4000-8000-0000000000a4"),
        repositoryId,
        repositoryRoot: await realpath(fixture.repository),
        threadId,
        checkoutId,
        branchIntent: branch,
        startPoint: observed.checkout.head,
        sourceBranch: "development",
        sourceMode: "local" as const,
      } as const;
      const plan = await service.planCreation(input, signal);
      if (plan.status !== "planned") throw new Error("expected creation plan");
      const created = await service.create({ ...input, grantId: plan.grant.grantId }, signal);
      if (created.status !== "ready") throw new Error("expected ready worktree");
      // What an agent leaves behind: an edit to a tracked file and a new one.
      await writeFile(join(created.targetPath, "untracked.txt"), "work in progress\n");
      return { fixture, ports, service, created, receipts };
    }

    async function branches(repository: string): Promise<string[]> {
      return refs(repository, "refs/heads");
    }

    it("removes a dirty worktree and deletes the cell's own branch", async () => {
      const { fixture, ports, service, created } = await readyWorktree(cellBranch, "1");

      // Without the flag, cleanup is what it always was: a dirty worktree stays.
      await expect(
        service.cleanup(
          { receiptId: created.receipt.receiptId, confirmedByLocalUser: true },
          signal,
        ),
      ).resolves.toMatchObject({ status: "refused", reason: "dirty" });
      expect(await ports.filesystem.pathExists(created.targetPath, signal)).toBe(true);

      const cleaned = await service.cleanup(
        {
          receiptId: created.receipt.receiptId,
          confirmedByLocalUser: true,
          discardChanges: { branch: cellBranch },
        },
        signal,
      );

      expect(cleaned.status).toBe("removed");
      expect(await ports.filesystem.pathExists(created.targetPath, signal)).toBe(false);
      expect(await branches(fixture.repository)).toEqual(["refs/heads/development"]);
    });

    it("finishes the branch delete on a retry when the worktree went but the branch stayed", async () => {
      const { fixture, service, created, receipts } = await readyWorktree(cellBranch, "3");
      // A first purge removed the worktree and recorded cleanup-pending, then
      // the branch delete failed.
      await execFileAsync("git", [
        "-C",
        fixture.repository,
        "worktree",
        "remove",
        "--force",
        created.targetPath,
      ]);
      await receipts.transition(created.receipt.receiptId, "cleanup-pending");
      expect(await branches(fixture.repository)).toContain(`refs/heads/${cellBranch}`);

      const retried = await service.cleanup(
        {
          receiptId: created.receipt.receiptId,
          confirmedByLocalUser: true,
          discardChanges: { branch: cellBranch },
        },
        signal,
      );

      expect(retried.status).toBe("removed");
      expect(await branches(fixture.repository)).toEqual(["refs/heads/development"]);
    });

    it("deletes the branch of a receipt that is already removed, only when asked to discard", async () => {
      const { fixture, service, created, receipts } = await readyWorktree(cellBranch, "4");
      await execFileAsync("git", [
        "-C",
        fixture.repository,
        "worktree",
        "remove",
        "--force",
        created.targetPath,
      ]);
      await receipts.transition(created.receipt.receiptId, "cleanup-pending");
      await receipts.transition(created.receipt.receiptId, "removed");

      // Every other caller sees a removed worktree and nothing more.
      await service.cleanup(
        { receiptId: created.receipt.receiptId, confirmedByLocalUser: true },
        signal,
      );
      expect(await branches(fixture.repository)).toContain(`refs/heads/${cellBranch}`);

      await expect(
        service.cleanup(
          {
            receiptId: created.receipt.receiptId,
            confirmedByLocalUser: true,
            discardChanges: { branch: cellBranch },
          },
          signal,
        ),
      ).resolves.toMatchObject({ status: "removed" });
      expect(await branches(fixture.repository)).toEqual(["refs/heads/development"]);
    });

    it("refuses to discard a worktree whose branch is not a benchmark cell's, and leaves everything", async () => {
      const { fixture, ports, service, created } = await readyWorktree("feature/mine", "2");

      for (const branch of [
        "feature/mine",
        "benchmark/aabbccdd",
        "benchmark/aabbccdd/001122334455",
      ]) {
        await expect(
          service.cleanup(
            {
              receiptId: created.receipt.receiptId,
              confirmedByLocalUser: true,
              discardChanges: { branch },
            },
            signal,
          ),
        ).resolves.toMatchObject({ status: "refused", reason: "mismatched" });
      }
      expect(await ports.filesystem.pathExists(created.targetPath, signal)).toBe(true);
      expect(await branches(fixture.repository)).toContain("refs/heads/feature/mine");
    });
  });

  it("counts a worktree delivered only once its commit is on another branch or a remote", async () => {
    const fixture = await createRepository();
    const git = (...args: string[]) =>
      execFileAsync(
        "git",
        ["-c", "user.name=Octant Test", "-c", "user.email=test@octant.local", ...args],
        { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
      );
    const worktree = join(fixture.root, "worktree");
    await git("-C", fixture.repository, "worktree", "add", "-b", "feature/x", worktree);
    const { git: port } = createManagedWorktreeNodePorts();
    const delivered = () =>
      port.isDelivered?.({ targetPath: worktree, branch: "feature/x" }, signal);

    // Nothing new yet: the commit is the one development already has.
    await expect(delivered()).resolves.toEqual({ status: "observed", delivered: true });
    await git("-C", worktree, "commit", "--allow-empty", "-m", "work");
    await expect(delivered()).resolves.toEqual({ status: "observed", delivered: false });
    await git("-C", fixture.repository, "merge", "--ff-only", "feature/x");
    await expect(delivered()).resolves.toEqual({ status: "observed", delivered: true });
    await git("-C", worktree, "commit", "--allow-empty", "-m", "more work");
    await expect(delivered()).resolves.toEqual({ status: "observed", delivered: false });
    await git("-C", fixture.repository, "update-ref", "refs/remotes/origin/feature/x", "feature/x");
    await expect(delivered()).resolves.toEqual({ status: "observed", delivered: true });
  });

  describe("restorable cleanup against real Git", () => {
    async function readyWorktree() {
      const fixture = await createRepository();
      const ports = createManagedWorktreeNodePorts();
      const observed = await ports.repository.observe(fixture.repository, signal);
      if (observed.status !== "available") throw new Error("repository fixture unavailable");
      const repositoryId = decodeCodeRepositoryId(observed.repositoryId);
      const threadId = decodeCodeThreadId("81000000-0000-4000-8000-000000000001");
      const checkoutId = deriveManagedWorktreeCheckoutId({ repositoryId, threadId });
      const receipts = new ManagedWorktreeReceiptStore({
        dataDirectory: fixture.data,
        uuid: () => "81000000-0000-4000-8000-000000000004",
      });
      const authority = {
        observeCleanupEligibility: async () => ({
          status: "eligible" as const,
          active: true,
          delivered: true,
          checkoutId,
          repositoryId,
        }),
      };
      const service = new ManagedWorktreeService({
        grants: new ManagedRootGrantStore(() => "81000000-0000-4000-8000-000000000003"),
        receipts,
        ...ports,
        authority,
        now: () => 1_000,
      });
      const input = {
        authenticatedWindowId: decodeWindowId("81000000-0000-4000-8000-000000000005"),
        projectId: decodeProjectId("81000000-0000-4000-8000-000000000006"),
        bindingRevisionId: decodeBindingRevisionId("81000000-0000-4000-8000-000000000007"),
        repositoryId,
        repositoryRoot: await realpath(fixture.repository),
        threadId,
        checkoutId,
        branchIntent: "feature/restorable",
        startPoint: observed.checkout.head,
        sourceBranch: "development",
        sourceMode: "local" as const,
      } as const;
      const plan = await service.planCreation(input, signal);
      if (plan.status !== "planned") throw new Error("expected creation plan");
      const created = await service.create({ ...input, grantId: plan.grant.grantId }, signal);
      if (created.status !== "ready") throw new Error("expected ready worktree");
      const reclaimService = new ManagedWorktreeReclaimService({
        receipts,
        ...ports,
        authority,
      });
      const git = (...args: string[]) =>
        execFileAsync(
          "git",
          ["-c", "user.name=Octant Test", "-c", "user.email=test@octant.local", ...args],
          { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
        );
      return {
        fixture,
        ports,
        created,
        git,
        checkoutId,
        receipts,
        receiptId: created.receipt.receiptId,
        reclaim: (trigger: "inactivity" | "delivered" = "inactivity") =>
          reclaimService.reclaim(
            { receiptId: created.receipt.receiptId, trigger, isIdle: () => true },
            signal,
          ),
        restore: () => reclaimService.restore({ receiptId: created.receipt.receiptId }, signal),
        abandon: () => reclaimService.abandon({ receiptId: created.receipt.receiptId }, signal),
        state: async () => (await receipts.load(created.receipt.receiptId))?.state,
        /** What a person's Restore button reaches: the same service, behind the thread's own answer. */
        personRestore: () => {
          const thread = { id: threadId, projectId: "p", checkoutId, title: "t" };
          return createCleanedUpWorktrees({
            readCodeThreads: () => [thread] as never,
            readCodeThread: () => thread as never,
            readCodeCheckout: () =>
              ({
                kind: "managed-worktree",
                ownershipReceiptId: created.receipt.receiptId,
              }) as never,
            loadReceipt: (id) => receipts.load(id),
            restore: (id, stop) => reclaimService.restore({ receiptId: id }, stop),
            abandon: (id, stop) => reclaimService.abandon({ receiptId: id }, stop),
          }).restore(threadId);
        },
      };
    }

    it("sees untracked files, ignored files and empty folders that no commit holds, and a branch's commit", async () => {
      const w = await readyWorktree();
      const files = () => w.ports.git.hasUnrecoverableFiles?.(w.created.targetPath, signal);
      await expect(files()).resolves.toEqual({ status: "observed", found: false });
      await writeFile(join(w.created.targetPath, "notes.txt"), "keep");
      await expect(files()).resolves.toEqual({ status: "observed", found: true });
      await rm(join(w.created.targetPath, "notes.txt"));
      await mkdir(join(w.created.targetPath, "empty-folder"));
      await expect(files()).resolves.toEqual({ status: "observed", found: true });
      await rm(join(w.created.targetPath, "empty-folder"), { recursive: true });
      await writeFile(join(w.created.targetPath, ".gitignore"), "build/\n");
      await w.git("-C", w.created.targetPath, "add", ".gitignore");
      await w.git("-C", w.created.targetPath, "commit", "-m", "ignore build");
      await expect(files()).resolves.toEqual({ status: "observed", found: false });
      await mkdir(join(w.created.targetPath, "build"));
      await writeFile(join(w.created.targetPath, "build", "out.js"), "built");
      await expect(files()).resolves.toEqual({ status: "observed", found: true });

      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await expect(
        w.ports.git.resolveBranchHead?.(
          { repositoryRoot: await realpath(w.fixture.repository), branch: "feature/restorable" },
          signal,
        ),
      ).resolves.toEqual({ status: "observed", head });
      await expect(
        w.ports.git.resolveBranchHead?.(
          { repositoryRoot: await realpath(w.fixture.repository), branch: "feature/missing" },
          signal,
        ),
      ).resolves.toEqual({ status: "observed" });
      await expect(
        w.ports.git.resolveBranchHead?.(
          { repositoryRoot: await realpath(w.fixture.repository), branch: "--bad" },
          signal,
        ),
      ).resolves.toEqual({ status: "failed" });
    });

    it("removes only the folder, keeps the branch, its commits and the checkpoint refs, then restores the same commit", async () => {
      const w = await readyWorktree();
      await writeFile(join(w.created.targetPath, "work.txt"), "committed work");
      await w.git("-C", w.created.targetPath, "add", "work.txt");
      await w.git("-C", w.created.targetPath, "commit", "-m", "work");
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      const tree = (await w.git("-C", w.created.targetPath, "write-tree")).stdout.trim();
      const anchor = `refs/octant/checkpoints/${w.checkoutId}/81000000-0000-4000-8000-000000000009/worktree`;
      await w.git("-C", w.fixture.repository, "update-ref", anchor, tree);

      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(false);
      expect(await w.state()).toBe("reclaimed");
      expect(await refs(w.fixture.repository, "refs/heads")).toContain(
        "refs/heads/feature/restorable",
      );
      expect(await refs(w.fixture.repository, `refs/octant/checkpoints/${w.checkoutId}`)).toEqual([
        anchor,
      ]);

      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await w.state()).toBe("ready");
      expect((await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim()).toBe(
        head,
      );
      expect((await w.git("-C", w.created.targetPath, "status", "--porcelain")).stdout).toBe("");
    });

    it("keeps a folder with untracked or ignored files, and refuses to restore onto a branch that moved", async () => {
      const w = await readyWorktree();
      await writeFile(join(w.created.targetPath, "scratch.txt"), "not committed");
      await expect(w.reclaim()).resolves.toEqual({ status: "refused", reason: "dirty" });
      await rm(join(w.created.targetPath, "scratch.txt"));
      await mkdir(join(w.created.targetPath, "empty-folder"));
      await expect(w.reclaim()).resolves.toEqual({
        status: "refused",
        reason: "unrecoverable-files",
      });
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(true);
      expect(await w.state()).toBe("ready");
      await rm(join(w.created.targetPath, "empty-folder"), { recursive: true });

      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      // Someone moves the branch while the folder is gone.
      await w.git("-C", w.fixture.repository, "commit", "--allow-empty", "-m", "elsewhere");
      await w.git("-C", w.fixture.repository, "branch", "-f", "feature/restorable", "development");
      await expect(w.restore()).resolves.toEqual({ status: "refused", reason: "restore-mismatch" });
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(false);
      expect(await w.state()).toBe("reclaimed");
    });

    it("tells the person the recorded branch and commit when the branch moved or is gone, and restores once it is back", async () => {
      const w = await readyWorktree();
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      await w.git("-C", w.fixture.repository, "commit", "--allow-empty", "-m", "elsewhere");
      await w.git("-C", w.fixture.repository, "branch", "-f", "feature/restorable", "development");
      for (const gone of [false, true]) {
        if (gone) await w.git("-C", w.fixture.repository, "branch", "-D", "feature/restorable");
        const refused = await w.personRestore();
        expect(refused).toMatchObject({ reason: "branch-changed" });
        expect(JSON.stringify(refused)).toContain("feature/restorable");
        expect(JSON.stringify(refused)).toContain(head);
        expect(await w.state()).toBe("reclaimed");
      }
      await w.git("-C", w.fixture.repository, "branch", "feature/restorable", head);
      await expect(w.personRestore()).resolves.toMatchObject({
        kind: "cleaned-up-worktree-restored",
      });
      expect(await w.state()).toBe("ready");
      expect((await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim()).toBe(
        head,
      );
    });

    async function committedFile(w: Awaited<ReturnType<typeof readyWorktree>>) {
      await writeFile(join(w.created.targetPath, "tracked.txt"), "one\n");
      await w.git("-C", w.created.targetPath, "add", "tracked.txt");
      await w.git("-C", w.created.targetPath, "commit", "-m", "track");
    }

    it("keeps a folder whose edit Git was told to ignore, and one on a sparse checkout", async () => {
      for (const flag of ["--skip-worktree", "--assume-unchanged"]) {
        const w = await readyWorktree();
        await committedFile(w);
        await w.git("-C", w.created.targetPath, "update-index", flag, "tracked.txt");
        await writeFile(join(w.created.targetPath, "tracked.txt"), "edited and invisible\n");
        await expect(w.reclaim(), flag).resolves.toEqual({
          status: "refused",
          reason: "unrecoverable-files",
        });
        expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(true);
        expect(await w.state()).toBe("ready");
      }
      const sparse = await readyWorktree();
      await sparse.git("-C", sparse.created.targetPath, "config", "core.sparseCheckout", "true");
      await expect(sparse.reclaim()).resolves.toEqual({
        status: "refused",
        reason: "unsupported-checkout",
      });
      expect(await sparse.state()).toBe("ready");
    });

    it("keeps a folder with a submodule or an operation under way, before the receipt leaves ready", async () => {
      const withSubmodule = await readyWorktree();
      const library = join(withSubmodule.fixture.root, "library");
      await withSubmodule.git("init", "-b", "main", library);
      await withSubmodule.git("-C", library, "commit", "--allow-empty", "-m", "library");
      await withSubmodule.git(
        "-C",
        withSubmodule.created.targetPath,
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        library,
        "vendor",
      );
      await withSubmodule.git("-C", withSubmodule.created.targetPath, "commit", "-m", "link");
      await expect(withSubmodule.reclaim()).resolves.toEqual({
        status: "refused",
        reason: "unsupported-checkout",
      });
      expect(await withSubmodule.state()).toBe("ready");

      const merging = await readyWorktree();
      const gitDirectory = (
        await merging.git("-C", merging.created.targetPath, "rev-parse", "--absolute-git-dir")
      ).stdout.trim();
      await writeFile(join(gitDirectory, "MERGE_HEAD"), `${"a".repeat(40)}\n`);
      await expect(merging.reclaim()).resolves.toEqual({
        status: "refused",
        reason: "unsupported-checkout",
      });
      expect(await merging.state()).toBe("ready");
    });

    it("counts a worktree nobody committed to as delivered only for the archive, never for the merged trigger", async () => {
      const w = await readyWorktree();
      await expect(w.reclaim("delivered")).resolves.toEqual({
        status: "refused",
        reason: "undelivered",
      });
      expect(await w.state()).toBe("ready");
      await w.git("-C", w.created.targetPath, "commit", "--allow-empty", "-m", "work");
      await w.git("-C", w.fixture.repository, "merge", "--ff-only", "feature/restorable");
      await expect(w.reclaim("delivered")).resolves.toMatchObject({ status: "reclaimed" });
    });

    it("finishes a removal that was cut short instead of handing back a half-deleted folder", async () => {
      const w = await readyWorktree();
      await committedFile(w);
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await w.receipts.beginReclaim(w.receiptId, { branch: "feature/restorable", head });
      await w.receipts.markRemovalStarted(w.receiptId);
      await rm(join(w.created.targetPath, "tracked.txt"));
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(false);
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
    });

    async function begun(w: Awaited<ReturnType<typeof readyWorktree>>) {
      await committedFile(w);
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await w.receipts.beginReclaim(w.receiptId, { branch: "feature/restorable", head });
      await w.receipts.markRemovalStarted(w.receiptId);
    }

    async function listed(w: Awaited<ReturnType<typeof readyWorktree>>): Promise<string> {
      return (await w.git("-C", w.fixture.repository, "worktree", "list", "--porcelain")).stdout;
    }

    it("gives a half-deleted folder that also holds other changes back to the thread, with nothing deleted", async () => {
      for (const act of ["reclaim", "abandon"] as const) {
        const w = await readyWorktree();
        await begun(w);
        await rm(join(w.created.targetPath, "tracked.txt"));
        await writeFile(join(w.created.targetPath, "notes.txt"), "keep me");
        await expect(w[act]()).resolves.toMatchObject({
          status: act === "reclaim" ? "refused" : "restored",
        });
        expect(await readFile(join(w.created.targetPath, "notes.txt"), "utf8")).toBe("keep me");
        expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
        expect(await w.state()).toBe("ready");
      }
    });

    it("puts back a missing file Git was told to skip and leaves an invisible edit alone, without a forced removal", async () => {
      const w = await readyWorktree();
      await committedFile(w);
      await writeFile(join(w.created.targetPath, "edited.txt"), "committed\n");
      await w.git("-C", w.created.targetPath, "add", "edited.txt");
      await w.git("-C", w.created.targetPath, "commit", "-m", "second");
      await w.git("-C", w.created.targetPath, "update-index", "--skip-worktree", "tracked.txt");
      await w.git("-C", w.created.targetPath, "update-index", "--assume-unchanged", "edited.txt");
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await w.receipts.beginReclaim(w.receiptId, { branch: "feature/restorable", head });
      await w.receipts.markRemovalStarted(w.receiptId);
      await rm(join(w.created.targetPath, "tracked.txt"));
      await writeFile(join(w.created.targetPath, "edited.txt"), "an edit status cannot see\n");
      await expect(w.reclaim()).resolves.toEqual({
        status: "refused",
        reason: "unrecoverable-files",
      });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
      expect(await readFile(join(w.created.targetPath, "edited.txt"), "utf8")).toBe(
        "an edit status cannot see\n",
      );
      expect(await w.state()).toBe("ready");
    });

    it("drops only this receipt's own registration when a removal stopped after the folder went, and not another worktree's", async () => {
      const w = await readyWorktree();
      const otherGone = join(w.fixture.root, "other-gone");
      const otherLocked = join(w.fixture.root, "other-locked");
      await w.git("-C", w.fixture.repository, "worktree", "add", "-b", "gone", otherGone);
      await w.git("-C", w.fixture.repository, "worktree", "add", "-b", "locked", otherLocked);
      await w.git("-C", w.fixture.repository, "worktree", "lock", otherLocked);
      await rm(otherGone, { recursive: true });
      await begun(w);
      await rm(w.created.targetPath, { recursive: true });
      expect(await listed(w)).toContain(w.created.targetPath);
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      const after = await listed(w);
      expect(after).not.toContain(w.created.targetPath);
      expect(after).toContain("other-gone");
      expect(after).toContain("other-locked");
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
    });

    it("restores a checkout whose registration was left behind, from the person's Restore", async () => {
      const w = await readyWorktree();
      await begun(w);
      await rm(w.created.targetPath, { recursive: true });
      await expect(w.abandon()).resolves.toMatchObject({ status: "reclaimed" });
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await w.state()).toBe("ready");
      // A cleanup that finished but left the registration is dropped by the restore itself.
      await w.receipts.beginReclaim(w.receiptId, {
        branch: "feature/restorable",
        head: (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim(),
      });
      await w.receipts.markRemovalStarted(w.receiptId);
      await rm(w.created.targetPath, { recursive: true });
      await w.receipts.transition(w.receiptId, "reclaimed");
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await w.state()).toBe("ready");
    });

    it("names the folder in the way when a pruned registration leaves its folder behind, and restores once it is moved", async () => {
      const w = await readyWorktree();
      await begun(w);
      // Git was killed after it deleted the folder's link to the repository.
      await rm(join(w.created.targetPath, ".git"));
      await w.git("-C", w.fixture.repository, "worktree", "prune");
      expect(await listed(w)).not.toContain(w.created.targetPath);
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(true);

      const refused = await w.personRestore();
      expect(refused).toMatchObject({
        kind: "cleaned-up-worktree-refused",
        reason: "folder-in-use",
      });
      expect(JSON.stringify(refused)).toContain(w.created.targetPath);
      expect(await w.state()).toBe("cleanup-pending");
      await expect(w.reclaim()).resolves.toEqual({ status: "refused", reason: "path-collision" });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");

      await rename(w.created.targetPath, join(w.fixture.root, "moved-away"));
      await expect(w.personRestore()).resolves.toMatchObject({
        kind: "cleaned-up-worktree-restored",
      });
      expect(await w.state()).toBe("ready");
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
    });

    /** The folder of a restore killed during `git worktree add`: locked, no index, a lock left, files missing. */
    async function killedAdd(w: Awaited<ReturnType<typeof readyWorktree>>) {
      await committedFile(w);
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      const repository = await realpath(w.fixture.repository);
      await w.git("-C", repository, "worktree", "add", w.created.targetPath, "feature/restorable");
      await w.git(
        "-C",
        repository,
        "worktree",
        "lock",
        "--reason",
        "initializing",
        w.created.targetPath,
      );
      const admin = (
        await w.git("-C", w.created.targetPath, "rev-parse", "--absolute-git-dir")
      ).stdout.trim();
      await rm(join(admin, "index"));
      await writeFile(join(admin, "index.lock"), "");
      await w.receipts.transition(w.receiptId, "restoring");
      return { repository, admin };
    }

    it("recovers a restore killed during git worktree add by discarding exactly that attempt and adding again", async () => {
      const w = await readyWorktree();
      await killedAdd(w);
      await rm(join(w.created.targetPath, "tracked.txt"));
      expect(await listed(w)).toContain("locked initializing");
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await w.state()).toBe("ready");
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
      expect(await listed(w)).not.toContain("locked");
      expect((await w.git("-C", w.created.targetPath, "status", "--porcelain")).stdout).toBe("");
    });

    it("keeps a killed add's folder and deletes nothing when it holds a file the commit does not", async () => {
      const w = await readyWorktree();
      await killedAdd(w);
      await writeFile(join(w.created.targetPath, "notes.txt"), "keep me");
      await expect(w.restore()).resolves.toEqual({ status: "refused", reason: "partial-folder" });
      expect(await readFile(join(w.created.targetPath, "notes.txt"), "utf8")).toBe("keep me");
      expect(await listed(w)).toContain("locked initializing");
      expect(await w.state()).toBe("restoring");
      // A file the commit has but holds differently is the person's too.
      await rm(join(w.created.targetPath, "notes.txt"));
      await writeFile(join(w.created.targetPath, "tracked.txt"), "edited\n");
      await expect(w.restore()).resolves.toEqual({ status: "refused", reason: "partial-folder" });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("edited\n");
    });

    it("keeps a folder an interrupted restore made when its branch changed and it holds an ignored file", async () => {
      const w = await readyWorktree();
      await committedFile(w);
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      const repository = await realpath(w.fixture.repository);
      await w.git("-C", repository, "worktree", "add", w.created.targetPath, "feature/restorable");
      await w.receipts.transition(w.receiptId, "restoring");
      // The person moves on in the folder and keeps a local file Git ignores.
      await w.git("-C", w.created.targetPath, "switch", "-c", "feature/someone-elses");
      await w.git("-C", w.created.targetPath, "commit", "--allow-empty", "-m", "elsewhere");
      const exclude = (
        await w.git("-C", w.created.targetPath, "rev-parse", "--git-common-dir")
      ).stdout.trim();
      await writeFile(
        join(exclude.startsWith("/") ? exclude : join(w.created.targetPath, exclude), "info", "exclude"),
        ".env\n",
      );
      await writeFile(join(w.created.targetPath, ".env"), "SECRET=1\n");
      await expect(w.restore()).resolves.toEqual({ status: "refused", reason: "path-collision" });
      expect(await readFile(join(w.created.targetPath, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(await listed(w)).toContain(w.created.targetPath);
      expect(await w.state()).not.toBe("ready");
    });

    it("does not call a restored folder ready while it has no index or a lock left, and makes it whole", async () => {
      const w = await readyWorktree();
      const { admin } = await killedAdd(w);
      // Git got as far as releasing its lock, but the checkout never finished.
      await w.git("-C", w.fixture.repository, "worktree", "unlock", w.created.targetPath);
      await expect(
        w.ports.git.inspectRestoredFolder?.(w.created.targetPath, signal),
      ).resolves.toEqual({ status: "observed", whole: false });
      await rm(join(admin, "index.lock"));
      await expect(
        w.ports.git.inspectRestoredFolder?.(w.created.targetPath, signal),
      ).resolves.toEqual({ status: "observed", whole: false });
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      await expect(
        w.ports.git.inspectRestoredFolder?.(w.created.targetPath, signal),
      ).resolves.toEqual({ status: "observed", whole: true });
      expect(await w.state()).toBe("ready");
    });

    it("drops a registration a removal left after it was killed while Git deleted its admin directory", async () => {
      for (const damage of ["HEAD", "branch"] as const) {
        const w = await readyWorktree();
        await begun(w);
        await w.receipts.markRemovalStarted(w.receiptId);
        const admin = (
          await w.git("-C", w.created.targetPath, "rev-parse", "--absolute-git-dir")
        ).stdout.trim();
        if (damage === "HEAD") await rm(join(admin, "HEAD"));
        else await writeFile(join(admin, "HEAD"), `${"0".repeat(40)}\n`);
        await rm(w.created.targetPath, { recursive: true });
        expect(await listed(w), damage).toContain("prunable");
        await expect(w.reclaim(), damage).resolves.toMatchObject({ status: "reclaimed" });
        expect(await listed(w), damage).not.toContain(w.created.targetPath);
        await expect(w.restore(), damage).resolves.toMatchObject({ status: "restored" });
      }
    });

    it("links a folder back when the repository records worktree paths relative to each other", async () => {
      const w = await readyWorktree();
      await begun(w);
      await w.receipts.markRemovalStarted(w.receiptId);
      await w.git("-C", w.fixture.repository, "worktree", "repair", "--relative-paths");
      const recorded = await readFile(
        join(
          (
            await w.git("-C", w.created.targetPath, "rev-parse", "--absolute-git-dir")
          ).stdout.trim(),
          "gitdir",
        ),
        "utf8",
      );
      expect(recorded.startsWith("/")).toBe(false);
      await rm(join(w.created.targetPath, ".git"));
      await rm(join(w.created.targetPath, "tracked.txt"));
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
    });

    it("does not treat a file the person deleted while the cleanup sat pending as Git's partial removal", async () => {
      const w = await readyWorktree();
      await committedFile(w);
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      // No removal of ours was ever started for this receipt.
      await w.receipts.beginReclaim(w.receiptId, { branch: "feature/restorable", head });
      await rm(join(w.created.targetPath, "tracked.txt"));
      await expect(w.reclaim()).resolves.toEqual({ status: "refused", reason: "dirty" });
      expect(
        await w.ports.filesystem.pathExists(join(w.created.targetPath, "tracked.txt"), signal),
      ).toBe(false);
      expect(await w.state()).toBe("ready");
    });

    it("keeps working around unrelated locked and prunable worktrees", async () => {
      const w = await readyWorktree();
      const otherGone = join(w.fixture.root, "other-gone");
      const otherLocked = join(w.fixture.root, "other-locked");
      await w.git("-C", w.fixture.repository, "worktree", "add", "-b", "gone", otherGone);
      await w.git("-C", w.fixture.repository, "worktree", "add", "-b", "locked", otherLocked);
      await w.git("-C", w.fixture.repository, "worktree", "lock", otherLocked);
      await rm(otherGone, { recursive: true });
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await listed(w)).toContain("other-gone");
    });

    it("links a folder that lost its .git file back, finishing the removal only when nothing else is in it", async () => {
      const bare = await readyWorktree();
      await begun(bare);
      await rm(join(bare.created.targetPath, ".git"));
      await rm(join(bare.created.targetPath, "tracked.txt"));
      expect(await listed(bare)).toContain("prunable");
      await expect(bare.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      expect(await bare.ports.filesystem.pathExists(bare.created.targetPath, signal)).toBe(false);
      await expect(bare.restore()).resolves.toMatchObject({ status: "restored" });

      for (const act of ["reclaim", "abandon"] as const) {
        const extra = await readyWorktree();
        await begun(extra);
        await rm(join(extra.created.targetPath, ".git"));
        await rm(join(extra.created.targetPath, "tracked.txt"));
        await writeFile(join(extra.created.targetPath, "notes.txt"), "keep me");
        await expect(extra[act]()).resolves.toMatchObject({
          status: act === "reclaim" ? "refused" : "restored",
        });
        expect(await readFile(join(extra.created.targetPath, "notes.txt"), "utf8")).toBe("keep me");
        expect(await readFile(join(extra.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
        expect(await extra.state()).toBe("ready");
        expect(await listed(extra)).not.toContain("prunable");
      }
    });
  });

  it("rejects invalid branch names before invoking worktree mutation", async () => {
    const fixture = await createRepository();
    const ports = createManagedWorktreeNodePorts();
    await expect(ports.git.branchExists(fixture.repository, "--invalid", signal)).rejects.toThrow(
      "invalid Git branch intent",
    );
  });
});

const signal = new AbortController().signal;

async function refs(repository: string, namespace: string): Promise<string[]> {
  const listed = await execFileAsync("git", [
    "-C",
    repository,
    "for-each-ref",
    "--format=%(refname)",
    namespace,
  ]);
  return listed.stdout.split("\n").filter((name) => name.length > 0);
}

async function createRepository() {
  const root = await mkdtemp(join(tmpdir(), "octant-managed-worktree-"));
  directories.push(root);
  const repository = join(root, "repository");
  const data = join(root, "data");
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  await execFileAsync("git", ["init", "-b", "development", repository], { env: environment });
  await execFileAsync(
    "git",
    [
      "-C",
      repository,
      "-c",
      "user.name=Octant Test",
      "-c",
      "user.email=test@octant.local",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { env: environment },
  );
  return { root, repository, data };
}
