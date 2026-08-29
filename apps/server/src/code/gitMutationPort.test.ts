import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import type { SeatbeltConfinementPort } from "../process/seatbeltProfile";
import { GitMutationPort, type GitMutationDependencies } from "./gitMutationPort";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/** A checkout id shaped the way the host mints them: a UUID. */
const checkoutId = "1e4d8b52-0c37-4a91-9f26-8b3d5c7e0a14";

function confinedOptions() {
  const fake = createFakeSandboxConfinement();
  directories.push(fake.root);
  return {
    confinement: fake.confinement,
    temporaryDirectory: fake.temporaryDirectory,
    gitExecutable: "/usr/bin/git",
  };
}

describe("GitMutationPort", () => {
  it("stages only listed paths, commits the exact message, and pushes a confirmed refspec", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root);
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git(repository, "remote", "add", "origin", remote);
    writeFileSync(join(repository, "listed.txt"), "listed\n");
    writeFileSync(join(repository, "unlisted.txt"), "unlisted\n");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.stage({ checkoutRoot: repository, paths: ["listed.txt"] })).resolves.toEqual({
      status: "applied",
    });
    expect(gitOutput(repository, "diff", "--cached", "--name-only").trim()).toBe("listed.txt");
    await expect(
      port.commit({
        checkoutRoot: repository,
        message: "Exact message",
        stagedSummary: [{ path: "listed.txt", index: "A", worktree: " " }],
      }),
    ).resolves.toMatchObject({
      status: "applied",
      oid: expect.stringMatching(/^[a-f0-9]{40}$/),
    });
    expect(gitOutput(repository, "log", "-1", "--pretty=%B").trimEnd()).toBe("Exact message");
    await expect(
      port.push({
        checkoutRoot: repository,
        remote: "origin",
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        confirmation: {
          remote: "origin",
          refspec: "refs/heads/main:refs/heads/main",
        },
      }),
    ).resolves.toEqual({ status: "applied" });
    expect(
      execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
        encoding: "utf8",
      }).trim(),
    ).toMatch(/^[a-f0-9]{40}$/);
  });

  it("rejects an active index lock and broad, ambiguous, or force-shaped inputs before mutation", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root);
    writeFileSync(join(repository, ".git", "index.lock"), "locked");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.stage({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual({
      status: "rejected",
      reason: "index-locked",
    });
    unlinkSync(join(repository, ".git", "index.lock"));
    for (const paths of [[], ["."], ["../outside"], ["/absolute"], ["--all"]]) {
      await expect(port.stage({ checkoutRoot: repository, paths })).resolves.toMatchObject({
        status: "rejected",
      });
    }
    await expect(
      port.push({
        checkoutRoot: repository,
        remote: "origin",
        localRef: "refs/heads/main",
        remoteRef: "refs/heads/main",
        confirmation: {
          remote: "other",
          refspec: "refs/heads/main:refs/heads/main",
        },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "unconfirmed-target" });
    await expect(
      port.push({
        checkoutRoot: repository,
        remote: "origin",
        localRef: "+refs/heads/main",
        remoteRef: "refs/heads/main",
        confirmation: {
          remote: "origin",
          refspec: "+refs/heads/main:refs/heads/main",
        },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-refspec" });
  });

  it("runs ordinary Git commands through Seatbelt without ambient GitHub tokens or prompts", async () => {
    vi.stubEnv("GITHUB_TOKEN", "secret");
    vi.stubEnv("GH_TOKEN", "secret");
    const environments: NodeJS.ProcessEnv[] = [];
    const files: string[] = [];
    const execFile = vi.fn(
      async (file: string, _args: readonly string[], environment: NodeJS.ProcessEnv) => {
        files.push(file);
        environments.push(environment);
        return { exitCode: 0, stdout: "/repo/.git/index.lock\n", stderr: "" };
      },
    );
    const options = confinedOptions();
    const port = new GitMutationPort(
      {
        execFile,
        pathExists: async () => false,
        copyFile: async () => undefined,
        removeFile: async () => undefined,
      },
      options,
    );

    await port.stage({ checkoutRoot: "/repo", paths: ["file.txt"] });

    expect(files[0]).toContain("sandbox-exec");
    expect(environments).not.toHaveLength(0);
    for (const environment of environments) {
      expect(environment).toMatchObject({
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      });
      expect(environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(environment).not.toHaveProperty("GH_TOKEN");
    }
  });

  it("reverts only one explicit commit by creating a new commit", async () => {
    const root = temporaryDirectory();
    const repository = createRepository(root);
    writeFileSync(join(repository, "README.md"), "changed\n");
    git(repository, "add", "--", "README.md");
    git(repository, "commit", "-m", "change to revert");
    const target = gitOutput(repository, "rev-parse", "HEAD").trim();
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(
      port.revertCommit({ checkoutRoot: repository, oid: target }),
    ).resolves.toMatchObject({
      status: "applied",
      oid: expect.stringMatching(/^[a-f0-9]{40}$/),
    });

    expect(gitOutput(repository, "show", "HEAD:README.md")).toBe("initial\n");
    expect(gitOutput(repository, "rev-list", "--count", "HEAD").trim()).toBe("3");
  });

  it("restores listed paths from HEAD and leaves the rest of the checkout alone", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "kept.txt"), "kept\n");
    git(repository, "add", "--", "kept.txt");
    git(repository, "commit", "-m", "add kept");
    writeFileSync(join(repository, "README.md"), "edited\n");
    writeFileSync(join(repository, "kept.txt"), "edited too\n");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.discard({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual(
      { status: "applied" },
    );

    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("initial\n");
    // Everything the caller did not list keeps its uncommitted state.
    expect(readFileSync(join(repository, "kept.txt"), "utf8")).toBe("edited too\n");
  });

  it("drops a staged change for the listed path as well as the working-tree one", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "README.md"), "staged edit\n");
    git(repository, "add", "--", "README.md");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.discard({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual(
      { status: "applied" },
    );

    expect(gitOutput(repository, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("initial\n");
  });

  it("takes a path back out of the index while its edit survives in the working tree", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "README.md"), "staged edit\n");
    git(repository, "add", "--", "README.md");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.unstage({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual(
      { status: "applied" },
    );

    expect(gitOutput(repository, "diff", "--cached", "--name-only").trim()).toBe("");
    expect(gitOutput(repository, "status", "--porcelain").trimEnd()).toBe(" M README.md");
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("staged edit\n");
  });

  it("refuses to unstage when it cannot tell an unborn branch from a failed probe", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "README.md"), "staged edit\n");
    git(repository, "add", "--", "README.md");
    // A probe the command timeout aborted reports exactly as an unborn branch
    // does. Guessing wrong here does not merely unstage: against a repository
    // that has commits, dropping the path from the index leaves the file
    // deleted and untracked, so an indeterminate answer has to fail.
    const indeterminate: GitMutationDependencies = {
      execFile: async () => ({ exitCode: 128, stdout: "", stderr: "" }),
      pathExists: async () => false,
      copyFile: async () => undefined,
      removeFile: async () => undefined,
    };
    const port = new GitMutationPort(indeterminate, confinedOptions());

    await expect(port.unstage({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual(
      { status: "failed" },
    );

    expect(gitOutput(repository, "status", "--porcelain").trimEnd()).toBe("M  README.md");
  });

  it("takes a path back out of the index before the first commit exists", async () => {
    const repository = createEmptyRepository(temporaryDirectory());
    writeFileSync(join(repository, "README.md"), "first draft\n");
    git(repository, "add", "--", "README.md");
    // An edit after staging is what makes the unborn case awkward: the index
    // matches neither the file nor a HEAD that does not exist yet.
    writeFileSync(join(repository, "README.md"), "still drafting\n");
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.unstage({ checkoutRoot: repository, paths: ["README.md"] })).resolves.toEqual(
      { status: "applied" },
    );

    expect(gitOutput(repository, "status", "--porcelain").trimEnd()).toBe("?? README.md");
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("still drafting\n");
  });

  it("rejects a discard path shaped like a Git option", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());

    await expect(port.discard({ checkoutRoot: repository, paths: ["--hard"] })).resolves.toEqual({
      status: "rejected",
      reason: "invalid-paths",
    });
  });

  it("checkpoints the working tree and puts every kind of change back on restore", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "doomed.txt"), "doomed\n");
    git(repository, "add", "--", "doomed.txt");
    git(repository, "commit", "-m", "add doomed");
    writeFileSync(join(repository, "README.md"), "checkpointed\n");
    writeFileSync(join(repository, "untracked.txt"), "untracked\n");
    writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repository, "ignored.txt"), "ignored\n");
    git(repository, "add", "--", "README.md");
    const port = new GitMutationPort(undefined, confinedOptions());

    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    expect(captured).toMatchObject({ status: "captured" });
    if (captured.status !== "captured") return;
    // Taking a checkpoint must leave the checkout exactly as the user had it,
    // staged set included.
    expect(gitOutput(repository, "status", "--porcelain").trim().split("\n")).toEqual([
      "M  README.md",
      "?? .gitignore",
      "?? untracked.txt",
    ]);

    // Every way an agent can change a checkout, then a restore.
    writeFileSync(join(repository, "README.md"), "clobbered\n");
    writeFileSync(join(repository, "untracked.txt"), "clobbered\n");
    writeFileSync(join(repository, "added.txt"), "added after\n");
    writeFileSync(join(repository, "ignored.txt"), "still mine\n");
    rmSync(join(repository, "doomed.txt"));

    await expect(
      port.restoreWorkingTree({ checkoutRoot: repository, snapshot: captured.snapshot }),
    ).resolves.toEqual({ status: "applied" });

    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("checkpointed\n");
    expect(readFileSync(join(repository, "untracked.txt"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(repository, "doomed.txt"), "utf8")).toBe("doomed\n");
    expect(existsSync(join(repository, "added.txt"))).toBe(false);
    // An ignored file is in no checkpoint, so a restore never touches it.
    expect(readFileSync(join(repository, "ignored.txt"), "utf8")).toBe("still mine\n");
    // The staged/unstaged split comes back too, not a flattened approximation.
    expect(gitOutput(repository, "status", "--porcelain").trim().split("\n")).toEqual([
      "M  README.md",
      "?? .gitignore",
      "?? untracked.txt",
    ]);
  });

  it("leaves the checkout untouched when a snapshot tree cannot be read", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());
    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    expect(captured).toMatchObject({ status: "captured" });
    if (captured.status !== "captured") return;
    writeFileSync(join(repository, "README.md"), "edited after the checkpoint\n");

    await expect(
      port.restoreWorkingTree({
        checkoutRoot: repository,
        // Well-formed but absent, which is what a pruned or foreign snapshot
        // looks like by the time a restore is attempted.
        snapshot: { ...captured.snapshot, index: "a".repeat(40) },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-commit" });

    // A refused restore must not have already overwritten the working tree.
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe(
      "edited after the checkpoint\n",
    );
  });

  it("refuses a restore that would overwrite a file the checkout now ignores", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());
    writeFileSync(join(repository, "secrets.env"), "checkpointed\n");
    git(repository, "add", "--", "secrets.env");
    git(repository, "commit", "-m", "secrets");
    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    expect(captured).toMatchObject({ status: "captured" });
    if (captured.status !== "captured") return;

    // The ordinary life of a checked-in secret: taken out of Git, ignored, and
    // rewritten locally. It is now in the snapshot and ignored at the same time.
    git(repository, "rm", "--cached", "--", "secrets.env");
    writeFileSync(join(repository, ".gitignore"), "secrets.env\n");
    git(repository, "add", "--", ".gitignore");
    git(repository, "commit", "-m", "ignore secrets");
    writeFileSync(join(repository, "secrets.env"), "the only copy\n");

    await expect(
      port.restoreWorkingTree({ checkoutRoot: repository, snapshot: captured.snapshot }),
    ).resolves.toEqual({ status: "rejected", reason: "ignored-path-collision" });

    // The undo point a restore hands back is built with `git add -A`, which
    // skips ignored files, so overwriting this would have been irreversible.
    expect(readFileSync(join(repository, "secrets.env"), "utf8")).toBe("the only copy\n");
  });

  it("restores over an ignored path the snapshot carries when nothing is there to lose", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());
    writeFileSync(join(repository, "secrets.env"), "checkpointed\n");
    git(repository, "add", "--", "secrets.env");
    git(repository, "commit", "-m", "secrets");
    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    expect(captured).toMatchObject({ status: "captured" });
    if (captured.status !== "captured") return;

    git(repository, "rm", "--", "secrets.env");
    writeFileSync(join(repository, ".gitignore"), "secrets.env\n");
    git(repository, "add", "--", ".gitignore");
    git(repository, "commit", "-m", "ignore secrets");

    await expect(
      port.restoreWorkingTree({ checkoutRoot: repository, snapshot: captured.snapshot }),
    ).resolves.toEqual({ status: "applied" });

    expect(readFileSync(join(repository, "secrets.env"), "utf8")).toBe("checkpointed\n");
  });

  it("keeps a checkpoint restorable across a pruning garbage collection", async () => {
    const repository = createRepository(temporaryDirectory());
    writeFileSync(join(repository, "README.md"), "checkpointed\n");
    writeFileSync(join(repository, "untracked.txt"), "untracked\n");
    const port = new GitMutationPort(undefined, confinedOptions());

    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    expect(captured).toMatchObject({ status: "captured" });
    if (captured.status !== "captured") return;
    expect(checkpointRefs(repository, checkoutId)).toEqual([
      `refs/octant/checkpoints/${checkoutId}/${captured.anchorId}/index`,
      `refs/octant/checkpoints/${checkoutId}/${captured.anchorId}/worktree`,
    ]);

    // Move the checkout on so nothing but the anchors can reach the recorded
    // trees, then run the collection that used to eat them.
    git(repository, "checkout", "--", "README.md");
    rmSync(join(repository, "untracked.txt"));
    git(repository, "gc", "--prune=now");

    // Restoring a checkpoint from before the collection is the whole point.
    await expect(
      port.restoreWorkingTree({ checkoutRoot: repository, snapshot: captured.snapshot }),
    ).resolves.toEqual({ status: "applied" });
    expect(readFileSync(join(repository, "README.md"), "utf8")).toBe("checkpointed\n");
    expect(readFileSync(join(repository, "untracked.txt"), "utf8")).toBe("untracked\n");
  });

  it("releases only the capture it is asked to release, and scopes anchors to one checkout", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());
    const sibling = "9c2f7a10-4d3b-4f61-8e05-1a7b6c3d2e94";

    // Two captures of an unchanged checkout record the identical trees. Each
    // still has to own its anchors, or releasing one strips the other.
    const first = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    const second = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId });
    const other = await port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId: sibling });
    expect(first).toMatchObject({ status: "captured" });
    expect(second).toMatchObject({ status: "captured" });
    expect(other).toMatchObject({ status: "captured" });
    if (first.status !== "captured" || second.status !== "captured") return;
    expect(second.snapshot).toEqual(first.snapshot);

    await port.releaseCheckpoint({
      checkoutRoot: repository,
      checkoutId,
      anchorId: second.anchorId,
    });

    expect(checkpointRefs(repository, checkoutId)).toEqual([
      `refs/octant/checkpoints/${checkoutId}/${first.anchorId}/index`,
      `refs/octant/checkpoints/${checkoutId}/${first.anchorId}/worktree`,
    ]);
    // A checkout sharing this object database keeps its own anchors.
    expect(checkpointRefs(repository, sibling)).toHaveLength(2);
    // The released capture's trees are still reachable through the anchors the
    // first capture kept, so the surviving checkpoint still restores.
    git(repository, "gc", "--prune=now");
    await expect(
      port.restoreWorkingTree({ checkoutRoot: repository, snapshot: first.snapshot }),
    ).resolves.toEqual({ status: "applied" });
  });

  it("refuses to capture against a checkout id it cannot name a ref from", async () => {
    const repository = createRepository(temporaryDirectory());
    const port = new GitMutationPort(undefined, confinedOptions());

    // A snapshot with nowhere to anchor would be collected out from under the
    // turn that advertised it, so no snapshot is better than that one.
    await expect(
      port.snapshotWorkingTree({ checkoutRoot: repository, checkoutId: "../../refs/heads/main" }),
    ).resolves.toEqual({ status: "failed" });
    expect(gitOutput(repository, "for-each-ref", "--format=%(refname)", "refs/octant").trim()).toBe(
      "",
    );
  });

  it("does not give Plan git mutations bound-root writes or process execution", async () => {
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const fake = createFakeSandboxConfinement();
    directories.push(fake.root);
    const port = new GitMutationPort(undefined, {
      confinement: {
        prepare: (input) => {
          captured = input;
          return fake.confinement.prepare(input);
        },
      },
      temporaryDirectory: fake.temporaryDirectory,
      gitExecutable: "/usr/bin/git",
      executionPolicy: "plan",
    });

    await port.stage({ checkoutRoot: temporaryDirectory(), paths: ["README.md"] });
    expect(captured?.writeBoundRoot).toBe(false);
    expect(captured?.allowProcessExec).toBe(false);
    expect(captured?.allowProcessFork).toBe(false);
  });

  it("fails closed when Seatbelt confinement is unavailable", async () => {
    const port = new GitMutationPort(undefined, {
      platform: "linux",
      gitExecutable: "/usr/bin/git",
      temporaryDirectory: temporaryDirectory(),
    });
    await expect(
      port.stage({ checkoutRoot: temporaryDirectory(), paths: ["README.md"] }),
    ).resolves.toEqual({ status: "failed" });
  });
});

function createEmptyRepository(root: string): string {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Octant Test");
  git(repository, "config", "user.email", "test@octant.local");
  return repository;
}

function createRepository(root: string): string {
  const repository = createEmptyRepository(root);
  writeFileSync(join(repository, "README.md"), "initial\n");
  git(repository, "add", "--", "README.md");
  git(repository, "commit", "-m", "initial");
  return repository;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-git-mutation-"));
  directories.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function checkpointRefs(root: string, id: string): string[] {
  return gitOutput(root, "for-each-ref", "--format=%(refname)", `refs/octant/checkpoints/${id}`)
    .split("\n")
    .filter((name) => name.length > 0);
}

function gitOutput(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
