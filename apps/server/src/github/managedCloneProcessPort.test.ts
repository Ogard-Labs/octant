import { describe, expect, it, vi } from "vitest";
import {
  ManagedCloneProcessPort,
  managedCloneEnvironment,
  type ManagedCloneChildProcess,
  type ManagedCloneSpawnPort,
  type OwnedGitContext,
} from "./managedCloneProcessPort";

const context: OwnedGitContext = {
  templateDirectory: "/owned/template",
  globalConfigPath: "/owned/gitconfig",
  hooksDirectory: "/owned/hooks",
};

interface FakeChildControls {
  readonly child: ManagedCloneChildProcess;
  emitStderr(text: string): void;
  emitStdout(text: string): void;
  exit(code: number | null): void;
  readonly killTree: ReturnType<typeof vi.fn>;
}

function createFakeChild(options: { exitOnKill?: boolean } = {}): FakeChildControls {
  let stdoutListener: ((chunk: Buffer) => void) | undefined;
  let stderrListener: ((chunk: Buffer) => void) | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  const exit = (code: number | null) => exitListener?.(code);
  const killTree = vi.fn(() => {
    if (options.exitOnKill !== false) queueMicrotask(() => exit(null));
  });
  return {
    child: {
      pid: 4242,
      onStdout: (listener) => {
        stdoutListener = listener;
      },
      onStderr: (listener) => {
        stderrListener = listener;
      },
      onExit: (listener) => {
        exitListener = listener;
      },
      onError: () => {},
      killTree,
    },
    emitStderr: (text) => stderrListener?.(Buffer.from(text, "utf8")),
    emitStdout: (text) => stdoutListener?.(Buffer.from(text, "utf8")),
    exit,
    killTree,
  };
}

function createPort(options: {
  spawn: ManagedCloneSpawnPort;
  cloneTimeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
}) {
  return new ManagedCloneProcessPort({
    ghExecutable: "/usr/local/bin/gh",
    gitExecutable: "/usr/bin/git",
    inheritedEnvironment: options.environment ?? {
      PATH: "/usr/bin",
      HOME: "/Users/host",
      GH_TOKEN: "ghp_0123456789abcdefghij",
      GITHUB_TOKEN: "ghp_0123456789abcdefghij",
      OCTANT_DESKTOP_BRIDGE_SECRET: "internal",
      OCTANT_CREDENTIAL_BROKER_TOKEN: "internal",
      GIT_ASKPASS: "/evil/askpass",
      GIT_CONFIG_GLOBAL: "/evil/gitconfig",
      GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil",
    },
    context,
    spawn: options.spawn,
    ...(options.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: options.cloneTimeoutMs }),
  });
}

