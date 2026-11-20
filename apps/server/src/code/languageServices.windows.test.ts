import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugAdapterProcessPort, type DebugAdapterLaunchInput } from "./debugAdapterProcess";
import { LanguageServerProcessPort, type LanguageServerLaunchInput } from "./languageServerProcess";

const directories: string[] = [];

afterEach(() => {
  // Windows holds a folder busy until the processes started in it have
  // exited, which can trail the kill by a moment, so let the delete retry.
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function waitForExit(pids: ReadonlyArray<number>): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (const pid of pids) {
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function folder(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-windows-language-")));
  directories.push(directory);
  return directory;
}

const confinementThatMustNotRun = {
  prepare: () => {
    throw new Error("A Windows launch is never prepared through the confinement port.");
  },
};

/** Answers each line it reads, so a test can see the launch is live. */
const ECHO = "process.stdin.on('data', (chunk) => process.stdout.write(chunk));";

function languageServerLaunch(root: string): LanguageServerLaunchInput {
  return {
    ownerId: "checkout:fake",
    launchClass: "static",
    executable: process.execPath,
    args: ["-e", ECHO],
    installRoot: dirname(process.execPath),
    checkoutRoot: root,
    cacheDirectory: join(root, "cache", "fake"),
    cacheRoot: join(root, "cache"),
  };
}

function debugLaunch(root: string): DebugAdapterLaunchInput {
  return {
    sessionId: "session-1",
    executable: process.execPath,
    installRoot: dirname(process.execPath),
    checkoutRoot: root,
    stateRoot: join(root, "state"),
    network: { kind: "allow" },
    environment: [{ key: "FIXTURE", value: "1" }],
  };
}

function stopByKill(stopped: number[]) {
  return async (pid: number) => {
    stopped.push(pid);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      return "absent" as const;
    }
    return "stopped" as const;
  };
}

async function echoes(process: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }) {
  const answer = new Promise<string>((resolve) =>
    process.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString())),
  );
  process.stdin.write("ping\n");
  return answer;
}

describe("a language server on a Windows host", () => {
  it("refuses a launch the policy did not decide was unconfined, before anything starts", async () => {
    const spawn = vi.fn();
    const port = new LanguageServerProcessPort({
      platform: "win32",
      spawn,
      confinement: confinementThatMustNotRun,
    });
    await expect(port.launch(languageServerLaunch(folder()))).resolves.toEqual({
      status: "confinement-unavailable",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses an unconfined launch off Windows", async () => {
    const port = new LanguageServerProcessPort({
      platform: "linux",
      confinement: confinementThatMustNotRun,
    });
    await expect(
      port.launch({ ...languageServerLaunch(folder()), unconfined: true }),
    ).resolves.toEqual({ status: "confinement-unavailable" });
  });

  it("starts unconfined outside Strict with no egress proxy, and ends its tree when stopped", async () => {
    const stopped: number[] = [];
    const port = new LanguageServerProcessPort({
      platform: "win32",
      confinement: confinementThatMustNotRun,
      ...(process.platform === "win32" ? {} : { stopWindowsTree: stopByKill(stopped) }),
    });
    const root = folder();
    const outcome = await port.launch({
      ...languageServerLaunch(root),
      launchClass: "repo-tooling",
      unconfined: true,
    });
    if (outcome.status !== "launched") throw new Error(`not launched: ${outcome.status}`);
    expect(await echoes(outcome.process)).toBe("ping\n");
    await outcome.process.kill();
    await outcome.process.exited;
    if (process.platform !== "win32") expect(stopped.length).toBeGreaterThan(0);
  }, 90_000);
});

describe("a Windows tree stop that fails", () => {
  it("keeps the language server's and the debug session's receipts, so a restart still stops them", async () => {
    const receipts = join(folder(), "receipts");
    const failing = async () => "failed" as const;
    const server = new LanguageServerProcessPort({
      platform: "win32",
      receiptDirectory: receipts,
      processIdentity: async () => "fixture",
      confinement: confinementThatMustNotRun,
      stopWindowsTree: failing,
    });
    const debug = new DebugAdapterProcessPort({
      platform: "win32",
      receiptDirectory: receipts,
      processIdentity: async () => "fixture",
      confinement: confinementThatMustNotRun,
      stopWindowsTree: failing,
      spawn: (command, _args, options) =>
        spawn(command, ["-e", ECHO], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        }),
    });
    const root = folder();
    const launched = [
      await server.launch({ ...languageServerLaunch(root), unconfined: true }),
      await debug.launch({ ...debugLaunch(root), unconfined: true }),
    ];
    const pids: number[] = [];
    try {
      for (const outcome of launched) {
        if (outcome.status !== "launched") throw new Error(`not launched: ${outcome.status}`);
        await outcome.process.kill();
      }
      expect(readdirSync(receipts).filter((name) => name.endsWith(".json"))).toHaveLength(2);
      for (const name of readdirSync(receipts)) {
        pids.push(Number(JSON.parse(readFileSync(join(receipts, name), "utf8")).pid));
      }
    } finally {
      // The stop is made to fail, so end each tree here. Killing only the
      // recorded pid leaves its children holding the working folder.
      for (const pid of pids) {
        try {
          execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // Already gone.
        }
      }
      await waitForExit(pids);
    }
  }, 90_000);
});

describe("a debug session on a Windows host", () => {
  it("refuses a session the policy did not decide was unconfined, or one on a proxied network", async () => {
    const spawn = vi.fn();
    const port = new DebugAdapterProcessPort({
      platform: "win32",
      spawn,
      receiptDirectory: join(folder(), "receipts"),
      confinement: confinementThatMustNotRun,
    });
    const root = folder();
    await expect(port.launch(debugLaunch(root))).resolves.toEqual({
      status: "confinement-unavailable",
    });
    await expect(
      port.launch({
        ...debugLaunch(root),
        unconfined: true,
        network: {
          kind: "proxied",
          egress: { sessionId: "session-1", projectId: "project", threadId: "thread" },
        },
      }),
    ).resolves.toEqual({ status: "confinement-unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts the adapter unconfined outside Strict with the configuration's environment and a loopback child port, and ends its tree", async () => {
    const stopped: number[] = [];
    const spawned: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
    const port = new DebugAdapterProcessPort({
      platform: "win32",
      receiptDirectory: join(folder(), "receipts"),
      processIdentity: async () => "fixture",
      confinement: confinementThatMustNotRun,
      stopWindowsTree: stopByKill(stopped),
      // The adapter here is the runtime itself told to echo; a real adapter
      // takes no arguments, which the port passes.
      spawn: (command, _args, options) => {
        spawned.push({ command, env: options.env });
        return spawn(command, ["-e", ECHO], {
          cwd: options.cwd,
          env: options.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
      },
    });
    const root = folder();
    const outcome = await port.launch({
      ...debugLaunch(root),
      unconfined: true,
      childPorts: { child: 40001, childServer: 40002 },
    });
    if (outcome.status !== "launched") throw new Error(`not launched: ${outcome.status}`);
    expect(outcome.process.childEndpoint).toEqual({ kind: "loopback", port: 40001 });
    expect(spawned[0]?.command).toBe(process.execPath);
    expect(spawned[0]?.env).toMatchObject({
      FIXTURE: "1",
      OCTANT_DEBUG_CHILD_PORT: "40001",
      OCTANT_DEBUG_CHILD_SERVER_PORT: "40002",
    });
    expect(await echoes(outcome.process)).toBe("ping\n");
    await outcome.process.kill();
    await outcome.process.exited;
    expect(stopped.length).toBeGreaterThan(0);
  }, 90_000);
});
