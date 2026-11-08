import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
      const service = new ManagedWorktreeService({
        grants: new ManagedRootGrantStore(() => "81000000-0000-4000-8000-0000000000a1"),
        receipts: new ManagedWorktreeReceiptStore({
          dataDirectory: fixture.data,
          uuid: () => `81000000-0000-4000-8000-0000000001${String(++next).padStart(2, "0")}`,
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
      return { fixture, ports, service, created };
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
