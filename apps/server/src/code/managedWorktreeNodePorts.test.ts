import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
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
        state: async () => (await receipts.load(created.receipt.receiptId))?.state,
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
      await rm(join(w.created.targetPath, "tracked.txt"));
      await expect(w.reclaim()).resolves.toMatchObject({ status: "reclaimed" });
      expect(await w.ports.filesystem.pathExists(w.created.targetPath, signal)).toBe(false);
      await expect(w.restore()).resolves.toMatchObject({ status: "restored" });
      expect(await readFile(join(w.created.targetPath, "tracked.txt"), "utf8")).toBe("one\n");
    });

    it("leaves a half-deleted folder that also holds other changes where it is, blocked", async () => {
      const w = await readyWorktree();
      await committedFile(w);
      const head = (await w.git("-C", w.created.targetPath, "rev-parse", "HEAD")).stdout.trim();
      await w.receipts.beginReclaim(w.receiptId, { branch: "feature/restorable", head });
      await rm(join(w.created.targetPath, "tracked.txt"));
      await writeFile(join(w.created.targetPath, "notes.txt"), "keep me");
      await expect(w.reclaim()).resolves.toMatchObject({ status: "refused" });
      expect(await readFile(join(w.created.targetPath, "notes.txt"), "utf8")).toBe("keep me");
      expect(await w.state()).toBe("cleanup-pending");
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
