import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeSandboxConfinement } from "./process/fakeSandboxConfinement";
import { createGitCommandEnvironment, GitEnvironmentPort } from "./gitEnvironmentPort";

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
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("GitEnvironmentPort", () => {
  it("creates a prompt-disabled allowlisted environment for every Git port", () => {
    expect(
      createGitCommandEnvironment({
        PATH: "/usr/bin",
        HOME: "/home/test",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "gh-secret",
        GITHUB_ENTERPRISE_TOKEN: "enterprise-secret",
        GH_ENTERPRISE_TOKEN: "gh-enterprise-secret",
        GIT_ASKPASS: "/tmp/askpass",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("observes primary and linked worktrees, named and detached branches, and changes", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repository");
    const linkedWorktree = join(root, "linked-worktree");
    mkdirSync(repository);
    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.name", "Octant Test");
    git(repository, "config", "user.email", "test@octant.local");
    writeFileSync(join(repository, "README.md"), "test");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "initial");
    git(repository, "worktree", "add", "-b", "feature/linked", linkedWorktree);
    const port = new GitEnvironmentPort(undefined, confinedOptions());

    expect(await port.observe(realpathSync(repository))).toMatchObject({
      status: "ready",
      repositoryRoot: realpathSync(repository),
      worktreeRoot: realpathSync(repository),
      branch: { kind: "named", name: "main" },
      changes: "clean",
    });

    expect(await port.observe(realpathSync(linkedWorktree))).toMatchObject({
      status: "ready",
      repositoryRoot: realpathSync(repository),
      worktreeRoot: realpathSync(linkedWorktree),
      branch: { kind: "named", name: "feature/linked" },
    });

    git(linkedWorktree, "checkout", "--detach", "HEAD");
    expect(await port.observe(realpathSync(linkedWorktree))).toMatchObject({
      status: "ready",
      branch: {
        kind: "detached",
        oid: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
    });

    writeFileSync(join(linkedWorktree, "dirty.txt"), "dirty");
    expect(await port.observe(realpathSync(linkedWorktree))).toMatchObject({
      changes: "dirty",
    });
  });

  it("observes independent worktree, branch, and status facts concurrently", async () => {
    let active = 0;
    let peak = 0;
    const execFile = vi.fn(async (_file: string, args: readonly string[]) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      if (args.includes("--show-toplevel")) return { exitCode: 0, stdout: "/repo\n" };
      if (args.includes("worktree")) {
        return { exitCode: 0, stdout: "worktree /repo\n" };
      }
      if (args.includes("symbolic-ref")) return { exitCode: 0, stdout: "main\n" };
      return { exitCode: 0, stdout: "" };
    });
    const port = new GitEnvironmentPort(
      {
        realpath: async (path) => path,
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    await expect(port.observe("/repo")).resolves.toMatchObject({ status: "ready" });
    expect(peak).toBe(3);
  });

  it("returns unavailable for missing, non-directory, and non-Git roots", async () => {
    const root = temporaryDirectory();
    const file = join(root, "file");
    const nonGitDirectory = join(root, "not-a-repository");
    writeFileSync(file, "not a directory");
    mkdirSync(nonGitDirectory);
    const port = new GitEnvironmentPort(undefined, confinedOptions());

    expect(await port.observe(join(root, "missing"))).toEqual({
      status: "unavailable",
    });
    expect(await port.observe(file)).toEqual({ status: "unavailable" });
    expect(await port.observe(nonGitDirectory)).toEqual({
      status: "unavailable",
    });

    const execFile = vi.fn(async () => ({ exitCode: 0, stdout: "/file\n" }));
    const nonDirectoryPort = new GitEnvironmentPort(
      {
        realpath: async () => "/file",
        stat: async () => ({ isDirectory: () => false }),
        execFile,
      },
      confinedOptions(),
    );
    expect(await nonDirectoryPort.observe("/file")).toEqual({
      status: "unavailable",
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns a closed failure and gives Git only a non-interactive allowlisted environment", async () => {
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_URL", "http://127.0.0.1:41000/");
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_TOKEN", "broker-secret");
    vi.stubEnv("OCTANT_DESKTOP_BRIDGE_SECRET", "desktop-secret");
    vi.stubEnv("GITHUB_TOKEN", "github-secret");
    vi.stubEnv("GH_TOKEN", "gh-secret");
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "cloud-secret");
    vi.stubEnv("AZURE_CLIENT_SECRET", "azure-secret");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "/private/cloud.json");
    vi.stubEnv("OCTANT_TEST_ALLOWED_ENV", "must-not-be-inherited");
    const environments: NodeJS.ProcessEnv[] = [];
    const execFile = vi.fn(
      async (_file: string, _args: readonly string[], environment: NodeJS.ProcessEnv) => {
        environments.push(environment);
        if (environments.length === 1) return { exitCode: 0, stdout: "/canonical\n" };
        throw new Error("private process failure");
      },
    );
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    expect(await port.observe("/candidate")).toEqual({ status: "failed" });
    expect(execFile).toHaveBeenCalledTimes(4);
    for (const environment of environments) {
      expect(environment).toMatchObject({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      });
      for (const secret of [
        "OCTANT_CREDENTIAL_BROKER_URL",
        "OCTANT_CREDENTIAL_BROKER_TOKEN",
        "OCTANT_DESKTOP_BRIDGE_SECRET",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "OPENAI_API_KEY",
        "AWS_ACCESS_KEY_ID",
        "AZURE_CLIENT_SECRET",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "OCTANT_TEST_ALLOWED_ENV",
      ])
        expect(environment).not.toHaveProperty(secret);
    }
    expect(process.env.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("broker-secret");
  });

  it.each([
    ["non-hex", "g".repeat(40)],
    ["uppercase", "A".repeat(40)],
    ["wrong-length", "a".repeat(39)],
  ])("normalizes a malformed %s detached identity to failed", async (_case, identity) => {
    const results = [
      { exitCode: 0, stdout: "/canonical\n" },
      { exitCode: 0, stdout: "worktree /canonical\n" },
      { exitCode: 1, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: `${identity}\n` },
    ];
    const execFile = vi.fn(async () => results.shift()!);
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    expect(await port.observe("/canonical")).toEqual({ status: "failed" });
  });

  it("fails closed when symbolic-ref fails for a reason other than detached HEAD", async () => {
    const results = [
      { exitCode: 0, stdout: "/canonical\n" },
      { exitCode: 0, stdout: "worktree /canonical\n" },
      { exitCode: 128, stdout: "" },
      { exitCode: 0, stdout: "" },
    ];
    const execFile = vi.fn(async () => results.shift()!);
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    expect(await port.observe("/canonical")).toEqual({ status: "failed" });
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it("ignores an unrelated stale worktree while preserving primary and active identities", async () => {
    const results = [
      { exitCode: 0, stdout: "/active\n" },
      {
        exitCode: 0,
        stdout:
          "worktree /primary\n\nworktree /stale\nprunable stale metadata\n\nworktree /active\n",
      },
      { exitCode: 0, stdout: "feature/active\n" },
      { exitCode: 0, stdout: "" },
    ];
    const execFile = vi.fn(async () => results.shift()!);
    const port = new GitEnvironmentPort(
      {
        realpath: async (path) => {
          if (path === "/stale") throw new Error("missing worktree");
          return path;
        },
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    await expect(port.observe("/active")).resolves.toMatchObject({
      status: "ready",
      repositoryRoot: "/primary",
      worktreeRoot: "/active",
      branch: { kind: "named", name: "feature/active" },
    });
  });

  it("fails closed when an inaccessible unrelated worktree is not marked prunable", async () => {
    const results = [
      { exitCode: 0, stdout: "/active\n" },
      {
        exitCode: 0,
        stdout:
          "worktree /primary\n\nworktree /missing\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\nworktree /active\n",
      },
      { exitCode: 0, stdout: "feature/active\n" },
      { exitCode: 0, stdout: "" },
    ];
    const port = new GitEnvironmentPort(
      {
        realpath: async (path) => {
          if (path === "/missing") throw new Error("missing worktree");
          return path;
        },
        stat: async () => ({ isDirectory: () => true }),
        execFile: vi.fn(async () => results.shift()!),
      },
      confinedOptions(),
    );

    await expect(port.observe("/active")).resolves.toEqual({
      status: "failed",
    });
  });

  it("fails closed when worktree porcelain contains a malformed stanza", async () => {
    const results = [
      { exitCode: 0, stdout: "/active\n" },
      {
        exitCode: 0,
        stdout:
          "worktree /primary\n\nHEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbranch refs/heads/ghost\n\nworktree /active\n",
      },
      { exitCode: 0, stdout: "feature/active\n" },
      { exitCode: 0, stdout: "" },
    ];
    const port = new GitEnvironmentPort(
      {
        realpath: async (path) => path,
        stat: async () => ({ isDirectory: () => true }),
        execFile: vi.fn(async () => results.shift()!),
      },
      confinedOptions(),
    );

    await expect(port.observe("/active")).resolves.toEqual({
      status: "failed",
    });
  });

  it("propagates caller cancellation to an active Git command", async () => {
    const commandStarted = deferred<void>();
    let commandSignal: AbortSignal | undefined;
    const execFile = vi.fn(
      async (
        _file: string,
        _args: readonly string[],
        _environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => {
        commandSignal = signal;
        commandStarted.resolve();
        await aborted(signal);
        return { exitCode: 1, stdout: "" };
      },
    );
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );
    const controller = new AbortController();

    const observation = port.observe("/canonical", controller.signal);
    await commandStarted.promise;
    controller.abort();

    await expect(observation).resolves.toEqual({ status: "unavailable" });
    expect(commandSignal?.aborted).toBe(true);
  });

  it("aborts a Git command that exceeds the observation timeout", async () => {
    vi.useFakeTimers();
    try {
      let commandSignal: AbortSignal | undefined;
      const execFile = vi.fn(
        async (
          _file: string,
          _args: readonly string[],
          _environment: NodeJS.ProcessEnv,
          signal: AbortSignal,
        ) => {
          commandSignal = signal;
          await aborted(signal);
          return { exitCode: 1, stdout: "" };
        },
      );
      const port = new GitEnvironmentPort(
        {
          realpath: async () => "/canonical",
          stat: async () => ({ isDirectory: () => true }),
          execFile,
        },
        { commandTimeoutMs: 25, ...confinedOptions() },
      );

      const observation = port.observe("/canonical");
      await vi.advanceTimersByTimeAsync(25);

      await expect(observation).resolves.toEqual({ status: "unavailable" });
      expect(commandSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts active Git observation when the port is released", async () => {
    const commandStarted = deferred<void>();
    let commandSignal: AbortSignal | undefined;
    const execFile = vi.fn(
      async (
        _file: string,
        _args: readonly string[],
        _environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) => {
        commandSignal = signal;
        commandStarted.resolve();
        await aborted(signal);
        return { exitCode: 1, stdout: "" };
      },
    );
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    const observation = port.observe("/canonical");
    await commandStarted.promise;
    await port.close();

    expect(commandSignal?.aborted).toBe(true);
    await expect(observation).resolves.toEqual({ status: "unavailable" });
    await expect(port.observe("/canonical")).resolves.toEqual({
      status: "failed",
    });
  });

  it("waits for an aborted Git command to settle before observation and release complete", async () => {
    const commandStarted = deferred<void>();
    const abortObserved = deferred<void>();
    let settleCommand!: () => void;
    const execFile = vi.fn(
      (
        _file: string,
        _args: readonly string[],
        _environment: NodeJS.ProcessEnv,
        signal: AbortSignal,
      ) =>
        new Promise<{ exitCode: number; stdout: string }>((resolve) => {
          settleCommand = () => resolve({ exitCode: 0, stdout: "/canonical\n" });
          signal.addEventListener("abort", () => abortObserved.resolve(), {
            once: true,
          });
          commandStarted.resolve();
        }),
    );
    const port = new GitEnvironmentPort(
      {
        realpath: async () => "/canonical",
        stat: async () => ({ isDirectory: () => true }),
        execFile,
      },
      confinedOptions(),
    );

    let observationSettled = false;
    const observation = port.observe("/canonical").finally(() => {
      observationSettled = true;
    });
    await commandStarted.promise;
    let closeSettled = false;
    const close = port.close().finally(() => {
      closeSettled = true;
    });
    await abortObserved.promise;
    await Promise.resolve();

    expect(observationSettled).toBe(false);
    expect(closeSettled).toBe(false);

    settleCommand();
    await expect(observation).resolves.toEqual({ status: "unavailable" });
    await close;
    expect(observationSettled).toBe(true);
    expect(closeSettled).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-git-environment-"));
  directories.push(directory);
  return directory;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
