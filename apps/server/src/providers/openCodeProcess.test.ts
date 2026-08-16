import { accessSync, chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  makeOpenCodeProcessLive,
  probeOpenCodeBinary,
  type OpenCodeProcessDependencies,
  type OpenCodeProcessOptions,
  type OpenCodeProcessPort,
} from "./openCodeProcess";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeOpenCodeCli.ts", import.meta.url));
const directories: string[] = [];

function fixtureRoot(mode = "ready"): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-opencode-"));
  directories.push(directory);
  writeFileSync(join(directory, ".fake-opencode-mode"), mode);
  return directory;
}

function probeWrapper(mode: string): { readonly binaryPath: string; readonly root: string } {
  const root = fixtureRoot();
  const binaryPath = join(root, "opencode-fixture");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\ncd '${root}'\nOCTANT_FAKE_OPENCODE_MODE='${mode}' exec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, root };
}

function environmentRecordingWrapper(): {
  readonly binaryPath: string;
  readonly environmentPath: string;
  readonly root: string;
} {
  const root = fixtureRoot();
  const binaryPath = join(root, "opencode-environment-fixture");
  const environmentPath = join(root, ".fake-opencode-environment");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nprintf 'broker-url=%s\\nbroker-token=%s\\ndesktop-secret=%s\\nallowed=%s\\n' "\${OCTANT_CREDENTIAL_BROKER_URL-<unset>}" "\${OCTANT_CREDENTIAL_BROKER_TOKEN-<unset>}" "\${OCTANT_DESKTOP_BRIDGE_SECRET-<unset>}" "\${OCTANT_TEST_ALLOWED_ENV-<unset>}" > '${environmentPath}'\nexec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, environmentPath, root };
}

