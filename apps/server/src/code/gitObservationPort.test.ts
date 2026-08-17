import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import { GitObservationPort } from "./gitObservationPort";

const directories: string[] = [];

function confinedOptions() {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  return {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("GitObservationPort", () => {
  it("observes exact checkout state without mutating the repository", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const remote = join(root, "remote.git");
    const linked = join(root, "linked worktree");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "tracked.txt"), "before\n");
    git(repository, "add", "--", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    execFileSync("git", ["init", "--bare", remote]);
    git(repository, "remote", "add", "origin", remote);
    git(repository, "push", "--set-upstream", "origin", "main");
    git(repository, "worktree", "add", "-b", "feature/linked", linked);
    writeFileSync(join(repository, "tracked.txt"), "after\n");
    writeFileSync(join(repository, "new file.txt"), "new\n");
    const beforeHead = gitOutput(repository, "rev-parse", "HEAD").trim();

    const result = await new GitObservationPort({ maxDiffBytes: 80, ...confinedOptions() }).observe(
      repository,
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({ kind: "branch", name: "main", oid: beforeHead });
    expect(result.changedPaths).toEqual(["new file.txt", "tracked.txt"]);
    expect(result.statusEntries).toEqual([
      { path: "new file.txt", index: "?", worktree: "?" },
      { path: "tracked.txt", index: " ", worktree: "M" },
    ]);
    expect(result.diff.byteLength).toBeLessThanOrEqual(80);
    expect(result.diff.truncated).toBe(true);
    expect(result.remotes).toEqual([{ name: "origin", fetchUrl: remote, pushUrl: remote }]);
    expect(result.upstream).toEqual({
      remote: "origin",
      mergeRef: "refs/heads/main",
    });
    expect(result.worktrees.map((entry) => entry.path)).toEqual([
      realpathSync(repository),
      realpathSync(linked),
    ]);
    expect(gitOutput(repository, "rev-parse", "HEAD").trim()).toBe(beforeHead);
    expect(gitOutput(repository, "status", "--porcelain=v1")).toContain("tracked.txt");
  });

  it("reports detached HEAD exactly and redacts credentials embedded in remote URLs", async () => {
    const repository = createRepository();
    git(repository, "checkout", "--detach", "HEAD");
    git(repository, "remote", "add", "origin", "https://user:secret@example.test/owner/repo.git");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({
      kind: "detached",
      oid: gitOutput(repository, "rev-parse", "HEAD").trim(),
    });
    expect(result.remotes[0]).toEqual({
      name: "origin",
      fetchUrl: "https://example.test/owner/repo.git",
      pushUrl: "https://example.test/owner/repo.git",
    });
  });

  it("observes a checkout whose branch has no commits yet", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "staged.txt"), "first\n");
    git(repository, "add", "--", "staged.txt");
    writeFileSync(join(repository, "untracked.txt"), "loose\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.head).toEqual({ kind: "unborn", name: "main" });
    expect(result.statusEntries).toEqual([
      { path: "staged.txt", index: "A", worktree: " " },
      { path: "untracked.txt", index: "?", worktree: "?" },
    ]);
    // The empty tree is the only baseline an unborn branch has, so the staged
    // addition is the whole diff.
    expect(result.diff.text).toContain("+++ b/staged.txt");
    expect(result.diff.truncated).toBe(false);
    expect(result.upstream).toBeNull();
    expect(result.stateToken).toMatch(/^[a-f0-9]{64}$/);
  });

  // On any other branch `git diff HEAD` reaches the working tree, so a file
  // staged and then edited again shows its latest text. An unborn branch has to
  // reach just as far, or the pane shows content the file no longer has.
  it("shows the working-tree text of a file edited after staging on an unborn branch", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "staged.txt"), "first\n");
    git(repository, "add", "--", "staged.txt");
    writeFileSync(join(repository, "staged.txt"), "first\nsecond\n");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.statusEntries).toEqual([{ path: "staged.txt", index: "A", worktree: "M" }]);
    expect(result.diff.text).toContain("+second");
  });

  it("reports both sides of a staged rename as explicit changed paths", async () => {
    const repository = createRepository();
    git(repository, "mv", "README.md", "renamed.md");

    const result = await new GitObservationPort(confinedOptions()).observe(repository);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.statusEntries).toEqual([
      {
        path: "renamed.md",
        originalPath: "README.md",
        index: "R",
        worktree: " ",
      },
    ]);
    expect(result.changedPaths).toEqual(["README.md", "renamed.md"]);
  });

  it("binds the state token to reviewed bytes, untracked bytes, and remote destinations", async () => {
    const repository = createRepository();
    writeFileSync(join(repository, "README.md"), "first change\n");
    writeFileSync(join(repository, "untracked.txt"), "first untracked\n");
    git(repository, "remote", "add", "origin", "https://github.com/octant/one.git");
    const port = new GitObservationPort(confinedOptions());

    const first = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "second change\n");
    writeFileSync(join(repository, "untracked.txt"), "second untracked\n");
    const second = await port.observe(repository);
    git(repository, "remote", "set-url", "origin", "https://github.com/octant/two.git");
    const third = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "first staged\n");
    git(repository, "add", "README.md");
    writeFileSync(join(repository, "README.md"), "stable worktree\n");
    const fourth = await port.observe(repository);
    writeFileSync(join(repository, "README.md"), "second staged\n");
    git(repository, "add", "README.md");
    writeFileSync(join(repository, "README.md"), "stable worktree\n");
    const fifth = await port.observe(repository);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(third.status).toBe("ready");
    expect(fourth.status).toBe("ready");
    expect(fifth.status).toBe("ready");
    if (
      first.status !== "ready" ||
      second.status !== "ready" ||
      third.status !== "ready" ||
      fourth.status !== "ready" ||
      fifth.status !== "ready"
    )
      return;
    expect(second.statusEntries).toEqual(first.statusEntries);
    expect(second.stateToken).not.toBe(first.stateToken);
    expect(third.stateToken).not.toBe(second.stateToken);
    expect(fifth.statusEntries).toEqual(fourth.statusEntries);
    expect(fifth.stateToken).not.toBe(fourth.stateToken);
  });
});

function createRepository(): string {
  const root = temporaryDirectory();
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Octant Test");
  git(repository, "config", "user.email", "test@octant.local");
  writeFileSync(join(repository, "README.md"), "test\n");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-git-observation-"));
  directories.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function gitOutput(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
