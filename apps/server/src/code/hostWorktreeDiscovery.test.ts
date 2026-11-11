import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { scanHostWorktrees } from "./hostWorktreeDiscovery";

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

async function repository(path: string) {
  await git("init", "-q", "-b", "main", path);
  await writeFile(join(path, "a.txt"), "one\n");
  await git("-C", path, "add", "a.txt");
  await git("-C", path, "commit", "-q", "-m", "first");
}

describe("host worktree discovery", () => {
  it("finds every repository's worktrees from the home folder and the Projects, whoever made them", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-host-scan-")));
    directories.push(root);
    const home = join(root, "home");
    await mkdir(home);

    // A repository with an agent's worktree in a hidden folder, one whose
    // folder is gone, and one Octant made.
    const app = join(home, "code", "app");
    await repository(app);
    const agentWorktree = join(home, ".agent", "worktrees", "fix-sidebar");
    await git("-C", app, "worktree", "add", "-q", "-b", "fix/sidebar", agentWorktree);
    await git("-C", agentWorktree, "commit", "-q", "--allow-empty", "-m", "work");
    const goneWorktree = join(home, ".agent", "worktrees", "gone");
    await git("-C", app, "worktree", "add", "-q", "-b", "gone", goneWorktree);
    await rm(goneWorktree, { recursive: true, force: true });
    const owned = join(home, "code", ".octant-worktrees", "r", "t");
    await git("-C", app, "worktree", "add", "-q", "-b", "octant/t", owned);

    // A clone with no worktree, and a repository inside node_modules: neither listed.
    await repository(join(home, "code", "plain"));
    const vendored = join(home, "code", "web", "node_modules", "pkg");
    await repository(vendored);
    await git(
      "-C",
      vendored,
      "worktree",
      "add",
      "-q",
      "-b",
      "x",
      join(home, "code", "web", "node_modules", "vendored-wt"),
    );

    // A Project's repository outside the home folder, with its worktree outside too.
    const project = join(root, "elsewhere", "project");
    await repository(project);
    await git("-C", project, "worktree", "add", "-q", "-b", "p", join(root, "elsewhere", "p-wt"));

    const scan = await scanHostWorktrees(
      {
        homeDirectory: home,
        platform: "linux",
        projectFolders: () => [project],
        ownedWorktreePaths: async () => new Set([owned]),
        now: Date.now,
      },
      signal,
    );

    expect(scan.complete).toBe(true);
    expect(scan.repositories.map((repo) => repo.path).sort()).toEqual([app, project].sort());
    const appWorktrees = scan.repositories.find((repo) => repo.path === app)?.worktrees ?? [];
    expect(appWorktrees.find((wt) => wt.path === agentWorktree)).toMatchObject({
      branch: "fix/sidebar",
      missing: false,
      delivered: false,
      ownedByOctant: false,
    });
    expect(appWorktrees.find((wt) => wt.path === goneWorktree)).toMatchObject({
      missing: true,
      // Its commit is main's, so nothing would be lost.
      delivered: true,
    });
    expect(appWorktrees.find((wt) => wt.path === owned)?.ownedByOctant).toBe(true);
    expect(appWorktrees.find((wt) => wt.path === agentWorktree)?.lastActivityMs).toBeGreaterThan(0);
  });

  it("says the scan is partial when it stops at its bound", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-host-scan-")));
    directories.push(root);
    for (const name of ["a", "b", "c"])
      await mkdir(join(root, name, "deeper"), { recursive: true });
    const scan = await scanHostWorktrees(
      {
        homeDirectory: root,
        platform: "linux",
        projectFolders: () => [],
        ownedWorktreePaths: async () => new Set(),
        now: Date.now,
        limits: { maxEntries: 2 },
      },
      signal,
    );
    expect(scan.complete).toBe(false);
  });
});
