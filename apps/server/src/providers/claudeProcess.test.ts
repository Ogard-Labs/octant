import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderFailure } from "@octant/contracts";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { Effect, Either, Fiber } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeClaudeProcessLive, type ClaudeProcessOptions } from "./claudeProcess";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeClaudeCli.ts", import.meta.url));
const directories: string[] = [];

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
    probeOutputBytes: 256,
    runtimeStderrBytes: 64,
    shutdownTimeoutMs: 50,
    ...overrides,
  });
}

function spawnTarget(
  target: ReturnType<typeof fixture>,
  overrides: Omit<ClaudeProcessOptions, "inheritedEnvironment"> = {},
): { readonly process: SpawnedProcess; readonly controller: AbortController } {
  const controller = new AbortController();
  const process = makePort(target, overrides).spawn({
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
      port.spawn({
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
      makePort(target).spawn({
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
