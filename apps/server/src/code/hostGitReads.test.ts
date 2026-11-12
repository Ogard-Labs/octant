import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorktreeList, readWorktreeStatus, repositoryFilterCommands } from "./hostGitReads";

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "octant-host-git-"));
  directories.push(root);
  const repo = join(root, "repo");
  const git = (...args: string[]) =>
    execFileAsync(
      "git",
      ["-C", repo, "-c", "user.name=Octant Test", "-c", "user.email=test@octant.local", ...args],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } },
    );
  await execFileAsync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-q", "-m", "first");
  return { root, repo, git };
}

describe("host git reads", () => {
  it("counts changed and untracked paths in a worktree", async () => {
    const { repo } = await repository();
    await expect(readWorktreeStatus(repo, signal)).resolves.toEqual({
      status: "observed",
      changedPaths: 0,
    });
    await writeFile(join(repo, "a.txt"), "two\n");
    await writeFile(join(repo, "new.txt"), "new\n");
    await expect(readWorktreeStatus(repo, signal)).resolves.toEqual({
      status: "observed",
      changedPaths: 2,
    });
  });

  it("runs neither a repository's fsmonitor nor its clean filter while reading", async () => {
    const { root, repo, git } = await repository();
    const fsmonitorMarker = join(root, "fsmonitor-ran");
    await git("config", "core.fsmonitor", `touch ${fsmonitorMarker}; false`);
    await writeFile(join(repo, "a.txt"), "changed\n");
    await expect(readWorktreeStatus(repo, signal)).resolves.toMatchObject({ status: "observed" });
    expect(existsSync(fsmonitorMarker)).toBe(false);

    const filterMarker = join(root, "filter-ran");
    await git("config", "filter.evil.clean", `touch ${filterMarker}; cat`);
    await writeFile(join(repo, ".gitattributes"), "*.txt filter=evil\n");
    await expect(readWorktreeStatus(repo, signal)).resolves.toEqual({
      status: "runs-filters",
      filters: ["evil"],
    });
    expect(existsSync(filterMarker)).toBe(false);
  });

  it("counts only filters the repository's own config gives a command", () => {
    const list = [
      "system",
      "filter.lfs.clean\ngit-lfs clean -- %f",
      "global",
      "filter.mine.process\nmine",
      "local",
      "filter.evil.clean\ntouch x",
      "worktree",
      "filter.other.process\nrun",
      "local",
      "filter.empty.clean\n",
      "local",
      "core.bare\nfalse",
      "",
    ].join("\0");
    expect(repositoryFilterCommands(list)).toEqual(["evil", "other"]);
  });

  it("reads each worktree's branch, detached head, lock and prunable note", () => {
    const output = [
      "worktree /repo",
      "HEAD aaaa",
      "branch refs/heads/main",
      "",
      "worktree /wt/one",
      "HEAD bbbb",
      "detached",
      "locked",
      "",
      "worktree /wt/gone",
      "HEAD cccc",
      "branch refs/heads/fix/x",
      "prunable gitdir file points to non-existent location",
      "",
      "",
    ].join("\0");
    expect(parseWorktreeList(output)).toEqual([
      { path: "/repo", head: "aaaa", branch: "main", detached: false, bare: false },
      { path: "/wt/one", head: "bbbb", detached: true, bare: false, locked: "" },
      {
        path: "/wt/gone",
        head: "cccc",
        branch: "fix/x",
        detached: false,
        bare: false,
        prunable: "gitdir file points to non-existent location",
      },
    ]);
  });
});