function pids(root: string): number[] {
  try {
    return readFileSync(join(root, ".fake-opencode-pids"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function expectProcessMissing(pid: number): Promise<void> {
  await expect.poll(() => isProcessRunning(pid), { timeout: 3_000 }).toBe(false);
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

beforeAll(() => {
  chmodSync(fakeCliPath, 0o755);
  accessSync(fakeCliPath);
});

afterAll(() => {
  for (const directory of directories.splice(0)) {
    const [groupId] = pids(directory);
    if (groupId !== undefined) {
      try {
        process.kill(-groupId, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("probeOpenCodeBinary", () => {
  it("rejects a relative binary path before spawning", async () => {
    const failure = await failureOf(probeOpenCodeBinary("opencode"));
    expect(failure).toEqual({
      category: "invalid-configuration",
      message: "OpenCode binary path must be absolute.",
    });
  });

  it("rejects an absolute path that is not executable", async () => {
    const path = join(fixtureRoot(), "not-executable");
    writeFileSync(path, "not executable");
    chmodSync(path, 0o644);

    const failure = await failureOf(probeOpenCodeBinary(path));
    expect(failure.category).toBe("invalid-configuration");
    expect(failure.message).toBe("OpenCode binary path must reference an executable file.");
  });

  it("parses the installed OpenCode semantic version", async () => {
    await expect(Effect.runPromise(probeOpenCodeBinary(fakeCliPath))).resolves.toEqual({
      binaryPath: fakeCliPath,
      version: "1.17.19",
    });
  });

  it("preserves a successful fast probe when receipt persistence loses the exit race", async () => {
    await expect(
      Effect.runPromise(
        probeOpenCodeBinary(fakeCliPath, async () => {
          throw new Error("receipt raced process exit");
        }),
      ),
    ).resolves.toEqual({ binaryPath: fakeCliPath, version: "1.17.19" });
  });

  it("does not expose managed-server authority to the version probe", async () => {
    const fixture = environmentRecordingWrapper();
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_URL", "http://127.0.0.1:41000/");
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_TOKEN", "broker-secret");
    vi.stubEnv("OCTANT_DESKTOP_BRIDGE_SECRET", "desktop-secret");
    vi.stubEnv("OCTANT_TEST_ALLOWED_ENV", "allowed-value");

    await Effect.runPromise(probeOpenCodeBinary(fixture.binaryPath));

    expect(readFileSync(fixture.environmentPath, "utf8")).toBe(
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=allowed-value\n",
    );
    expect(process.env.OCTANT_CREDENTIAL_BROKER_URL).toBe("http://127.0.0.1:41000/");
    expect(process.env.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("broker-secret");
    expect(process.env.OCTANT_DESKTOP_BRIDGE_SECRET).toBe("desktop-secret");
  });

  it("rejects output that merely contains a semantic version", async () => {
    const fixture = probeWrapper("probe-misleading-version");
    const failure = await failureOf(probeOpenCodeBinary(fixture.binaryPath));
    expect(failure).toEqual({
      category: "protocol",
      message: "OpenCode binary returned an unrecognized version.",
    });
  });

  it("terminates probe descendants before returning a successful version", async () => {
    const fixture = probeWrapper("probe-success-descendant");
    await expect(Effect.runPromise(probeOpenCodeBinary(fixture.binaryPath))).resolves.toEqual({
      binaryPath: fixture.binaryPath,
      version: "1.17.19",
    });
    for (const pid of await waitForPids(fixture.root, 2)) await expectProcessMissing(pid);
  });

  it("terminates probe descendants before returning a non-zero exit failure", async () => {
    const fixture = probeWrapper("probe-failure-descendant");
    const failure = await failureOf(probeOpenCodeBinary(fixture.binaryPath));
    expect(failure).toEqual({
      category: "unavailable",
      message: "OpenCode binary probe did not succeed.",
    });
    for (const pid of await waitForPids(fixture.root, 2)) await expectProcessMissing(pid);
  });
});

describe("OpenCodeProcessPort", () => {
  const makePort = (
    overrides: OpenCodeProcessOptions = {},
    dependencies: OpenCodeProcessDependencies = {},
  ): OpenCodeProcessPort =>
    makeOpenCodeProcessLive(
      {
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 150,
        ...overrides,
      },
      dependencies,
    );

  it("starts an authenticated random loopback server", async () => {
    const root = fixtureRoot();
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makePort().start({ binaryPath: fakeCliPath, cwd: root });
          const decoded = Buffer.from(
            server.authorization.slice("Basic ".length),
            "base64",
          ).toString("utf8");
          expect(server.url.hostname).toBe("127.0.0.1");
          expect(server.url.port).not.toBe("0");
          expect(decoded).toMatch(/^octant:[A-Za-z0-9_-]{40,}$/);
          const unauthorized = yield* Effect.promise(() => fetch(server.url));
          const authorized = yield* Effect.promise(() =>
            fetch(server.url, { headers: { authorization: server.authorization } }),
          );
          expect(unauthorized).toMatchObject({ status: 401 });
          expect(authorized).toMatchObject({ status: 200 });
          return { authorization: server.authorization, pid: server.pid };
        }),
      ),
    );

    await expectProcessMissing(observed.pid);

    const second = await Effect.runPromise(
      Effect.scoped(
        makePort()
          .start({ binaryPath: fakeCliPath, cwd: fixtureRoot() })
          .pipe(Effect.map((server) => server.authorization)),
      ),
    );
    expect(second).not.toBe(observed.authorization);
  });

  it("does not expose managed-server authority to the provider session", async () => {
    const fixture = environmentRecordingWrapper();
    const inheritedEnvironment = {
      ...process.env,
      OCTANT_CREDENTIAL_BROKER_URL: "http://127.0.0.1:41000/",
      OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-secret",
      OCTANT_DESKTOP_BRIDGE_SECRET: "desktop-secret",
      OCTANT_TEST_ALLOWED_ENV: "allowed-value",
    };

    await Effect.runPromise(
      Effect.scoped(
        makePort({ inheritedEnvironment }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
        }),
      ),
    );

    expect(readFileSync(fixture.environmentPath, "utf8")).toBe(
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=allowed-value\n",
    );
    expect(inheritedEnvironment.OCTANT_CREDENTIAL_BROKER_URL).toBe("http://127.0.0.1:41000/");
    expect(inheritedEnvironment.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("broker-secret");
    expect(inheritedEnvironment.OCTANT_DESKTOP_BRIDGE_SECRET).toBe("desktop-secret");
  });

  it("accepts only the exact official readiness line", async () => {
    const failure = await failureOf(
      Effect.scoped(
        makePort({ startupTimeoutMs: 150 }).start({
          binaryPath: fakeCliPath,
          cwd: fixtureRoot("misleading-line"),
        }),
      ),
    );
    expect(failure).toEqual({
      category: "unavailable",
      message: "OpenCode server did not become ready before the startup timeout.",
    });
  });

  it("rejects a readiness endpoint that is not loopback", async () => {
    const failure = await failureOf(
      Effect.scoped(
        makePort().start({ binaryPath: fakeCliPath, cwd: fixtureRoot("non-loopback") }),
      ),
    );
    expect(failure).toEqual({
      category: "protocol",
      message: "OpenCode server reported a non-loopback readiness endpoint.",
    });
  });

  it("classifies startup timeout and leaves no process group behind", async () => {
    const root = fixtureRoot("no-ready");
    const failure = await failureOf(
      Effect.scoped(
        makePort({ startupTimeoutMs: 150 }).start({ binaryPath: fakeCliPath, cwd: root }),
      ),
    );
    expect(failure.category).toBe("unavailable");
    for (const pid of await waitForPids(root, 2)) await expectProcessMissing(pid);
  });

  it("returns a redacted typed failure when cleanup rejects during startup failure", async () => {
    const root = fixtureRoot("no-ready");
    const terminatedPids: number[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const failure = await failureOf(
        Effect.scoped(
          makePort(
            { startupTimeoutMs: 50 },
            {
              terminateProcessGroup: async (pid) => {
                terminatedPids.push(pid);
                try {
                  process.kill(-pid, "SIGKILL");
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
                }
                throw new Error("cleanup-private-secret");
              },
            },
          ).start({ binaryPath: fakeCliPath, cwd: root }),
        ),
      );
      expect(failure).toEqual({
        category: "provider-failed",
        message: "OpenCode process cleanup failed.",
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(failure)).not.toContain("cleanup-private-secret");
      expect(terminatedPids).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    for (const pid of new Set([...terminatedPids, ...pids(root)])) {
      await expectProcessMissing(pid);
    }
  });

  it("classifies early exit without exposing stderr, secrets, or inherited environment", async () => {
    const diagnostics: string[] = [];
    const failure = await failureOf(
      Effect.scoped(
        makePort({
          inheritedEnvironment: { ...process.env, PRIVATE_SECRET: "host-private-value" },
          onDiagnostic: (message: string) => diagnostics.push(message),
        }).start({ binaryPath: fakeCliPath, cwd: fixtureRoot("early-exit") }),
      ),
    );
    const visible = JSON.stringify({ failure, diagnostics });
    expect(failure.category).toBe("unavailable");
    expect(visible).not.toContain("host-private-value");
    expect(visible).not.toMatch(/password=|Basic |OPENCODE_SERVER_PASSWORD/);
  });

  it("cancels startup by terminating the complete process group", async () => {
    const root = fixtureRoot("no-ready");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            makePort({ startupTimeoutMs: 10_000 }).start({ binaryPath: fakeCliPath, cwd: root }),
          );
          yield* Effect.promise(() => waitForPids(root, 2));
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    for (const pid of pids(root)) await expectProcessMissing(pid);
  });

  it("escalates to SIGKILL and removes stubborn descendants on scope close", async () => {
    const root = fixtureRoot("stubborn");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            makePort({ startupTimeoutMs: 10_000, shutdownTimeoutMs: 100 }).start({
              binaryPath: fakeCliPath,
              cwd: root,
            }),
          );
          yield* Effect.promise(() => waitForPids(root, 2));
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    for (const pid of pids(root)) await expectProcessMissing(pid);
  });

  it("escalates successful scope finalization for a ready server with a stubborn descendant", async () => {
    const root = fixtureRoot("ready-stubborn");
    const observedPids = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* makePort({ shutdownTimeoutMs: 100 }).start({
            binaryPath: fakeCliPath,
            cwd: root,
          });
          return yield* Effect.promise(() => waitForPids(root, 2));
        }),
      ),
    );
    for (const pid of observedPids) await expectProcessMissing(pid);
  });
});
