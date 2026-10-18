import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderFailure } from "@octant/contracts";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Either, Fiber } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFakeSandboxConfinement } from "../process/fakeSandboxConfinement";
import {
  seatbeltAllowLiteralReadRule,
  seatbeltExecRule,
  type ProcessConfinementPort,
  type ProcessConfinementPrepareInput,
} from "../process/seatbeltProfile";
import {
  claudeLoginKeychainPath,
  makeClaudeProcessLive,
  type ClaudeProcessOptions,
  type ClaudeRuntimeConfinement,
} from "./claudeProcess";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeClaudeCli.ts", import.meta.url));
const planProbePath = fileURLToPath(new URL("./fixtures/confinedPlanProbe.sh", import.meta.url));
const planCommandsPath = fileURLToPath(
  new URL("./fixtures/confinedPlanCommands.sh", import.meta.url),
);
const directories: string[] = [];

/**
 * These suites assert probe lifecycle, not the profile. The live builder
 * refuses on a host without `sandbox-exec`, and a real profile would deny the
 * fixture the records file it writes beside itself, so the launch is prepared
 * with the confinement passed straight through. Cases that assert the runtime
 * profile pass the shimmed builder instead.
 */
const passthroughConfinement: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

function fixture(mode = "ready"): {
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
} {
  const root = mkdtempSync(join(tmpdir(), "octant-claude-"));
  directories.push(root);
  const binaryPath = join(root, "claude-fixture");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nFAKE_CLAUDE_MODE='${mode}' FAKE_CLAUDE_ROOT='${root}' exec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  // A Plan launch creates its runtime folders in the account directory, so
  // every fixture names one of its own rather than the person's `~/.claude`.
  const configDirectory = mkdtempSync(join(tmpdir(), "octant-claude-config-"));
  directories.push(configDirectory);
  return {
    binaryPath,
    root,
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CLAUDE_CONFIG_DIR: configDirectory,
    },
  };
}

