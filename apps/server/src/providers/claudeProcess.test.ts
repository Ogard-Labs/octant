import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import type {
  SeatbeltConfinementPort,
  SeatbeltConfinementPrepareInput,
} from "../process/seatbeltProfile";
import {
  makeClaudeProcessLive,
  type ClaudeProcessOptions,
  type ClaudeRuntimeConfinement,
} from "./claudeProcess";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeClaudeCli.ts", import.meta.url));
const planProbePath = fileURLToPath(new URL("./fixtures/confinedPlanProbe.sh", import.meta.url));
const directories: string[] = [];

/**
 * These suites assert probe lifecycle, not the profile. The live builder
 * refuses on a host without `sandbox-exec`, and a real profile would deny the
 * fixture the records file it writes beside itself, so the launch is prepared
 * with the confinement passed straight through. Cases that assert the runtime
 * profile pass the shimmed builder instead.
 */
const passthroughConfinement: SeatbeltConfinementPort = {
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
  return {
    binaryPath,
    root,
    environment: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
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
    readonly port: SeatbeltConfinementPort;
    readonly prepared: SeatbeltConfinementPrepareInput[];
    readonly sandboxPath: string;
  } {
    const fake = createFakeSandboxConfinement("octant-claude-confinement-");
    directories.push(fake.root);
    const prepared: SeatbeltConfinementPrepareInput[] = [];
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
    expect(launch.allowProcessFork).toBe(false);
    // The runtime answers a Plan turn by calling its own control plane, which a
    // `none` egress would refuse before the first token (0132, 0143).
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

  it("opens the credential-store lookup for a subscription launch and not for an API-key one", () => {
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

    expect(confinement.prepared.map((launch) => launch.allowProviderCredentialLookup)).toEqual([
      true,
      false,
    ]);
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

  it.skipIf(process.platform !== "darwin")(
    "lets the operating system refuse a Plan turn's write and its process execution",
    async () => {
      const target = fixture();
      const readable = join(target.root, "readable.txt");
      const escapeTarget = join(target.root, "plan-must-not-exist.txt");
      writeFileSync(readable, "in-the-checkout\n");

      const child = makeClaudeProcessLive({ shutdownTimeoutMs: 500 }).spawn({
        projectRoot: target.root,
        executionPolicy: "plan",
      })({
        command: planProbePath,
        args: [],
        cwd: target.root,
        env: {
          ...target.environment,
          OCTANT_PROBE_TARGET: escapeTarget,
          OCTANT_PROBE_READABLE: readable,
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
      // The probe asks for a child process last. Under this posture the kernel
      // refuses the fork before the exec, so the shell dies there — it never
      // reaches the line that would report an allowed exec.
      expect(output).not.toContain("exec=allowed");
      expect(child.exitCode).toBe(128);
    },
  );
});
