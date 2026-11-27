import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { scanHostWorktrees } from "./hostWorktreeDiscovery";
import { octantOwnedWorktreePaths, removeHostWorktree } from "./hostWorktreeRemoval";
import { ManagedWorktreeReceiptStore } from "./managedWorktreeReceiptStore";

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function git(...args: string[]) {
  return execFileAsync(
    "git",
    ["-c", "user.name=Octant Test", "-c", "user.email=test@octant.local", ...args],
    { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
  );
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-host-remove-")));
  directories.push(root);
  const repo = join(root, "repo");
  await git("init", "-q", "-b", "main", repo);
  await writeFile(join(repo, "a.txt"), "one\n");
  await git("-C", repo, "add", "a.txt");
  await git("-C", repo, "commit", "-q", "-m", "first");
  const add = async (name: string, ...extra: string[]) => {
    const path = join(root, "wt", name);
    await git("-C", repo, "worktree", "add", "-q", ...extra, path);
    return path;
  };
  return { root, repo, add };
}

const later = () => Date.now() + 60 * 60 * 1000;
const deps = (owned: ReadonlyArray<string> = [], now = later) => ({
  ownedWorktreePaths: async () => new Set(owned),
  now,
});

describe("a worktree imported from Octant that no thread points at any more", () => {
  it("is listed as Octant's own and refused by Disk cleanup", async () => {
    const { root, repo, add } = await fixture();
    const octantFolder = await add("octant", "-b", "octant/imported");
    const head = (await git("-C", octantFolder, "rev-parse", "HEAD")).stdout.trim();
    const dataDirectory = join(root, "data");
    const receipts = new ManagedWorktreeReceiptStore({ dataDirectory });
    const created = await receipts.create({
      repositoryId: `repo_${"a".repeat(64)}`,
      threadId: "60000000-0000-4000-8000-000000000001",
      checkoutId: "60000000-0000-4000-8000-000000000002",
      canonicalRepositoryPath: repo,
      canonicalWorktreePath: octantFolder,
      branchIntent: "octant/imported",
      refIntent: "refs/heads/octant/imported",
      expectedHead: head,
    });
    // As the import writes it; the thread has since moved to a worktree of its own.
    const file = join(dataDirectory, "managed-worktree-receipts", `${created.receiptId}.json`);
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(
      file,
      `${JSON.stringify({ ...stored, state: "ready", importedFrom: "octant" })}\n`,
    );
    const ownedWorktreePaths = () =>
      octantOwnedWorktreePaths({
        readCodeThreads: () => [],
        readCodeCheckout: () => undefined,
        receipts,
      });

    const scan = await scanHostWorktrees(
      {
        homeDirectory: root,
        platform: process.platform,
        projectFolders: () => [repo],
        ownedWorktreePaths,
        now: Date.now,
      },
      signal,
    );
    // Listed as Octant's own, which Disk cleanup offers no removal for.
    const listed = scan.repositories
      .flatMap((repository) => repository.worktrees)
      .find((worktree) => worktree.path === octantFolder);
    expect(listed?.ownedByOctant).toBe(true);
    await expect(
      removeHostWorktree(
        { repositoryPath: repo, worktreePath: octantFolder },
        { ownedWorktreePaths, now: later },
        signal,
      ),
    ).resolves.toMatchObject({ reason: "owned-by-octant" });
    expect(existsSync(octantFolder)).toBe(true);
  });
});

describe("removing a worktree Octant did not make", () => {
  it("refuses the repository's own checkout, a locked worktree and one Octant owns", async () => {
    const { repo, add } = await fixture();
    const locked = await add("locked", "-b", "locked");
    await git("-C", repo, "worktree", "lock", locked);
    const owned = await add("owned", "-b", "owned");
    const remove = (worktreePath: string) =>
      removeHostWorktree({ repositoryPath: repo, worktreePath }, deps([owned]), signal);
    await expect(remove(repo)).resolves.toMatchObject({ reason: "main-worktree" });
    await expect(remove(locked)).resolves.toMatchObject({ reason: "locked" });
    await expect(remove(owned)).resolves.toMatchObject({ reason: "owned-by-octant" });
  });

  it("refuses uncommitted or untracked changes and a repository that sets a filter command", async () => {
    const { root, repo, add } = await fixture();
    const worktree = await add("dirty", "-b", "dirty");
    await writeFile(join(worktree, "notes.txt"), "draft\n");
    await expect(
      removeHostWorktree({ repositoryPath: repo, worktreePath: worktree }, deps(), signal),
    ).resolves.toMatchObject({ reason: "dirty" });
    await rm(join(worktree, "notes.txt"));
    const marker = join(root, "filter-ran");
    await git("-C", repo, "config", "filter.evil.clean", `touch ${marker}; cat`);
    await expect(
      removeHostWorktree({ repositoryPath: repo, worktreePath: worktree }, deps(), signal),
    ).resolves.toMatchObject({ reason: "runs-filters" });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(worktree)).toBe(true);
  });

  it("asks to confirm the exact unpushed commits and recent use, then removes it and keeps the branch", async () => {
    const { repo, add } = await fixture();
    const worktree = await add("feature", "-b", "feature");
    await git("-C", worktree, "commit", "-q", "--allow-empty", "-m", "only here");
    const request = { repositoryPath: repo, worktreePath: worktree };

    const first = await removeHostWorktree(request, deps([], Date.now), signal);
    expect(first).toMatchObject({
      status: "needs-confirmation",
      reason: "unpushed-commits",
      commitCount: 1,
    });
    const commits =
      first.status === "needs-confirmation" ? (first.commits ?? []).map((c) => c.hash) : [];
    expect(first).toMatchObject({ commits: [{ subject: "only here" }] });

    // A commit made after the person looked changes the set, so it asks again.
    await git("-C", worktree, "commit", "-q", "--allow-empty", "-m", "and another");
    await expect(
      removeHostWorktree({ ...request, confirmedCommits: commits }, deps([], Date.now), signal),
    ).resolves.toMatchObject({ reason: "unpushed-commits", commitCount: 2 });

    const both =
      (
        (await removeHostWorktree(request, deps([], Date.now), signal)) as {
          commits?: { hash: string }[];
        }
      ).commits?.map((c) => c.hash) ?? [];
    await expect(
      removeHostWorktree({ ...request, confirmedCommits: both }, deps([], Date.now), signal),
    ).resolves.toMatchObject({ status: "needs-confirmation", reason: "recently-active" });
    await expect(
      removeHostWorktree(
        { ...request, confirmedCommits: both, confirmedRecentActivity: true },
        deps([], Date.now),
        signal,
      ),
    ).resolves.toEqual({ status: "removed" });
    expect(existsSync(worktree)).toBe(false);
    await expect(
      git("-C", repo, "rev-parse", "--verify", "refs/heads/feature"),
    ).resolves.toBeTruthy();
  });

  it("refuses a detached HEAD whose commits no branch would keep", async () => {
    const { repo, add } = await fixture();
    const worktree = await add("detached", "--detach");
    await git("-C", worktree, "commit", "-q", "--allow-empty", "-m", "lost otherwise");
    await expect(
      removeHostWorktree({ repositoryPath: repo, worktreePath: worktree }, deps(), signal),
    ).resolves.toMatchObject({ reason: "detached-commits" });
  });

  it("keeps the record of a gone detached worktree whose commits nothing else keeps", async () => {
    const { repo, add } = await fixture();
    const worktree = await add("detached-gone", "--detach");
    await git("-C", worktree, "commit", "-q", "--allow-empty", "-m", "only in this record");
    await rm(worktree, { recursive: true, force: true });
    await expect(
      removeHostWorktree({ repositoryPath: repo, worktreePath: worktree }, deps(), signal),
    ).resolves.toMatchObject({ reason: "detached-commits" });
    const { stdout } = await git("-C", repo, "worktree", "list", "--porcelain");
    expect(stdout).toContain(worktree);
  });

  it("forgets only the record of a worktree whose folder is gone", async () => {
    const { repo, add } = await fixture();
    const gone = await add("gone", "-b", "gone");
    const alsoGone = await add("also-gone", "-b", "also-gone");
    await rm(gone, { recursive: true, force: true });
    await rm(alsoGone, { recursive: true, force: true });
    await expect(
      removeHostWorktree({ repositoryPath: repo, worktreePath: gone }, deps(), signal),
    ).resolves.toEqual({ status: "forgotten" });
    const { stdout } = await git("-C", repo, "worktree", "list", "--porcelain");
    expect(stdout).not.toContain(gone + "\n");
    expect(stdout).toContain(alsoGone);
    await expect(git("-C", repo, "rev-parse", "--verify", "refs/heads/gone")).resolves.toBeTruthy();
  });
});
