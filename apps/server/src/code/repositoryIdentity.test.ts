import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  observeRepositoryIdentity,
  parseWorktreePorcelain,
  type RepositoryIdentityDependencies,
} from "./repositoryIdentity";

const execFileAsync = promisify(execFile);
const temporaryRepositories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTemporaryGitRepository() {
  const root = await mkdtemp(join(tmpdir(), "octant-code-identity-"));
  temporaryRepositories.push(root);
  const main = join(root, "main");
  const linked = join(root, "linked");
  const environment = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
  };
  const execute = async (args: readonly string[]) =>
    execFileAsync("git", args, { encoding: "utf8", env: environment, shell: false });
  await execute(["init", "-b", "development", main]);
  await execute([
    "-C",
    main,
    "-c",
    "user.name=Octant Test",
    "-c",
    "user.email=test@octant.local",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  return {
    main,
    linked,
    git: (args: readonly string[]) => execute(["-C", main, ...args]),
    dependencies: {
      isMissingError: (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT",
      realpath,
      statIdentity: async (path: string) => {
        const value = await lstat(path, { bigint: true });
        return { device: value.dev.toString(10), inode: value.ino.toString(10) };
      },
      runGit: async (args: readonly string[]) => {
        const result = await execute(args);
        return { exitCode: 0, stdout: result.stdout };
      },
    } satisfies RepositoryIdentityDependencies,
  };
}

describe("parseWorktreePorcelain", () => {
  it("preserves ordinary, detached, locked, and prunable records without assuming order", () => {
    expect(
      parseWorktreePorcelain(
        "worktree /repo/linked\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/topic\0locked editor active\0\0" +
          "worktree /repo/stale\0HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0detached\0prunable gitdir file points to non-existent location\0\0" +
          "worktree /repo/main\0HEAD cccccccccccccccccccccccccccccccccccccccc\0branch refs/heads/development\0\0",
      ),
    ).toEqual([
      {
        reportedPath: "/repo/linked",
        head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "refs/heads/topic",
        detached: false,
        locked: "editor active",
      },
      {
        reportedPath: "/repo/stale",
        head: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        detached: true,
        prunable: "gitdir file points to non-existent location",
      },
      {
        reportedPath: "/repo/main",
        head: "cccccccccccccccccccccccccccccccccccccccc",
        branch: "refs/heads/development",
        detached: false,
      },
    ]);
  });

  it("omits fields that Git did not report", () => {
    const [worktree] = parseWorktreePorcelain(
      "worktree /repo/main\0HEAD cccccccccccccccccccccccccccccccccccccccc\0branch refs/heads/development\0\0",
    );

    expect(worktree).not.toHaveProperty("locked");
    expect(worktree).not.toHaveProperty("prunable");
  });

  it.each([
    "",
    "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0\0",
    "worktree /repo\0HEAD invalid\0branch refs/heads/main\0\0",
    `worktree /repo\0HEAD ${"a".repeat(41)}\0branch refs/heads/main\0\0`,
    `worktree /repo\0HEAD ${"a".repeat(63)}\0branch refs/heads/main\0\0`,
    "worktree /repo\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0\0",
    "worktree /repo\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/main\0detached\0\0",
    "worktree /repo\0worktree /other\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/main\0\0",
    "worktree /repo\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0branch refs/heads/main\0\0",
  ])("rejects malformed or duplicate-field porcelain %j", (value) => {
    expect(() => parseWorktreePorcelain(value)).toThrow("invalid Git worktree inventory");
  });
});

class MissingFixturePath extends Error {}

const signal = new AbortController().signal;
const head = "a".repeat(40);

function makeDependencies(options: {
  readonly root: string;
  readonly canonicalRoot?: string;
  readonly commonDirectory?: string;
  readonly bare?: boolean;
  readonly worktreeOutput?: string;
  readonly missing?: readonly string[];
  readonly realpathFailure?: string;
  readonly notRepository?: boolean;
  readonly failCommand?: string;
}) {
  const canonicalRoot = options.canonicalRoot ?? options.root;
  const commonDirectory = options.commonDirectory ?? "/identity/common";
  const objectDirectory = "/identity/objects";
  const missing = new Set(options.missing ?? []);
  const output =
    options.worktreeOutput ??
    `worktree ${canonicalRoot}\0HEAD ${head}\0branch refs/heads/development\0\0`;
  return {
    isMissingError: (error: unknown) => error instanceof MissingFixturePath,
    realpath: async (path: string) => {
      if (missing.has(path)) throw new MissingFixturePath();
      if (path === options.realpathFailure) throw new Error("operational realpath failure");
      if (path === options.root) return canonicalRoot;
      return path;
    },
    statIdentity: async (path: string) => {
      if (path === commonDirectory) return { device: "10", inode: "20" };
      if (path === objectDirectory) return { device: "10", inode: "21" };
      throw new Error("unexpected identity path");
    },
    runGit: async (args: readonly string[]) => {
      const command = args.slice(2).join(" ");
      if (command === options.failCommand) throw new Error("operational fixture failure");
      if (command === "rev-parse --is-bare-repository") {
        return options.notRepository
          ? { exitCode: 128, stdout: "" }
          : { exitCode: 0, stdout: options.bare ? "true\n" : "false\n" };
      }
      if (command === "rev-parse --path-format=absolute --git-common-dir") {
        return { exitCode: 0, stdout: `${commonDirectory}\n` };
      }
      if (command === "rev-parse --path-format=absolute --git-path objects") {
        return { exitCode: 0, stdout: `${objectDirectory}\n` };
      }
      if (command === "worktree list --porcelain -z") return { exitCode: 0, stdout: output };
      throw new Error(`unexpected Git fixture command ${command}`);
    },
  } satisfies RepositoryIdentityDependencies;
}

const availableDependencies = makeDependencies({
  root: "/moved/repo",
  worktreeOutput:
    `worktree /moved/repo\0HEAD ${head}\0branch refs/heads/development\0locked editor active\0\0` +
    `worktree /old/stale\0HEAD ${head}\0detached\0prunable missing gitdir\0\0`,
  missing: ["/old/stale"],
});
const bareDependencies = makeDependencies({ root: "/repo", bare: true });
const submoduleDependencies = makeDependencies({
  root: "/repo",
  commonDirectory: "/parent/.git/modules/repo",
});
const missingSelectedDependencies = makeDependencies({
  root: "/repo",
  worktreeOutput: `worktree /other\0HEAD ${head}\0branch refs/heads/development\0\0`,
});
const failedGitDependencies = makeDependencies({
  root: "/repo",
  failCommand: "worktree list --porcelain -z",
});
const missingNonPrunableDependencies = makeDependencies({
  root: "/repo",
  worktreeOutput:
    `worktree /repo\0HEAD ${head}\0branch refs/heads/development\0\0` +
    `worktree /missing\0HEAD ${head}\0detached\0\0`,
  missing: ["/missing"],
});
const prunableOperationalDependencies = makeDependencies({
  root: "/repo",
  worktreeOutput:
    `worktree /repo\0HEAD ${head}\0branch refs/heads/development\0\0` +
    `worktree /stale\0HEAD ${head}\0detached\0prunable missing gitdir\0\0`,
  realpathFailure: "/stale",
});
const missingRootDependencies = makeDependencies({
  root: "/missing-root",
  missing: ["/missing-root"],
});
const notRepositoryDependencies = makeDependencies({ root: "/folder", notRepository: true });
const beforeMoveDependencies = makeDependencies({ root: "/old/repo" });
const afterMoveDependencies = makeDependencies({ root: "/moved/repo" });

describe("observeRepositoryIdentity", () => {
  it("observes the selected checkout while preserving missing prunable entries", async () => {
    expect(
      await observeRepositoryIdentity("/moved/repo", availableDependencies, signal),
    ).toMatchObject({
      status: "available",
      repositoryId: expect.stringMatching(/^repo_[a-f0-9]{64}$/),
      repositoryRoot: "/moved/repo",
      checkout: { status: "present", canonicalPath: "/moved/repo" },
      worktrees: [
        { status: "present", canonicalPath: "/moved/repo" },
        { status: "missing-prunable", reportedPath: "/old/stale" },
      ],
    });
  });

  it("distinguishes ineligible, unavailable, and operational failure states", async () => {
    expect(await observeRepositoryIdentity("/repo", bareDependencies, signal)).toEqual({
      status: "ineligible",
      reason: "bare",
    });
    expect(await observeRepositoryIdentity("/repo", submoduleDependencies, signal)).toEqual({
      status: "ineligible",
      reason: "submodule",
    });
    expect(await observeRepositoryIdentity("/repo", missingSelectedDependencies, signal)).toEqual({
      status: "ineligible",
      reason: "not-worktree",
    });
    expect(
      await observeRepositoryIdentity("/missing-root", missingRootDependencies, signal),
    ).toEqual({
      status: "unavailable",
      reason: "root-missing-or-moved",
    });
    expect(await observeRepositoryIdentity("/folder", notRepositoryDependencies, signal)).toEqual({
      status: "unavailable",
      reason: "not-repository",
    });
    for (const dependencies of [
      failedGitDependencies,
      missingNonPrunableDependencies,
      prunableOperationalDependencies,
    ]) {
      expect(await observeRepositoryIdentity("/repo", dependencies, signal)).toEqual({
        status: "failed",
      });
    }
  });

  it("keeps repository identity stable across an ordinary same-volume move", async () => {
    const beforeMove = await observeRepositoryIdentity("/old/repo", beforeMoveDependencies, signal);
    const afterMove = await observeRepositoryIdentity("/moved/repo", afterMoveDependencies, signal);
    expect(beforeMove.status).toBe("available");
    expect(afterMove.status).toBe("available");
    if (beforeMove.status !== "available" || afterMove.status !== "available") {
      throw new Error("expected available fixtures");
    }
    expect(afterMove.repositoryId).toBe(beforeMove.repositoryId);
  });

  it("shares repository identity across real main and linked worktrees", async () => {
    const fixture = await createTemporaryGitRepository();
    await fixture.git(["worktree", "add", "-b", "feature/linked", fixture.linked, "HEAD"]);
    const main = await observeRepositoryIdentity(fixture.main, fixture.dependencies, signal);
    const linked = await observeRepositoryIdentity(fixture.linked, fixture.dependencies, signal);
    expect(main.status).toBe("available");
    expect(linked.status).toBe("available");
    if (main.status !== "available" || linked.status !== "available") {
      throw new Error("fixture unavailable");
    }
    expect(linked.repositoryId).toBe(main.repositoryId);
    expect(linked.checkout.canonicalPath).toBe(await realpath(fixture.linked));
    expect(linked.worktrees).toHaveLength(2);
  });
});
