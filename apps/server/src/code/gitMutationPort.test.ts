import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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

function createRepository(root: string): string {
  const repository = join(root, "repository");
  mkdirSync(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.name", "Octant Test");
  git(repository, "config", "user.email", "test@octant.local");
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
