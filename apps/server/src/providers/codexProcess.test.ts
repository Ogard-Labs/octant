import { accessSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either, Exit, Fiber, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  codexProcessEnvironment,
  makeCodexProcessLive,
  probeCodexBinary,
  sanitizeCodexEnvironment,
  type CodexProcessOptions,
} from "./codexProcess";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeCodexCli.ts", import.meta.url));
const directories: string[] = [];

function fixture(mode = "ready"): { readonly binaryPath: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "octant-codex-"));
  directories.push(root);
  const binaryPath = join(root, "codex-fixture");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nFAKE_CODEX_MODE='${mode}' FAKE_CODEX_ROOT='${root}' exec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, root };
}

function versionFixture(output: string): string {
  const root = mkdtempSync(join(tmpdir(), "octant-codex-version-"));
  directories.push(root);
  const binaryPath = join(root, "codex-version-fixture");
  writeFileSync(binaryPath, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  chmodSync(binaryPath, 0o755);
  return binaryPath;
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

async function failureOf<A>(effect: Effect.Effect<A, ProviderFailure, never>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

function makePort(overrides: CodexProcessOptions = {}) {
  return makeCodexProcessLive({
    octantVersion: "0.1.0-test",
    startupTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
}

beforeAll(() => {
  chmodSync(fakeCliPath, 0o755);
  accessSync(fakeCliPath);
});

afterAll(() => {
  for (const root of directories.splice(0)) {
    for (const pid of pids(root)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sanitizeCodexEnvironment", () => {
  it("preserves provider-native variables and strips Octant and runtime injection", () => {
    expect(
      sanitizeCodexEnvironment({
        PATH: "/usr/bin",
        HOME: "/Users/test",
        CODEX_HOME: "/Users/test/.codex",
        OPENAI_API_KEY: "provider-owned",
        AZURE_OPENAI_API_KEY: "provider-owned-too",
        OCTANT_DESKTOP_BRIDGE_SECRET: "must-not-cross",
        OCTANT_ANOTHER_VALUE: "remove-me",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require private-hook",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      CODEX_HOME: "/Users/test/.codex",
      OPENAI_API_KEY: "provider-owned",
      AZURE_OPENAI_API_KEY: "provider-owned-too",
    });
  });

  it("prepends the configured binary directory for env-based interpreters", () => {
    const binaryPath = "/opt/homebrew/bin/codex";

    expect(codexProcessEnvironment(binaryPath, { PATH: "/usr/bin" }).PATH).toBe(
      ["/opt/homebrew/bin", "/usr/bin"].join(delimiter),
    );
  });
});

describe("probeCodexBinary", () => {
  it("validates an absolute executable path", async () => {
    expect(await failureOf(probeCodexBinary("codex"))).toEqual({
      category: "invalid-configuration",
      message: "Codex binary path must be absolute.",
    });

    const root = mkdtempSync(join(tmpdir(), "octant-codex-invalid-"));
    directories.push(root);
    const binaryPath = join(root, "codex");
    writeFileSync(binaryPath, "not executable");
    expect((await failureOf(probeCodexBinary(binaryPath))).category).toBe("invalid-configuration");
  });

  it("parses only the exact codex semantic version output", async () => {
    const valid = fixture("version");
    await expect(Effect.runPromise(probeCodexBinary(valid.binaryPath))).resolves.toEqual({
      binaryPath: valid.binaryPath,
      version: "0.144.4",
    });

    const malformed = fixture("version-malformed");
    expect((await failureOf(probeCodexBinary(malformed.binaryPath))).category).toBe("protocol");
  });

  it("accepts SemVer 2 prerelease and build metadata", async () => {
    const binaryPath = versionFixture("codex-cli 1.2.3-alpha.1+build.005");
    await expect(Effect.runPromise(probeCodexBinary(binaryPath))).resolves.toEqual({
      binaryPath,
      version: "1.2.3-alpha.1+build.005",
    });
  });

  it("preserves a successful fast probe when receipt persistence loses the exit race", async () => {
    const binaryPath = versionFixture("codex-cli 0.144.4");
    await expect(
      Effect.runPromise(
        probeCodexBinary(binaryPath, {
          onProcessStarted: async () => {
            throw new Error("receipt raced process exit");
          },
        }),
      ),
    ).resolves.toEqual({ binaryPath, version: "0.144.4" });
  });

  it("drains stdout that arrives after process exit before parsing the version", async () => {
    const delayed = fixture("version-delayed-output");
    await expect(Effect.runPromise(probeCodexBinary(delayed.binaryPath))).resolves.toEqual({
      binaryPath: delayed.binaryPath,
      version: "0.144.4",
    });
    for (const pid of pids(delayed.root)) await expectMissing(pid);
  });

  it("rejects trailing output that arrives after process exit", async () => {
    const noisy = fixture("version-delayed-noise");
    const failure = await failureOf(probeCodexBinary(noisy.binaryPath));
    expect(failure).toEqual({
      category: "protocol",
      message: "Codex binary returned an unrecognized version.",
    });
    for (const pid of pids(noisy.root)) await expectMissing(pid);
  });

  it.each(["version-oversized-valid-prefix", "version-oversized-multibyte"])(
    "rejects oversized version output without parsing a truncated prefix: %s",
    async (mode) => {
      const target = fixture(mode);
      const failure = await failureOf(probeCodexBinary(target.binaryPath));
      expect(failure).toEqual({
        category: "protocol",
        message: "Codex binary version output exceeded the limit.",
      });
      for (const pid of pids(target.root)) await expectMissing(pid);
    },
  );

  it.each([
    "codex-cli 01.2.3",
    "codex-cli 1.02.3",
    "codex-cli 1.2.03",
    "codex-cli 1.2.3-",
    "codex-cli 1.2.3-alpha..1",
    "codex-cli 1.2.3-01",
    "codex-cli 1.2.3-alpha_1",
    "codex-cli 1.2.3+",
    "codex-cli 1.2.3+build..1",
  ])("rejects invalid SemVer 2 output: %s", async (output) => {
    const failure = await failureOf(probeCodexBinary(versionFixture(output)));
    expect(failure).toEqual({
      category: "protocol",
      message: "Codex binary returned an unrecognized version.",
    });
  });

  it("bounds non-zero and timed-out probes and removes their process groups", async () => {
    const nonzero = fixture("version-nonzero");
    expect((await failureOf(probeCodexBinary(nonzero.binaryPath))).category).toBe("unavailable");

    const timeout = fixture("version-timeout");
    const failure = await failureOf(
      probeCodexBinary(timeout.binaryPath, { timeoutMs: 3_000, shutdownTimeoutMs: 50 }),
    );
    expect(failure).toEqual({
      category: "unavailable",
      message: "Codex binary probe timed out.",
    });
    for (const pid of await waitForPids(timeout.root, 2)) await expectMissing(pid);
  });
});

describe("CodexProcessPort", () => {
  it("spawns stdio app-server and completes the stable handshake exactly once", async () => {
    const target = fixture();
    const environment = {
      ...process.env,
      OPENAI_API_KEY: "provider-owned",
      OCTANT_PRIVATE_SECRET: "must-not-cross",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "--require private-hook",
    };

    const connection = await Effect.runPromise(
      Effect.scoped(
        makePort({ inheritedEnvironment: environment })
          .start({ binaryPath: target.binaryPath })
          .pipe(
            Effect.tap(() =>
              Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25))),
            ),
          ),
      ),
    );

    expect(connection.version).toBe("0.144.4");
    expect(connection.pid).toBeGreaterThan(0);
    const observed = records(target.root);
    expect(observed.find((record) => record.kind === "spawn")).toMatchObject({
      args: ["app-server", "--listen", "stdio://"],
      environment: {
        openaiApiKey: true,
        octantKey: false,
        electronRunAsNode: false,
        nodeOptions: false,
      },
    });
    expect(observed.filter((record) => record.kind === "request")).toEqual([
      {
        kind: "request",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "Octant", title: "Octant", version: "0.1.0-test" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        },
      },
    ]);
    expect(observed.filter((record) => record.kind === "notification")).toEqual([
      { kind: "notification", method: "initialized" },
    ]);
    expect(observed.findIndex((record) => record.kind === "request")).toBeLessThan(
      observed.findIndex((record) => record.kind === "notification"),
    );
    await expect(connection.exited).resolves.toBeUndefined();
    for (const pid of pids(target.root)) await expectMissing(pid);
  });

  it("classifies initialization timeout and early exit without exposing stderr", async () => {
    const timeout = fixture("initialize-timeout");
    const timeoutFailure = await failureOf(
      Effect.scoped(makePort({ startupTimeoutMs: 50 }).start({ binaryPath: timeout.binaryPath })),
    );
    expect(timeoutFailure).toEqual({
      category: "unavailable",
      message: "Codex app-server did not initialize before the startup timeout.",
    });

    const early = fixture("early-exit");
    const diagnostics: string[] = [];
    const earlyFailure = await failureOf(
      Effect.scoped(
        makePort({
          inheritedEnvironment: { ...process.env, PRIVATE_SECRET: "host-secret" },
          onDiagnostic: (message) => diagnostics.push(message),
        }).start({ binaryPath: early.binaryPath }),
      ),
    );
    expect(earlyFailure.category).toBe("unavailable");
    expect(JSON.stringify({ earlyFailure, diagnostics })).not.toMatch(
      /host-secret|raw-stderr-secret/,
    );
  });

  it("reports only bounded redacted stderr metadata", async () => {
    const target = fixture("stderr");
    const diagnostics: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        makePort({
          onDiagnostic: (message) => diagnostics.push(message),
          stderrBytes: 32,
        }).start({ binaryPath: target.binaryPath }),
      ),
    );
    expect(diagnostics).toContain("Codex app-server stderr captured (32 bytes, truncated).");
    expect(diagnostics.join(" ")).not.toContain("raw-stderr-secret");
  });

  it.each([
    ["transport-corrupt", "protocol"],
    ["transport-close", undefined],
  ] as const)(
    "treats terminal %s stdio as process exit and removes the live process group",
    async (mode, expectedKind) => {
      const target = fixture(mode);
      const scope = await Effect.runPromise(Scope.make());
      const connection = await Effect.runPromise(
        makePort({ shutdownTimeoutMs: 50 })
          .start({ binaryPath: target.binaryPath })
          .pipe(Effect.provideService(Scope.Scope, scope)),
      );
      const processIds = await waitForPids(target.root, 2);

      await connection.rpc.notify("test/triggerTransportFailure");
      if (mode === "transport-close") await connection.rpc.close();
      const exit = await connection.exited.then(
        () => undefined,
        (error: unknown) => error,
      );

      if (expectedKind === undefined) expect(exit).toBeUndefined();
      else expect(exit).toMatchObject({ kind: expectedKind });
      for (const pid of processIds) await expectMissing(pid);
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  );

  it("terminates gracefully on scope close", async () => {
    const target = fixture("ready");
    const pid = await Effect.runPromise(
      Effect.scoped(
        makePort()
          .start({ binaryPath: target.binaryPath })
          .pipe(Effect.map((c) => c.pid)),
      ),
    );
    await expectMissing(pid);
    expect(records(target.root)).toContainEqual({ kind: "signal", signal: "SIGTERM" });
  });

  it("escalates to SIGKILL and leaves no descendant process group", async () => {
    const target = fixture("stubborn-descendant");
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makePort({ shutdownTimeoutMs: 2_000 }).start({
            binaryPath: target.binaryPath,
          });
          return yield* Effect.promise(() =>
            waitForPids(target.root, 2).then(() => connection.pid),
          );
        }),
      ),
    );
    expect(observed).toBeGreaterThan(0);
    for (const pid of pids(target.root)) await expectMissing(pid);
  });

  it("bounds scope finalization when the app-server stops draining stdin", async () => {
    const target = fixture("backpressure-descendant");
    let pid = 0;
    const scoped = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* makePort({ shutdownTimeoutMs: 50 }).start({
            binaryPath: target.binaryPath,
          });
          pid = connection.pid;
          yield* Effect.promise(() =>
            expect
              .poll(() => records(target.root).some((record) => record.kind === "stdin-paused"), {
                timeout: 3_000,
              })
              .toBe(true),
          );
          void connection.rpc
            .notify("test/backpressure", { payload: "x".repeat(16 * 1_024 * 1_024) })
            .catch(() => undefined);
          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        }),
      ),
    );

    const result = await Promise.race([
      scoped.then(() => "closed" as const),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 2_000)),
    ]);
    if (result === "timed-out" && pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await scoped;
    }
    expect(result).toBe("closed");
    for (const processId of pids(target.root)) await expectMissing(processId);
  });

  it("interrupts startup by removing the complete process group", async () => {
    const target = fixture("initialize-timeout-descendant");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            makePort({ startupTimeoutMs: 10_000 }).start({ binaryPath: target.binaryPath }),
          );
          yield* Effect.promise(() => waitForPids(target.root, 2));
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    for (const pid of pids(target.root)) await expectMissing(pid);
  });
});