describe("managed clone environment", () => {
  it("passes only allowlisted variables plus owned Git suppression", () => {
    const environment = managedCloneEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/Users/host",
        GH_TOKEN: "ghp_0123456789abcdefghij",
        GITHUB_TOKEN: "ghp_0123456789abcdefghij",
        GH_HOST: "github.enterprise.example",
        OCTANT_DESKTOP_BRIDGE_SECRET: "internal",
        GIT_ASKPASS: "/evil/askpass",
        GIT_TEMPLATE_DIR: "/evil/template",
        GIT_CONFIG_GLOBAL: "/evil/gitconfig",
        GIT_PROXY_COMMAND: "evil",
        LD_PRELOAD: "/evil/lib.so",
      },
      context,
    );
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.HOME).toBe("/Users/host");
    expect(environment.GH_TOKEN).toBeUndefined();
    expect(environment.GITHUB_TOKEN).toBeUndefined();
    expect(environment.GH_HOST).toBeUndefined();
    expect(environment.OCTANT_DESKTOP_BRIDGE_SECRET).toBeUndefined();
    expect(environment.GIT_ASKPASS).toBeUndefined();
    expect(environment.GIT_PROXY_COMMAND).toBeUndefined();
    expect(environment.LD_PRELOAD).toBeUndefined();
    expect(environment.GIT_TEMPLATE_DIR).toBe("/owned/template");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/owned/gitconfig");
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("managed clone process", () => {
  it("invokes gh with fixed token-free arguments and the suppressed environment", async () => {
    const controls = createFakeChild();
    const spawned: Array<{
      executable: string;
      args: readonly string[];
      environment: NodeJS.ProcessEnv;
    }> = [];
    const port = createPort({
      spawn: {
        spawn: (executable, args, environment) => {
          spawned.push({ executable, args, environment });
          queueMicrotask(() => controls.exit(0));
          return controls.child;
        },
      },
    });
    const result = await port.clone(
      { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
      () => {},
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "completed" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.executable).toBe("/usr/local/bin/gh");
    expect(spawned[0]?.args).toEqual([
      "repo",
      "clone",
      "octant/octant",
      "/inventory/.incoming/r1",
      "--",
      "--no-checkout",
      "--origin=origin",
    ]);
    for (const argument of spawned[0]?.args ?? []) {
      expect(argument).not.toMatch(/ghp_|token|authorization/i);
    }
    expect(spawned[0]?.environment.GH_TOKEN).toBeUndefined();
    expect(spawned[0]?.environment.GIT_TEMPLATE_DIR).toBe("/owned/template");
  });

  it("refuses hostile owner or name without spawning", async () => {
    const spawn = vi.fn();
    const port = createPort({ spawn: { spawn } });
    const result = await port.clone(
      { owner: "octant", name: "../escape", stagingPath: "/inventory/.incoming/r1" },
      () => {},
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "failed", classification: "failed" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("redacts secrets and terminal controls from bounded progress", async () => {
    const controls = createFakeChild();
    const progress: string[] = [];
    const port = createPort({
      spawn: { spawn: () => controls.child },
    });
    const pending = port.clone(
      { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
      (message) => progress.push(message),
      new AbortController().signal,
    );
    controls.emitStderr(`Receiving objects: 42% \u001b[2K token=ghp_${"a".repeat(20)} remaining\r`);
    controls.emitStderr(`${"x".repeat(500)}\n`);
    controls.exit(0);
    await pending;
    expect(progress.length).toBeGreaterThan(0);
    for (const message of progress) {
      expect(message).not.toMatch(/ghp_[A-Za-z0-9_]{12,}/);
      expect(message).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(message.length).toBeLessThanOrEqual(160);
    }
    expect(progress[0]).toContain("Receiving objects: 42%");
    expect(progress[0]).toContain("[redacted]");
  });

  it("terminates the owned process tree on cancellation", async () => {
    const controls = createFakeChild();
    const controller = new AbortController();
    const port = createPort({ spawn: { spawn: () => controls.child } });
    const pending = port.clone(
      { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
      () => {},
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(controls.killTree).toHaveBeenCalled();
  });

  it("times out a hung clone and kills its tree", async () => {
    const controls = createFakeChild();
    const port = createPort({ spawn: { spawn: () => controls.child }, cloneTimeoutMs: 20 });
    const result = await port.clone(
      { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
      () => {},
      new AbortController().signal,
    );
    expect(result).toEqual({ kind: "timeout" });
    expect(controls.killTree).toHaveBeenCalled();
  });

  it("classifies failures without returning raw output", async () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["HTTP 401: Bad credentials", "unauthorized"],
      ["GraphQL: Could not resolve to a Repository (HTTP 404)", "not-found"],
      ["fatal: unable to access: Could not resolve host: github.com", "network"],
      ["fatal: something else entirely", "failed"],
    ];
    for (const [diagnostic, classification] of cases) {
      const controls = createFakeChild();
      const port = createPort({ spawn: { spawn: () => controls.child } });
      const pending = port.clone(
        { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
        () => {},
        new AbortController().signal,
      );
      controls.emitStderr(`${diagnostic}\n`);
      controls.exit(1);
      const result = await pending;
      expect(result).toEqual({ kind: "failed", classification });
      expect(Object.keys(result)).toEqual(["kind", "classification"]);
    }
  });

  it("kills the tree when output floods past the bound", async () => {
    const controls = createFakeChild();
    const port = createPort({ spawn: { spawn: () => controls.child } });
    const pending = port.clone(
      { owner: "octant", name: "octant", stagingPath: "/inventory/.incoming/r1" },
      () => {},
      new AbortController().signal,
    );
    controls.emitStdout("y".repeat(300_000));
    await pending;
    expect(controls.killTree).toHaveBeenCalled();
  });
});

describe("managed clone git port", () => {
  it("runs local git verification commands with the suppressed environment", async () => {
    const controls = createFakeChild();
    const spawned: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv }> =
      [];
    const port = createPort({
      spawn: {
        spawn: (executable, args, environment) => {
          spawned.push({ executable, args, env: environment });
          queueMicrotask(() => {
            controls.emitStdout("false\n");
            controls.exit(0);
          });
          return controls.child;
        },
      },
    });
    const result = await port.runGit(
      ["-C", "/inventory/.incoming/r1", "rev-parse", "--is-bare-repository"],
      new AbortController().signal,
    );
    expect(result).toEqual({ status: "completed", exitCode: 0, stdout: "false\n" });
    expect(spawned[0]?.executable).toBe("/usr/bin/git");
    expect(spawned[0]?.env.GH_TOKEN).toBeUndefined();
    expect(spawned[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  it("reports a spawn failure as unavailable instead of throwing", async () => {
    const port = createPort({
      spawn: {
        spawn: () => {
          throw new Error("spawn ENOENT");
        },
      },
    });
    expect(await port.runGit(["rev-parse", "HEAD"], new AbortController().signal)).toEqual({
      status: "failed",
    });
  });

  it("exposes the owned hooks directory for hardened checkouts", () => {
    const port = createPort({ spawn: { spawn: () => createFakeChild().child } });
    expect(port.hooksDirectory()).toBe("/owned/hooks");
  });
});
