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
import { GitMutationPort } from "./gitMutationPort";

const directories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

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

    const captured = await port.snapshotWorkingTree({ checkoutRoot: repository });
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

function gitOutput(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