function records(root: string): readonly Record<string, unknown>[] {
  try {
    return readFileSync(join(root, "records.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function pids(root: string): number[] {
  return records(root)
    .filter((record) => record.kind === "pid")
    .map((record) => Number(record.pid));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function expectMissing(pid: number): Promise<void> {
  await expect.poll(() => isRunning(pid), { timeout: 3_000 }).toBe(false);
}

async function waitForPids(root: string, count: number): Promise<number[]> {
  await expect.poll(() => pids(root).length, { timeout: 3_000 }).toBeGreaterThanOrEqual(count);
  return pids(root);
}

function waitForExit(process: SpawnedProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", () => resolve());
  });
}

async function failureOf<A>(effect: Effect.Effect<A, ProviderFailure, never>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

function makePort(
  target: ReturnType<typeof fixture>,
  overrides: Omit<ClaudeProcessOptions, "inheritedEnvironment"> = {},
) {
  return makeClaudeProcessLive({
    inheritedEnvironment: target.environment,
    confinement: passthroughConfinement,
    probeOutputBytes: 256,
    runtimeStderrBytes: 64,
    shutdownTimeoutMs: 50,
    ...overrides,
  });
}

/** A posture whose launch Octant does not confine, so the spawn runs unwrapped. */
function approvalGated(target: ReturnType<typeof fixture>): ClaudeRuntimeConfinement {
  return { projectRoot: target.root, executionPolicy: "approval-gated" };
}

function spawnTarget(
  target: ReturnType<typeof fixture>,
  overrides: Omit<ClaudeProcessOptions, "inheritedEnvironment"> = {},
): { readonly process: SpawnedProcess; readonly controller: AbortController } {
  const controller = new AbortController();
  const process = makePort(target, overrides).spawn(approvalGated(target))({
    command: target.binaryPath,
    args: ["sdk-test"],
    cwd: target.root,
    env: target.environment,
    signal: controller.signal,
  });
  return { process, controller };
}

beforeAll(() => {
  chmodSync(fakeCliPath, 0o755);
  accessSync(fakeCliPath);
});

afterAll(() => {
  for (const root of directories.splice(0)) {
    for (const pid of pids(root)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("ClaudeProcessPort probes", () => {
  it("rejects relative and non-executable configured binaries", async () => {
    const target = fixture();
    const port = makePort(target);
    expect(await failureOf(port.probeVersion("claude"))).toEqual({
      category: "invalid-configuration",
      message: "Claude binary path must be absolute.",
    });
    expect(await failureOf(port.probeSubscription("claude", target.environment))).toEqual({
      category: "invalid-configuration",
      message: "Claude binary path must be absolute.",
    });
    expect(() =>
      port.spawn(approvalGated(target))({
        command: "claude",
        args: ["sdk-test"],
        env: target.environment,
        signal: new AbortController().signal,
      }),
    ).toThrow("Claude binary path must be absolute.");

    const nonExecutable = join(target.root, "claude");
    writeFileSync(nonExecutable, "not executable");
    expect((await failureOf(port.probeVersion(nonExecutable))).category).toBe(
      "invalid-configuration",
    );
  });

  it("runs only the bounded version and documented JSON authentication probes", async () => {
    const ready = fixture();
    const readyPort = makePort(ready);
    await expect(Effect.runPromise(readyPort.probeVersion(ready.binaryPath))).resolves.toBe(
      "2.1.210",
    );
    await expect(
      Effect.runPromise(readyPort.probeSubscription(ready.binaryPath, ready.environment)),
    ).resolves.toBe("authenticated");
    expect(records(ready.root).filter((record) => record.kind === "invocation")).toEqual([
      { kind: "invocation", args: ["--version"] },
      { kind: "invocation", args: ["auth", "status", "--json"] },
    ]);

    const missing = fixture("auth-unauthenticated");
    await expect(
      Effect.runPromise(
        makePort(missing).probeSubscription(missing.binaryPath, missing.environment),
      ),
    ).resolves.toBe("unauthenticated");
  });

  it("keeps Claude's required guards on the version read", async () => {
    // The version read keeps a static guard only when its family names it. The
    // updater and telemetry switches are Claude's, and a read given no home and
    // no network can stall or fail on either, which reports it unavailable.
    const target = fixture();
    const root = mkdtempSync(join(tmpdir(), "octant-claude-guards-"));
    directories.push(root);
    const recorded = join(root, "guards.txt");
    const binaryPath = join(root, "claude-guards");
    writeFileSync(
      binaryPath,
      `#!/bin/sh\nprintf '%s,%s' "\${DISABLE_AUTOUPDATER-unset}" "\${DISABLE_TELEMETRY-unset}" > '${recorded}'\nprintf '2.1.210\\n'\n`,
      { mode: 0o755 },
    );
    chmodSync(binaryPath, 0o755);

    await Effect.runPromise(makePort(target).probeVersion(binaryPath));

    expect(readFileSync(recorded, "utf8")).toBe("1,1");
  });

  it("preserves a fast version probe when receipt persistence loses the exit race", async () => {
    const target = fixture();
    await expect(
      Effect.runPromise(
        makePort(target, {
          onProcessStarted: async () => {
            throw new Error("receipt raced process exit");
          },
        }).probeVersion(target.binaryPath),
      ),
    ).resolves.toBe("2.1.210");
  });

  it("rejects malformed authentication JSON without returning account fields", async () => {
    const target = fixture("auth-malformed");
    const failure = await failureOf(
      makePort(target).probeSubscription(target.binaryPath, target.environment),
    );
    expect(failure).toEqual({
      category: "protocol",
      message: "Claude authentication status response was invalid.",
    });
    expect(JSON.stringify(failure)).not.toMatch(/email|subscription|sentinel/);
  });

  it("allows valid authentication probes to use the production timeout budget", async () => {
    const target = fixture("auth-delayed-authenticated");

    await expect(
      Effect.runPromise(makePort(target).probeSubscription(target.binaryPath, target.environment)),
    ).resolves.toBe("authenticated");
  });

  it.each([
    ["version-stdout-overflow", "probeVersion"],
    ["version-stderr-overflow", "probeVersion"],
    ["auth-stdout-overflow", "probeSubscription"],
    ["auth-stderr-overflow", "probeSubscription"],
  ] as const)("bounds probe output without exposing it: %s", async (mode, operation) => {
    const target = fixture(mode);
    const port = makePort(target);
    const failure = await failureOf(
      operation === "probeVersion"
        ? port.probeVersion(target.binaryPath)
        : port.probeSubscription(target.binaryPath, target.environment),
    );
    expect(failure.category).toBe("protocol");
    expect(JSON.stringify(failure)).not.toMatch(/private-|sentinel/);
  });

  it.each([
    ["version-timeout", "probeVersion"],
    ["auth-timeout", "probeSubscription"],
  ] as const)("times out and removes the complete probe process group: %s", async (mode, op) => {
    const target = fixture(mode);
    const port = makePort(target, { probeTimeoutMs: 3_000, shutdownTimeoutMs: 2_000 });
    const failure = await failureOf(
      op === "probeVersion"
        ? port.probeVersion(target.binaryPath)
        : port.probeSubscription(target.binaryPath, target.environment),
    );
    expect(failure).toEqual({
      category: "unavailable",
      message: `Claude ${op === "probeVersion" ? "version" : "authentication"} probe timed out.`,
    });
    for (const pid of await waitForPids(target.root, 2)) await expectMissing(pid);
  });

  it("awaits in-flight probe cleanup when interrupted during shutdown", async () => {
    const target = fixture("version-root-exits-first");
    const port = makePort(target, { probeTimeoutMs: 3_000, shutdownTimeoutMs: 2_000 });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(port.probeVersion(target.binaryPath));
          const processIds = yield* Effect.promise(() => waitForPids(target.root, 2));
          const rootPid = processIds[0];
          if (rootPid === undefined) throw new Error("Expected the probe root process ID.");
          yield* Effect.promise(() =>
            expect.poll(() => isRunning(rootPid), { timeout: 3_000 }).toBe(false),
          );
          yield* Effect.promise(() =>
            expect
              .poll(
                () =>
                  records(target.root).some(
                    (record) => record.kind === "signal" && record.target === "slow-descendant",
                  ),
                { timeout: 3_000 },
              )
              .toBe(true),
          );

          yield* Fiber.interrupt(fiber);

          expect(processIds.some(isRunning)).toBe(false);
        }),
      ),
    );
  });
});

describe("ClaudeProcessPort spawn", () => {
  it("rejects credential material in process arguments before spawning", () => {
    const target = fixture();
    const credential = "broker-resolved-argument-sentinel";

    expect(() =>
      makePort(target).spawn(approvalGated(target))({
        command: target.binaryPath,
        args: ["sdk-test", `--credential=${credential}`],
        cwd: target.root,
        env: { ...target.environment, ANTHROPIC_API_KEY: credential },
        signal: new AbortController().signal,
      }),
    ).toThrow("Claude process arguments must not contain credentials.");
    expect(pids(target.root)).toEqual([]);
  });

  it("creates a detached owned process group and terminates it gracefully", async () => {
    const target = fixture();
    const { process: child } = spawnTarget(target, { shutdownTimeoutMs: 2_000 });
    const pid = (await waitForPids(target.root, 1))[0];
    if (pid === undefined) throw new Error("Expected the owned Claude process ID.");

    const processGroup = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(),
    );
    expect(processGroup).toBe(pid);

    const exited = waitForExit(child);
    expect(child.kill("SIGTERM")).toBe(true);
    await exited;
    await expectMissing(pid);
    expect(records(target.root)).toContainEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("escalates termination and leaves no stubborn descendant", async () => {
    const target = fixture("spawn-stubborn");
    const { process: child } = spawnTarget(target, { shutdownTimeoutMs: 2_000 });
    const processIds = await waitForPids(target.root, 2);
    const exited = waitForExit(child);

    expect(child.kill("SIGTERM")).toBe(true);
    await exited;
    for (const pid of processIds) await expectMissing(pid);
  });

  it("withholds root exit until a stubborn detached descendant is removed", async () => {
    const target = fixture("spawn-root-exits-first");
    const { process: child } = spawnTarget(target, { shutdownTimeoutMs: 2_000 });
    const processIds = await waitForPids(target.root, 2);

    await waitForExit(child);

    expect(processIds.some(isRunning)).toBe(false);
  });

  it("owns forwarded-signal cleanup and leaves no survivor", async () => {
    const target = fixture("spawn-stubborn");
    const { process: child, controller } = spawnTarget(target, { shutdownTimeoutMs: 2_000 });
    const processIds = await waitForPids(target.root, 2);
    const exited = waitForExit(child);

    controller.abort();
    await exited;
    for (const pid of processIds) await expectMissing(pid);
  });

  it("terminates a runtime when ownership receipt tracking fails", async () => {
    const target = fixture();
    const { process: child } = spawnTarget(target, {
      onProcessStarted: async () => {
        throw new Error("receipt unavailable");
      },
    });
    await waitForExit(child);
    expect(pids(target.root).every((pid) => !isRunning(pid))).toBe(true);
  });

  it("reports only bounded runtime stderr metadata", async () => {
    const target = fixture("spawn-stderr");
    const diagnostics: string[] = [];
    const { process: child } = spawnTarget(target, {
      onDiagnostic: (message) => diagnostics.push(message),
    });
    const pid = (await waitForPids(target.root, 1))[0];
    if (pid === undefined) throw new Error("Expected the owned Claude process ID.");
    const exited = waitForExit(child);

    child.kill("SIGTERM");
    await exited;
    await expectMissing(pid);
    expect(diagnostics).toContain("Claude runtime stderr captured (64 bytes, truncated).");
    expect(diagnostics.join(" ")).not.toMatch(/private-runtime|sentinel/);
  });
});

describe("Claude runtime confinement", () => {
  function recordingConfinement(): {
    readonly port: ProcessConfinementPort;
    readonly prepared: ProcessConfinementPrepareInput[];
    readonly sandboxPath: string;
  } {
    const fake = createFakeSandboxConfinement("octant-claude-confinement-");
    directories.push(fake.root);
    const prepared: ProcessConfinementPrepareInput[] = [];
    return {
      prepared,
      sandboxPath: fake.sandboxPath,
      port: {
        prepare: (input) => {
          prepared.push(input);
          return fake.confinement.prepare(input);
        },
      },
    };
  }

  it("binds a Plan turn's checkout to a read-only launch that may reach its provider", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    const child = makePort(target, { confinement: confinement.port }).spawn({
      projectRoot: target.root,
      executionPolicy: "plan",
    })({
      command: target.binaryPath,
      args: ["sdk-test"],
      cwd: target.root,
      env: target.environment,
      signal: new AbortController().signal,
    });
    child.kill("SIGTERM");

    const launch = confinement.prepared[0];
    if (launch === undefined) throw new Error("Expected the Plan launch to be confined.");
    expect(launch.boundRoot).toBe(realpathSync(target.root));
    expect(launch.writeBoundRoot).toBe(false);
    expect(launch.allowProcessExec).toBe(false);
    // Fork is open only where the runtime reads its sign-in from the macOS
    // Keychain, which it does by starting `/usr/bin/security`.
    expect(launch.allowProcessFork).toBe(process.platform === "darwin");
    // The runtime answers a Plan turn by calling its own control plane, which a
    // `none` egress would refuse before the first token (0132, 0145).
    expect(launch.networkEgress).toBe("allow");
  });

  it("gives a Plan turn a temporary directory only that launch can name, and removes it after the runtime exits", async () => {
    const target = fixture();
    const ambient = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-ambient-")));
    directories.push(ambient);
    // Another thread's scratch file in the shared temp root: the runtime must not be able to name it.
    writeFileSync(join(ambient, "neighbour.txt"), "another thread\n");
    const reporter = join(target.root, "report-tmpdir.sh");
    writeFileSync(
      reporter,
      "#!/bin/sh\nprintf 'tmpdir=%s\\n' \"$TMPDIR\"\nprintf 'scratch=%s\\n' \"$CLAUDE_CODE_TMPDIR\"\n[ -d \"$TMPDIR\" ] && printf 'present=yes\\n'\n",
    );
    chmodSync(reporter, 0o755);
    const confinement = recordingConfinement();

    const child = makePort(target, { confinement: confinement.port }).spawn({
      projectRoot: target.root,
      executionPolicy: "plan",
    })({
      command: reporter,
      args: [],
      cwd: target.root,
      env: { ...target.environment, TMPDIR: ambient },
      signal: new AbortController().signal,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
    });
    await waitForExit(child);

    const launch = confinement.prepared[0];
    if (launch === undefined) throw new Error("Expected the Plan launch to be confined.");
    // A fresh folder inside the ambient root, never the ambient root itself.
    expect(launch.temporaryDirectory).not.toBe(ambient);
    expect(dirname(launch.temporaryDirectory ?? "")).toBe(ambient);
    expect(basename(launch.temporaryDirectory ?? "")).toMatch(/^octant-claude-plan-/);
    expect(launch.readRoots).toContain(launch.temporaryDirectory);
    expect(launch.readRoots).not.toContain(ambient);
    expect(launch.privateHomeAllowPaths).not.toContain(ambient);
    // The runtime is told to use that folder, so it never falls back to the shared one.
    expect(output).toContain(`tmpdir=${launch.temporaryDirectory}`);
    expect(output).toContain("present=yes");
    // The runtime's own scratch defaults to a `claude-<uid>` tree in the shared
    // `/tmp`; it is moved into the launch's folder rather than granted.
    expect(output).toContain(`scratch=${launch.temporaryDirectory}`);
    const sharedScratch = join("/tmp", `claude-${process.getuid?.() ?? 0}`);
    expect(launch.additionalWriteRoots ?? []).not.toContain(sharedScratch);
    expect(launch.readRoots ?? []).not.toContain(sharedScratch);
    // The folder goes with the runtime; the shared root and its other files stay.
    expect(existsSync(launch.temporaryDirectory ?? "")).toBe(false);
    expect(readdirSync(ambient)).toEqual(["neighbour.txt"]);
  });

  it("removes a Plan turn's temporary directory when the launch is refused", () => {
    const target = fixture();
    const ambient = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-ambient-")));
    directories.push(ambient);

    expect(() =>
      makePort(target, {
        confinement: {
          prepare: () => {
            throw new Error("no sandbox runtime");
          },
        },
      }).spawn({ projectRoot: target.root, executionPolicy: "plan" })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: { ...target.environment, TMPDIR: ambient },
        signal: new AbortController().signal,
      }),
    ).toThrow("no sandbox runtime");
    expect(readdirSync(ambient)).toEqual([]);
  });

  it("grants a subscription Plan launch its Keychain sign-in read on macOS and an API-key launch nothing", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    for (const environment of [
      target.environment,
      { ...target.environment, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    ]) {
      const child = makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: environment,
        signal: new AbortController().signal,
      });
      child.kill("SIGTERM");
    }

    expect(confinement.prepared).toHaveLength(2);
    const [subscription, apiKey] = confinement.prepared;
    if (process.platform === "darwin") {
      // Measured on macOS 27.0.1 with Claude Code 2.1.296: the runtime is
      // signed out with any one of these missing, and needs nothing more.
      expect(subscription?.extraRules).toEqual([
        seatbeltExecRule("/usr/bin/security"),
        '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
        '(allow mach-lookup (global-name "com.apple.securityd.xpc"))',
        seatbeltAllowLiteralReadRule(claudeLoginKeychainPath()),
      ]);
      expect(subscription?.allowProcessFork).toBe(true);
    } else {
      expect(subscription?.extraRules).toBeUndefined();
      expect(subscription?.allowProcessFork).toBe(false);
    }
    // No shell and no open exec in either case: neither launch offers Bash.
    expect(subscription?.allowProcessExec).toBe(false);
    // An API-key launch reads nothing from the store.
    expect(apiKey?.extraRules).toBeUndefined();
    expect(apiKey?.allowProcessFork).toBe(false);
    expect(apiKey?.allowProcessExec).toBe(false);
  });

  it("grants the shell and its programs only to a Plan launch that offers the Bash tool", () => {
    const target = fixture();
    const confinement = recordingConfinement();
    for (const runsCommands of [false, true]) {
      const child = makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
        runsCommands,
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: { ...target.environment, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
        signal: new AbortController().signal,
      });
      child.kill("SIGTERM");
    }
    const [withoutShell, withShell] = confinement.prepared;
    // Chat, Work and the readiness probes run Plan with no shell, so their
    // process keeps no fork and no program but itself.
    expect(withoutShell?.allowProcessFork).toBe(false);
    expect(withoutShell?.extraRules).toBeUndefined();
    if (process.platform === "darwin") {
      expect(withShell?.allowProcessFork).toBe(true);
      expect(withShell?.extraRules).toContain(seatbeltExecRule("/bin/zsh"));
    } else {
      expect(withShell?.allowProcessFork).toBe(false);
      expect(withShell?.extraRules).toBeUndefined();
    }
    expect(withShell?.allowProcessExec).toBe(false);
  });

  it("checks a confined launch's sign-in inside that launch's confinement", async () => {
    const target = fixture();
    const confinement = recordingConfinement();
    const port = makePort(target, { confinement: confinement.port });

    // The readiness check has no launch to speak for and stays unconfined.
    await expect(
      Effect.runPromise(port.probeSubscription(target.binaryPath, target.environment)),
    ).resolves.toBe("authenticated");
    // An approval-gated launch is not confined by Octant, so neither is its check.
    await expect(
      Effect.runPromise(
        port.probeSubscription(target.binaryPath, target.environment, approvalGated(target)),
      ),
    ).resolves.toBe("authenticated");
    expect(confinement.prepared).toEqual([]);

    await expect(
      Effect.runPromise(
        port.probeSubscription(target.binaryPath, target.environment, {
          projectRoot: target.root,
          executionPolicy: "plan",
        }),
      ),
    ).resolves.toBe("authenticated");
    expect(confinement.prepared).toHaveLength(1);
    expect(confinement.prepared[0]).toMatchObject({
      executable: target.binaryPath,
      args: ["auth", "status", "--json"],
      boundRoot: realpathSync(target.root),
      writeBoundRoot: false,
      allowProcessExec: false,
    });
  });

  it("refuses a launch whose arguments carry the helper token", () => {
    const target = fixture();
    expect(() =>
      makePort(target, { confinement: recordingConfinement().port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["--token", "helper-token-sentinel-0123456789"],
        cwd: target.root,
        env: { ...target.environment, CLAUDE_CODE_OAUTH_TOKEN: "helper-token-sentinel-0123456789" },
        signal: new AbortController().signal,
      }),
    ).toThrow("must not contain credentials");
  });

  it("refuses a Plan turn whose project root is also a runtime state directory", () => {
    const target = fixture();
    const configHome = join(target.root, ".claude");
    mkdirSync(configHome);
    const confinement = recordingConfinement();

    expect(() =>
      makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: configHome,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: configHome,
        env: { ...target.environment, HOME: configHome, CLAUDE_CONFIG_DIR: configHome },
        signal: new AbortController().signal,
      }),
    ).toThrow("overlaps the checkout");
    expect(confinement.prepared).toEqual([]);
    expect(pids(configHome)).toEqual([]);
  });

  it("refuses a Plan turn whose account directory is inside the checkout", () => {
    const target = fixture();
    const accountDirectory = join(target.root, ".claude-accounts", "work");
    mkdirSync(accountDirectory, { recursive: true });
    const confinement = recordingConfinement();

    expect(() =>
      makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: { ...target.environment, CLAUDE_CONFIG_DIR: accountDirectory },
        signal: new AbortController().signal,
      }),
    ).toThrow("overlaps the checkout");
    expect(confinement.prepared).toEqual([]);
    expect(pids(target.root)).toEqual([]);
  });

  it("refuses a Plan turn whose account directory is an ancestor of the checkout", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    expect(() =>
      makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: { ...target.environment, CLAUDE_CONFIG_DIR: dirname(target.root) },
        signal: new AbortController().signal,
      }),
    ).toThrow("overlaps the checkout");
    expect(confinement.prepared).toEqual([]);
    expect(pids(target.root)).toEqual([]);
  });

  it("lets a Plan turn write only the runtime's session folder and its own session's transcript", () => {
    const target = fixture();
    // A folder of the test's own. This used to be made inside the person's
    // real `~/.claude-accounts`, which a test has no business touching.
    const configDirectory = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-account-")));
    directories.push(configDirectory);
    const confinement = recordingConfinement();
    const sessionId = randomUUID();

    const child = makePort(target, { confinement: confinement.port }).spawn({
      projectRoot: target.root,
      executionPolicy: "plan",
    })({
      command: target.binaryPath,
      args: ["sdk-test", "--session-id", sessionId],
      cwd: target.root,
      env: {
        ...target.environment,
        CLAUDE_CONFIG_DIR: configDirectory,
        ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
      },
      signal: new AbortController().signal,
    });
    child.kill("SIGTERM");

    const launch = confinement.prepared[0];
    if (launch === undefined) throw new Error("Expected the Plan launch to be confined.");
    // The folder is read whole, and written only where the runtime keeps a
    // session: never its settings, hooks, skills, plugins or `.claude.json`.
    expect(launch.readRoots).toContain(configDirectory);
    // Of `projects/`, only this session's transcript and its own folder: not
    // the checkout's folder, whose name another checkout can share, and not
    // its `memory/`, which a later session reads as instructions.
    const sessionPath = join(
      configDirectory,
      "projects",
      realpathSync(target.root).replace(/[^a-zA-Z0-9]/g, "-"),
      sessionId,
    );
    expect(launch.additionalWriteRoots).toEqual([
      join(configDirectory, "sessions"),
      `${sessionPath}.jsonl`,
      sessionPath,
    ]);
    // Made before the launch, because the launch cannot create them itself.
    // The transcript is not: the runtime refuses a new session id whose
    // transcript already exists.
    expect(readdirSync(configDirectory).sort()).toEqual(["projects", "sessions"]);
    expect(existsSync(sessionPath)).toBe(true);
    expect(existsSync(`${sessionPath}.jsonl`)).toBe(false);
  });

  /** The rules a Plan launch is prepared with for a home with no account folder named. */
  function planRulesForHome(
    home: string,
    extraEnvironment: Record<string, string> = {},
  ): {
    readonly rules: ReadonlyArray<string>;
    readonly readRoots: ReadonlyArray<string>;
  } {
    const target = fixture();
    const { CLAUDE_CONFIG_DIR: _unset, ...environment } = target.environment;
    const confinement = recordingConfinement();
    const child = makePort(target, { confinement: confinement.port }).spawn({
      projectRoot: target.root,
      executionPolicy: "plan",
    })({
      command: target.binaryPath,
      args: ["sdk-test", "--session-id", randomUUID()],
      cwd: target.root,
      env: { ...environment, HOME: home, ...extraEnvironment },
      signal: new AbortController().signal,
    });
    child.kill("SIGTERM");
    const launch = confinement.prepared[0];
    if (launch === undefined) throw new Error("Expected the Plan launch to be confined.");
    return { rules: launch.extraRules ?? [], readRoots: launch.readRoots ?? [] };
  }

  it.runIf(process.platform === "darwin")(
    "lets a Plan turn read the default account's global configuration file by literal path",
    () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-home-")));
      directories.push(home);
      writeFileSync(join(home, ".claude.json"), "{}");

      const { rules, readRoots } = planRulesForHome(home);

      // Refused, the runtime retries the read for about six seconds, longer
      // than the sign-in probe waits. Only that file, never a subtree.
      expect(rules).toContain(seatbeltAllowLiteralReadRule(join(home, ".claude.json")));
      expect(readRoots).not.toContain(join(home, ".claude.json"));
      expect(readRoots).not.toContain(home);
    },
  );

  it.runIf(process.platform === "darwin")(
    "grants no global configuration file that is a link, to a folder or to a file",
    () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-home-")));
      const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-elsewhere-")));
      directories.push(home, elsewhere);
      writeFileSync(join(elsewhere, "target.json"), "{}");
      for (const target of [elsewhere, join(elsewhere, "target.json")]) {
        rmSync(join(home, ".claude.json"), { force: true });
        symlinkSync(target, join(home, ".claude.json"));

        const { rules, readRoots } = planRulesForHome(home);

        expect(rules.some((rule) => rule.includes(elsewhere))).toBe(false);
        expect(rules.some((rule) => rule.includes(".claude.json"))).toBe(false);
        expect(readRoots).not.toContain(elsewhere);
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "treats an empty account folder setting as none for the global configuration file",
    () => {
      const home = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-home-")));
      directories.push(home);
      writeFileSync(join(home, ".claude.json"), "{}");

      const { rules } = planRulesForHome(home, { CLAUDE_CONFIG_DIR: "" });

      expect(rules).toContain(seatbeltAllowLiteralReadRule(join(home, ".claude.json")));
    },
  );

  it("grants no global configuration file when the account names its folder", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    const child = makePort(target, { confinement: confinement.port }).spawn({
      projectRoot: target.root,
      executionPolicy: "plan",
    })({
      command: target.binaryPath,
      args: ["sdk-test", "--session-id", randomUUID()],
      cwd: target.root,
      env: target.environment,
      signal: new AbortController().signal,
    });
    child.kill("SIGTERM");

    const launch = confinement.prepared[0];
    if (launch === undefined) throw new Error("Expected the Plan launch to be confined.");
    // Linux prepares no extra rules at all, so absence is the same answer.
    expect((launch.extraRules ?? []).some((rule) => rule.includes(".claude.json"))).toBe(false);
  });

  it("grants a Plan turn no transcript when its arguments name no session", () => {
    const target = fixture();
    const configDirectory = realpathSync(target.environment.CLAUDE_CONFIG_DIR ?? "");
    const confinement = recordingConfinement();

    for (const args of [["sdk-test"], ["sdk-test", "--session-id", "../../settings"]]) {
      const child = makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args,
        cwd: target.root,
        env: { ...target.environment, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
        signal: new AbortController().signal,
      });
      child.kill("SIGTERM");
    }

    for (const launch of confinement.prepared) {
      expect(launch.additionalWriteRoots).toEqual([join(configDirectory, "sessions")]);
    }
  });

  it("lets a subscription Plan turn rewrite its login file only where the login is a file", () => {
    const target = fixture();
    const configDirectory = realpathSync(target.environment.CLAUDE_CONFIG_DIR ?? "");
    const secureStorage = realpathSync(mkdtempSync(join(tmpdir(), "octant-claude-secure-")));
    directories.push(secureStorage);
    const confinement = recordingConfinement();

    for (const environment of [
      target.environment,
      { ...target.environment, CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorage },
      { ...target.environment, ANTHROPIC_API_KEY: "sk-test-not-a-real-key" },
    ]) {
      const child = makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: environment,
        signal: new AbortController().signal,
      });
      child.kill("SIGTERM");
    }

    const [subscription, named, apiKey] = confinement.prepared.map(
      (launch) => launch.additionalWriteRoots ?? [],
    );
    if (process.platform === "darwin") {
      // The login lives in the Keychain, which the launch may read but never write.
      expect(subscription).not.toContainEqual(expect.stringContaining(".credentials.json"));
      expect(named).not.toContainEqual(expect.stringContaining(".credentials.json"));
    } else {
      expect(subscription).toContain(join(configDirectory, ".credentials.json"));
      expect(named).toContain(join(secureStorage, ".credentials.json"));
      expect(named).not.toContain(join(configDirectory, ".credentials.json"));
    }
    // A secure-storage folder is read for the login, and never a write root itself.
    expect(confinement.prepared[1]?.readRoots).toContain(secureStorage);
    expect(named).not.toContain(secureStorage);
    expect(apiKey).not.toContainEqual(expect.stringContaining(".credentials.json"));
  });

  it("refuses a Plan turn whose temporary directory is inside the checkout", () => {
    const target = fixture();
    const inside = join(target.root, "scratch");
    mkdirSync(inside);
    const confinement = recordingConfinement();

    expect(() =>
      makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: { ...target.environment, TMPDIR: inside },
        signal: new AbortController().signal,
      }),
    ).toThrow("outside the checkout");
    // Nothing is created in the tree the turn may only read, and nothing starts.
    expect(readdirSync(inside)).toEqual([]);
    expect(confinement.prepared).toEqual([]);
    expect(pids(target.root)).toEqual([]);
  });

  it("leaves a posture that still writes on the runtime's own sandbox", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    for (const executionPolicy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      const child = makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: target.root,
        executionPolicy,
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: target.environment,
        signal: new AbortController().signal,
      });
      child.kill("SIGTERM");
    }

    expect(confinement.prepared).toEqual([]);
  });

  it("refuses a Plan turn that has no checkout to bind rather than launching unwrapped", () => {
    const target = fixture();
    const confinement = recordingConfinement();

    expect(() =>
      makePort(target, { confinement: confinement.port }).spawn({
        projectRoot: join(target.root, "no-such-checkout"),
        executionPolicy: "plan",
      })({
        command: target.binaryPath,
        args: ["sdk-test"],
        cwd: target.root,
        env: target.environment,
        signal: new AbortController().signal,
      }),
    ).toThrow("existing absolute project root");
    expect(confinement.prepared).toEqual([]);
    expect(pids(target.root)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin").each([
    { launch: "an API-key", apiKey: "sk-test-not-a-real-key", forks: false },
    { launch: "a subscription", apiKey: undefined, forks: true },
  ])(
    "lets the operating system refuse $launch Plan turn's write and its process execution",
    async ({ apiKey, forks }) => {
      const target = fixture();
      const readable = join(target.root, "readable.txt");
      const escapeTarget = join(target.root, "plan-must-not-exist.txt");
      writeFileSync(readable, "in-the-checkout\n");
      // The probe runs from inside the project root the profile grants. Run
      // from the checkout it is unreadable whenever the checkout sits under
      // `/private`, which the profile denies, and the turn then fails to start
      // rather than proving anything about its writes.
      const probe = join(target.root, "confinedPlanProbe.sh");
      copyFileSync(planProbePath, probe);
      chmodSync(probe, 0o755);
      // The account directory: the runtime's session folders are writable, and
      // what a later session loads is not.
      const stateRoot = realpathSync(target.environment.CLAUDE_CONFIG_DIR ?? "");
      mkdirSync(join(stateRoot, "skills"));
      // This session in the runtime's folder for this checkout, another
      // session in the same folder (which a checkout whose name sanitizes the
      // same would also use), and another checkout's folder. Both `memory/`
      // folders exist already, so the probe's write is refused for the file
      // and not only for creating the folder.
      const sessionId = randomUUID();
      const ownProject = `projects/${realpathSync(target.root).replace(/[^a-zA-Z0-9]/g, "-")}`;
      const otherProject = "projects/-Users-someone-another-checkout";
      mkdirSync(join(stateRoot, ownProject, "memory"), { recursive: true });
      mkdirSync(join(stateRoot, otherProject, "memory"), { recursive: true });
      const stateWrites = [
        "settings.json",
        ".claude.json",
        "skills/SKILL.md",
        "sessions/probe.json",
        `${ownProject}/${sessionId}.jsonl`,
        `${ownProject}/${sessionId}/subagent.jsonl`,
        `${ownProject}/another-session.jsonl`,
        `${ownProject}/memory/MEMORY.md`,
        `${otherProject}/another-session.jsonl`,
        `${otherProject}/memory/MEMORY.md`,
        "projects/probe.jsonl",
      ];

      // The limit only bounds a failed cleanup. Half a second was too short on
      // a loaded machine: the group outlived it and the test failed with
      // "Claude process cleanup failed" though every assertion held.
      const child = makeClaudeProcessLive({ shutdownTimeoutMs: 5_000 }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: probe,
        // The arguments the Agent SDK passes for a session Octant opened.
        args: ["--session-id", sessionId],
        cwd: target.root,
        env: {
          ...target.environment,
          ...(apiKey === undefined ? {} : { ANTHROPIC_API_KEY: apiKey }),
          OCTANT_PROBE_TARGET: escapeTarget,
          OCTANT_PROBE_READABLE: readable,
          OCTANT_PROBE_STATE_ROOT: stateRoot,
          OCTANT_PROBE_STATE_WRITES: stateWrites.map((path) => join(stateRoot, path)).join(":"),
        },
        signal: new AbortController().signal,
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      await waitForExit(child);

      expect(output).toContain("write=refused");
      expect(existsSync(escapeTarget)).toBe(false);
      // The checkout is readable; only writing and running something is not.
      expect(output).toContain("read=in-the-checkout");
      // A settings hook, a skill or an MCP server planted here would run on a
      // later turn outside this sandbox.
      expect(output).toContain("state:settings.json=refused");
      expect(output).toContain("state:.claude.json=refused");
      expect(output).toContain("state:skills/SKILL.md=refused");
      expect(existsSync(join(stateRoot, "settings.json"))).toBe(false);
      expect(output).toContain("state:sessions/probe.json=allowed");
      // The session's own transcript and folder are written; another
      // session's transcript, in this checkout's folder or another's, and
      // every `memory/` folder, which a later session reads as instructions,
      // are not.
      expect(output).toContain(`state:${ownProject}/${sessionId}.jsonl=allowed`);
      expect(output).toContain(`state:${ownProject}/${sessionId}/subagent.jsonl=allowed`);
      expect(output).toContain(`state:${ownProject}/another-session.jsonl=refused`);
      expect(output).toContain(`state:${ownProject}/memory/MEMORY.md=refused`);
      expect(output).toContain(`state:${otherProject}/another-session.jsonl=refused`);
      expect(output).toContain(`state:${otherProject}/memory/MEMORY.md=refused`);
      expect(output).toContain("state:projects/probe.jsonl=refused");
      expect(existsSync(join(stateRoot, ownProject, "memory", "MEMORY.md"))).toBe(false);
      // The probe asks for a child process last, and no launch without the
      // Bash tool may run one.
      expect(output).not.toContain("exec=allowed");
      if (forks) {
        // A Keychain sign-in needs fork, so the shell forks, and the kernel
        // then refuses the exec of anything but the runtime and `security`.
        expect(output).toContain("exec=refused");
        expect(child.exitCode).toBe(0);
      } else {
        // Without fork the shell dies at the fork itself and reports nothing.
        expect(output).not.toContain("exec=refused");
        expect(child.exitCode).toBe(128);
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "lets a Plan turn's shell read the checkout with Git and the listed tools, and refuses every write and reach beyond its grant",
    async () => {
      const target = fixture();
      const checkout = realpathSync(target.root);
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=Plan", "-c", "user.email=plan@example.invalid", ...args],
          {
            cwd: checkout,
            stdio: "pipe",
          },
        );
      writeFileSync(join(checkout, "notes.txt"), "first line\n");
      git("init", "-q");
      git("add", "notes.txt");
      git("commit", "-qm", "Add the first note");
      writeFileSync(join(checkout, "notes.txt"), "first line\nneedle line\n");
      git("commit", "-qam", "Add the needle");
      const stateRoot = realpathSync(target.environment.CLAUDE_CONFIG_DIR ?? "");
      // A repository's own configuration names a command Git runs on every
      // status and diff. Through `/bin/sh` it would plant a file in the account.
      const planted = join(stateRoot, "fsmonitor-ran");
      git("config", "core.fsmonitor", `sh -c 'echo ran > ${planted}' #`);
      const probe = join(checkout, "confinedPlanCommands.sh");
      copyFileSync(planCommandsPath, probe);
      chmodSync(probe, 0o755);
      const sessionId = randomUUID();
      const ownProject = `projects/${checkout.replace(/[^a-zA-Z0-9]/g, "-")}`;
      mkdirSync(join(stateRoot, "skills", "planted"), { recursive: true });
      mkdirSync(join(stateRoot, "plugins"), { recursive: true });
      mkdirSync(join(stateRoot, ownProject, "memory"), { recursive: true });
      writeFileSync(join(stateRoot, ownProject, "another-session.jsonl"), "{}\n");
      mkdirSync(join(stateRoot, "projects", "-Users-someone-another-checkout"), {
        recursive: true,
      });
      // `git log --output=<path>` writes wherever it is pointed; each target
      // is reported by its name under the account folder or the checkout.
      const writeTargets = [
        `${stateRoot}/settings.json`,
        `${stateRoot}/.claude.json`,
        `${stateRoot}/skills/planted/SKILL.md`,
        `${stateRoot}/plugins/installed_plugins.json`,
        `${stateRoot}/${ownProject}/memory/MEMORY.md`,
        `${stateRoot}/projects/-Users-someone-another-checkout/session.jsonl`,
        `${checkout}/planted.txt`,
        `${checkout}/.git/hooks/pre-commit`,
        `${stateRoot}/${ownProject}/${sessionId}.jsonl`,
      ];
      const commands = [
        "exec 2>&1",
        "print -r -- log=$(git log --oneline -1)",
        "print -r -- diff=$(git diff HEAD~1 --stat | head -1)",
        "print -r -- ls=$(ls | sort | tr '\\n' ' ')",
        "print -r -- cat=$(cat notes.txt | tail -1)",
        "print -r -- grep=$(grep -c needle notes.txt)",
        "if whence -p rg >/dev/null; then print -r -- rg=$(rg -c needle notes.txt); fi",
        ...writeTargets.map(
          (path) =>
            `if git log --output=${path} -1 >/dev/null 2>&1; then print -r -- "output:${path}=allowed"; else print -r -- "output:${path}=refused"; fi`,
        ),
        'print -r -- written > "$TMPDIR/scratch.txt" && print -r -- scratch=$(cat "$TMPDIR/scratch.txt")',
        // Another session's transcript, from any checkout, is the runtime's to read.
        `if cat ${stateRoot}/${ownProject}/another-session.jsonl >/dev/null 2>&1; then print -r -- account-read=allowed; else print -r -- account-read=refused; fi`,
        // The environment pins the repository's fsmonitor off; with that set
        // aside, the profile still refuses the `/bin/sh` Git would start it in.
        "git status --short >/dev/null 2>&1; GIT_CONFIG_COUNT=0 git status --short >/dev/null 2>&1",
        // No host for the shell or what it starts, even where the runtime has one.
        "git ls-remote git://127.0.0.1:9/probe 2>&1 | grep -q 'Operation not permitted' && print -r -- network=refused",
        // Not the runtime's own program, not `/bin/sh`, and not `security`.
        'for program in /bin/bash /bin/sh /usr/bin/security /bin/date; do if $program -c true >/dev/null 2>&1; then print -r -- "run:$program=allowed"; else print -r -- "run:$program=refused"; fi; done',
      ].join("\n");

      const child = makeClaudeProcessLive({ shutdownTimeoutMs: 5_000 }).spawn({
        projectRoot: checkout,
        executionPolicy: "plan",
        runsCommands: true,
      })({
        command: probe,
        args: ["--session-id", sessionId],
        cwd: checkout,
        env: {
          ...target.environment,
          ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
          OCTANT_PROBE_COMMANDS: commands,
        },
        signal: new AbortController().signal,
      });
      let output = "";
      child.stdout.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      await waitForExit(child);

      // Reads in the checkout work: Git's history and diff, and the listed tools.
      expect(output).toMatch(/^log=[0-9a-f]+ Add the needle$/m);
      expect(output).toMatch(/^diff= ?notes\.txt \| 1 \+$/m);
      expect(output).toMatch(/^ls=.*\bnotes\.txt\b/m);
      expect(output).toContain("cat=needle line");
      expect(output).toContain("grep=1");
      if (output.includes("rg=")) expect(output).toContain("rg=1");
      // A write through Git is refused everywhere, this session's transcript
      // included: that grant is the runtime's, not a command's.
      for (const path of writeTargets) {
        expect(output).toContain(`output:${path}=refused`);
        expect(existsSync(path)).toBe(false);
      }
      // The launch's own temporary directory, where the Bash tool keeps its
      // output, is the one place a command writes.
      expect(output).toContain("scratch=written");
      expect(output).toContain("account-read=refused");
      // The repository's configured command never ran.
      expect(existsSync(planted)).toBe(false);
      expect(output).toContain("network=refused");
      // `/bin/bash` stands in for the runtime here, so this is also the shell
      // being refused a second runtime.
      for (const program of ["/bin/bash", "/bin/sh", "/usr/bin/security", "/bin/date"]) {
        expect(output).toContain(`run:${program}=refused`);
      }
      expect(child.exitCode).toBe(0);
    },
  );
});
