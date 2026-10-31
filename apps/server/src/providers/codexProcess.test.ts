import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either, Exit, Fiber, Scope } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  codexAccountProcessEnvironment,
  codexAppServerArgs,
  codexProcessEnvironment,
  makeCodexProcessLive,
  prepareCodexLaunch,
  probeCodexBinary,
  sanitizeCodexEnvironment,
  type CodexLaunchAuthority,
  type CodexProbeOptions,
  type CodexProcessOptions,
} from "./codexProcess";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeCodexCli.ts", import.meta.url));
// The lifecycle tests drive a fake CLI; the profile itself is covered below.
const UNWRAPPED: CodexLaunchAuthority = {
  kind: "thread",
  root: tmpdir(),
  mode: "code",
  executionPolicy: "full-access",
};
const directories: string[] = [];

/**
 * These suites assert process lifecycle, not the profile. The live builder
 * refuses on a host without `sandbox-exec`, and a real profile would deny the
 * fixture the records file it writes beside itself, so the launch is prepared
 * with the confinement passed straight through.
 */
const passthroughConfinement: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

function probeCodex(binaryPath: string, overrides: CodexProbeOptions = {}) {
  return probeCodexBinary(binaryPath, { confinement: passthroughConfinement, ...overrides });
}

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
    versionProbeConfinement: passthroughConfinement,
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
  it("carries only what the Codex CLI reads and drops every other host variable", () => {
    expect(
      sanitizeCodexEnvironment({
        PATH: "/usr/bin",
        HOME: "/Users/test",
        TMPDIR: "/var/folders/tmp",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        LC_CTYPE: "en_US.UTF-8",
        HTTPS_PROXY: "http://proxy.internal:3128",
        https_proxy: "http://proxy.internal:3128",
        SSL_CERT_FILE: "/etc/ssl/cert.pem",
        CODEX_HOME: "/Users/test/.codex",
        CODEX_CA_CERTIFICATE: "/etc/ssl/corporate.pem",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "provider-owned",
        CODEX_ACCESS_TOKEN: "provider-owned-too",
        AWS_BEARER_TOKEN_BEDROCK: "bedrock-provider-owned",
        AWS_REGION: "us-east-1",
        OCTANT_DESKTOP_BRIDGE_SECRET: "must-not-cross",
        OCTANT_ANOTHER_VALUE: "remove-me",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require private-hook",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      TMPDIR: "/var/folders/tmp",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy.internal:3128",
      https_proxy: "http://proxy.internal:3128",
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CODEX_HOME: "/Users/test/.codex",
      CODEX_CA_CERTIFICATE: "/etc/ssl/corporate.pem",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      OPENAI_API_KEY: "provider-owned",
      CODEX_ACCESS_TOKEN: "provider-owned-too",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-provider-owned",
      AWS_REGION: "us-east-1",
    });
  });

  it("keeps general-purpose cloud and source-host credentials out of the app-server", () => {
    // The app-server runs model-generated shell commands without confinement,
    // so a host credential that crosses is readable by the model. IAM keys
    // grant far more than the Bedrock access a bearer token does, and an AWS
    // profile or shared-config location only points the runtime and its
    // commands at those same reusable keys.
    expect(
      sanitizeCodexEnvironment({
        PATH: "/usr/bin",
        GITHUB_TOKEN: "must-not-cross",
        GH_TOKEN: "must-not-cross",
        CODEX_GITHUB_PERSONAL_ACCESS_TOKEN: "must-not-cross",
        AWS_ACCESS_KEY_ID: "must-not-cross",
        AWS_SECRET_ACCESS_KEY: "must-not-cross",
        AWS_SESSION_TOKEN: "must-not-cross",
        AWS_PROFILE: "must-not-cross",
        AWS_DEFAULT_PROFILE: "must-not-cross",
        AWS_CONFIG_FILE: "must-not-cross",
        AWS_SHARED_CREDENTIALS_FILE: "must-not-cross",
        ANTHROPIC_API_KEY: "another-provider",
        STRIPE_SECRET_KEY: "must-not-cross",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("keeps inherited auth on the host-overlay account", () => {
    const environment = codexAccountProcessEnvironment({
      binaryPath: "/opt/homebrew/bin/codex",
      hostEnvironment: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "host-key",
        CODEX_ACCESS_TOKEN: "host-token",
        CODEX_API_KEY: "host-codex-key",
        AWS_BEARER_TOKEN_BEDROCK: "host-bedrock",
      },
      codexHome: "/Users/test/.codex",
      inheritHostAuth: true,
    });
    expect(environment.CODEX_HOME).toBe("/Users/test/.codex");
    expect(environment.OPENAI_API_KEY).toBe("host-key");
    expect(environment.CODEX_ACCESS_TOKEN).toBe("host-token");
    expect(environment.CODEX_API_KEY).toBe("host-codex-key");
    expect(environment.AWS_BEARER_TOKEN_BEDROCK).toBe("host-bedrock");
  });

  it("strips inherited auth variables and pins CODEX_HOME for one account", () => {
    const environment = codexAccountProcessEnvironment({
      binaryPath: "/opt/homebrew/bin/codex",
      hostEnvironment: {
        PATH: "/usr/bin",
        CODEX_HOME: "/Users/test/.codex",
        OPENAI_API_KEY: "inherited-must-not-cross",
        CODEX_ACCESS_TOKEN: "inherited-must-not-cross",
        CODEX_API_KEY: "inherited-must-not-cross",
        AWS_BEARER_TOKEN_BEDROCK: "inherited-must-not-cross",
      },
      codexHome: "/Users/test/.codex-accounts/work",
    });
    expect(environment.CODEX_HOME).toBe("/Users/test/.codex-accounts/work");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(environment.CODEX_API_KEY).toBeUndefined();
    expect(environment.AWS_BEARER_TOKEN_BEDROCK).toBeUndefined();
    expect(JSON.stringify(environment)).not.toMatch(/cli_auth_credentials_store|auth\.json/i);
  });

  it("keeps an extra account's thread state out of the host's database and the AWS profile out of every account", () => {
    const hostEnvironment = {
      PATH: "/usr/bin",
      CODEX_SQLITE_HOME: "/Users/test/.codex-state",
      AWS_PROFILE: "work",
      AWS_REGION: "eu-north-1",
    };

    const extra = codexAccountProcessEnvironment({
      binaryPath: "/opt/homebrew/bin/codex",
      hostEnvironment,
      codexHome: "/Users/test/.codex-accounts/work",
    });
    expect(extra.CODEX_SQLITE_HOME).toBeUndefined();
    expect(extra.AWS_PROFILE).toBeUndefined();
    expect(extra.AWS_REGION).toBe("eu-north-1");

    const first = codexAccountProcessEnvironment({
      binaryPath: "/opt/homebrew/bin/codex",
      hostEnvironment,
      codexHome: "/Users/test/.codex",
      inheritHostAuth: true,
    });
    expect(first.CODEX_SQLITE_HOME).toBe("/Users/test/.codex-state");
    expect(first.AWS_PROFILE).toBeUndefined();
  });

  it("injects only a broker-resolved API key after stripping inherited auth", () => {
    const environment = codexAccountProcessEnvironment({
      binaryPath: "/opt/homebrew/bin/codex",
      hostEnvironment: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "inherited-must-not-cross",
      },
      codexHome: "/Users/test/.codex-accounts/api",
      brokerApiKey: "broker-resolved-key",
    });
    expect(environment.OPENAI_API_KEY).toBe("broker-resolved-key");
    expect(environment.CODEX_HOME).toBe("/Users/test/.codex-accounts/api");
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
    expect(await failureOf(probeCodex("codex"))).toEqual({
      category: "invalid-configuration",
      message: "Codex binary path must be absolute.",
    });

    const root = mkdtempSync(join(tmpdir(), "octant-codex-invalid-"));
    directories.push(root);
    const binaryPath = join(root, "codex");
    writeFileSync(binaryPath, "not executable");
    expect((await failureOf(probeCodex(binaryPath))).category).toBe("invalid-configuration");
  });

  it("parses only the exact codex semantic version output", async () => {
    const valid = fixture("version");
    await expect(Effect.runPromise(probeCodex(valid.binaryPath))).resolves.toEqual({
      binaryPath: valid.binaryPath,
      version: "0.144.4",
    });

    const malformed = fixture("version-malformed");
    expect((await failureOf(probeCodex(malformed.binaryPath))).category).toBe("protocol");
  });

  it("accepts SemVer 2 prerelease and build metadata", async () => {
    const binaryPath = versionFixture("codex-cli 1.2.3-alpha.1+build.005");
    await expect(Effect.runPromise(probeCodex(binaryPath))).resolves.toEqual({
      binaryPath,
      version: "1.2.3-alpha.1+build.005",
    });
  });

  it("preserves a successful fast probe when receipt persistence loses the exit race", async () => {
    const binaryPath = versionFixture("codex-cli 0.144.4");
    await expect(
      Effect.runPromise(
        probeCodex(binaryPath, {
          onProcessStarted: async () => {
            throw new Error("receipt raced process exit");
          },
        }),
      ),
    ).resolves.toEqual({ binaryPath, version: "0.144.4" });
  });

  it("drains stdout that arrives after process exit before parsing the version", async () => {
    const delayed = fixture("version-delayed-output");
    await expect(Effect.runPromise(probeCodex(delayed.binaryPath))).resolves.toEqual({
      binaryPath: delayed.binaryPath,
      version: "0.144.4",
    });
    for (const pid of pids(delayed.root)) await expectMissing(pid);
  });

  it("rejects trailing output that arrives after process exit", async () => {
    const noisy = fixture("version-delayed-noise");
    const failure = await failureOf(probeCodex(noisy.binaryPath));
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
      const failure = await failureOf(probeCodex(target.binaryPath));
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
    const failure = await failureOf(probeCodex(versionFixture(output)));
    expect(failure).toEqual({
      category: "protocol",
      message: "Codex binary returned an unrecognized version.",
    });
  });

  it("bounds non-zero and timed-out probes and removes their process groups", async () => {
    const nonzero = fixture("version-nonzero");
    expect((await failureOf(probeCodex(nonzero.binaryPath))).category).toBe("unavailable");

    const timeout = fixture("version-timeout");
    const failure = await failureOf(
      probeCodex(timeout.binaryPath, { timeoutMs: 3_000, shutdownTimeoutMs: 50 }),
    );
    expect(failure).toEqual({
      category: "unavailable",
      message: "Codex binary probe timed out.",
    });
    for (const pid of await waitForPids(timeout.root, 2)) await expectMissing(pid);
  });
});

describe("codexAppServerArgs", () => {
  it("turns off Codex's own subagents and memories from the command line on every supported version", () => {
    const featureOverrides = [
      "-c",
      "features.multi_agent=false",
      "-c",
      "features.multi_agent_v2=false",
      "-c",
      "features.memories=false",
    ];
    // Before 0.145.0 the feature flags alone decide; `[agents]` holds role
    // tables there, so `agents.enabled` would parse as a role and fail startup.
    expect(codexAppServerArgs("0.144.6")).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...featureOverrides,
    ]);
    expect(codexAppServerArgs("0.145.0-alpha.1")).toEqual([
      "app-server",
      "--listen",
      "stdio://",
      ...featureOverrides,
    ]);
    // From 0.145.0 a model's catalog entry turns subagents on by itself, and
    // only `agents.enabled = false` outranks it.
    for (const version of ["0.145.0", "0.155.1", "1.0.0+build.7"]) {
      expect(codexAppServerArgs(version)).toEqual([
        "app-server",
        "--listen",
        "stdio://",
        ...featureOverrides,
        "-c",
        "agents.enabled=false",
      ]);
    }
  });
});

describe("CodexProcessPort", () => {
  it("creates an account home that does not exist yet before starting Codex", async () => {
    const target = fixture();
    const accountHome = join(target.root, "codex-accounts", "work");
    expect(existsSync(accountHome)).toBe(false);

    await Effect.runPromise(
      Effect.scoped(
        makePort()
          .start({
            binaryPath: target.binaryPath,
            authority: UNWRAPPED,
            environment: { ...process.env, CODEX_HOME: accountHome },
          })
          .pipe(Effect.asVoid),
      ),
    );

    // Codex refuses a missing home, so the folder must be there first, and
    // only its owner may read a folder that will hold a login.
    expect(statSync(accountHome).mode & 0o777).toBe(0o700);
  });

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
          .start({ binaryPath: target.binaryPath, authority: UNWRAPPED })
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
      args: [
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "features.multi_agent=false",
        "-c",
        "features.multi_agent_v2=false",
        "-c",
        "features.memories=false",
      ],
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
          capabilities: { experimentalApi: true, requestAttestation: false },
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
      Effect.scoped(
        makePort({ startupTimeoutMs: 50 }).start({
          binaryPath: timeout.binaryPath,
          authority: UNWRAPPED,
        }),
      ),
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
        }).start({ binaryPath: early.binaryPath, authority: UNWRAPPED }),
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
        }).start({ binaryPath: target.binaryPath, authority: UNWRAPPED }),
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
          .start({ binaryPath: target.binaryPath, authority: UNWRAPPED })
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
          .start({ binaryPath: target.binaryPath, authority: UNWRAPPED })
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
            authority: UNWRAPPED,
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
            authority: UNWRAPPED,
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
            makePort({ startupTimeoutMs: 10_000 }).start({
              binaryPath: target.binaryPath,
              authority: UNWRAPPED,
            }),
          );
          yield* Effect.promise(() => waitForPids(target.root, 2));
          yield* Fiber.interrupt(fiber);
        }),
      ),
    );
    for (const pid of pids(target.root)) await expectMissing(pid);
  });
});

describe("Codex launch confinement", () => {
  it("launches Full access as the program itself, with no profile around it", () => {
    const prepared = prepareCodexLaunch({
      binaryPath: "/bin/sh",
      args: ["-c", "true"],
      authority: { kind: "thread", root: tmpdir(), mode: "code", executionPolicy: "full-access" },
      environment: { HOME: homedir() },
      confinement: {
        prepare: () => {
          throw new Error("Full access must not be confined.");
        },
      },
      platform: process.platform,
    });
    expect(prepared.status === "prepared" ? prepared.launch.command : undefined).toBe("/bin/sh");
  });

  it("hands a Project's extra folders to the profile as the root's peers, at every wrapped level", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-codex-root-")));
    const extra = realpathSync(mkdtempSync(join(tmpdir(), "octant-codex-extra-")));
    const missing = join(extra, "removed-since");
    try {
      for (const executionPolicy of ["plan", "approval-gated"] as const) {
        let seen: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
        const prepared = prepareCodexLaunch({
          binaryPath: "/bin/sh",
          args: ["-c", "true"],
          authority: {
            kind: "thread",
            root,
            extraFolders: [extra, missing],
            mode: "code",
            executionPolicy,
          },
          environment: { HOME: homedir() },
          confinement: {
            prepare: (input) => {
              seen = input;
              return { command: input.executable, args: input.args };
            },
          },
          platform: process.platform,
        });
        if (prepared.status === "prepared") prepared.launch.release();
        expect(seen?.boundRoot).toBe(root);
        expect(seen?.extraBoundRoots).toEqual([extra]);
        expect(seen?.writeBoundRoot).toBe(executionPolicy !== "plan");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(extra, { recursive: true, force: true });
    }
  });

  // Real `sandbox-exec`: what a command run by Codex can reach is whatever the
  // app-server's own profile allows, because Codex runs its commands without a
  // sandbox of its own inside Octant's. The fixture sits under the real home,
  // since the profile's home rules are drawn from it.
  describe.skipIf(process.platform !== "darwin")("under Seatbelt", () => {
    const run = (
      executionPolicy: "plan" | "approval-gated",
      paths: { root: string; codexHome: string },
      script: string,
    ) => {
      const prepared = prepareCodexLaunch({
        binaryPath: "/bin/sh",
        args: ["-c", script],
        authority: { kind: "thread", root: paths.root, mode: "code", executionPolicy },
        environment: { HOME: homedir(), PATH: "/usr/bin:/bin", CODEX_HOME: paths.codexHome },
        confinement: makeProcessConfinementLive(),
        platform: "darwin",
      });
      if (prepared.status === "refused") return { status: 1, output: prepared.failure.message };
      try {
        const result = spawnSync(prepared.launch.command, [...prepared.launch.args], {
          cwd: prepared.launch.cwd,
          env: prepared.launch.environment,
          encoding: "utf8",
          timeout: 10_000,
        });
        return { status: result.status, output: `${result.stdout}${result.stderr}` };
      } finally {
        prepared.launch.release();
      }
    };

    it("refuses a command a file under HOME outside the thread's root and reads the root", () => {
      const planted = mkdtempSync(join(homedir(), ".octant-codex-hostile-"));
      try {
        const root = join(planted, "project");
        const codexHome = join(planted, "codex-home");
        const secret = join(planted, ".ssh", "id_fixture");
        mkdirSync(root);
        mkdirSync(codexHome, { mode: 0o700 });
        mkdirSync(join(planted, ".ssh"));
        writeFileSync(secret, "PLANTED-KEY\n");
        writeFileSync(join(root, "README.md"), "IN-ROOT\n");
        writeFileSync(join(codexHome, "config.toml"), "# account\n");

        for (const policy of ["plan", "approval-gated"] as const) {
          const outside = run(policy, { root, codexHome }, `cat '${secret}'`);
          expect(outside.status).not.toBe(0);
          expect(outside.output).not.toContain("PLANTED-KEY");

          const inside = run(policy, { root, codexHome }, `cat '${join(root, "README.md")}'`);
          expect(inside).toMatchObject({ status: 0, output: "IN-ROOT\n" });

          // The runtime keeps its sessions; what would change a later
          // thread's authority stays out of reach of a command.
          const account = run(
            policy,
            { root, codexHome },
            `echo state > '${join(codexHome, "state")}' && echo kept-state; echo '[mcp_servers.x]' >> '${join(codexHome, "config.toml")}' && echo wrote-config`,
          );
          expect(account.output).toContain("kept-state");
          expect(account.output).not.toContain("wrote-config");

          // An entry the account does not have yet cannot be planted either.
          const absent = run(
            policy,
            { root, codexHome },
            `echo K=v > '${join(codexHome, ".env")}' && echo made-env; mkdir '${join(codexHome, "skills")}' && echo made-skills`,
          );
          expect(absent.output).not.toContain("made-env");
          expect(absent.output).not.toContain("made-skills");
        }
        expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("# account\n");
        expect(existsSync(join(codexHome, ".env"))).toBe(false);
        expect(existsSync(join(codexHome, "skills"))).toBe(false);

        const write = `echo x > '${join(root, "written")}' && echo wrote-root`;
        expect(run("plan", { root, codexHome }, write).output).not.toContain("wrote-root");
        expect(run("approval-gated", { root, codexHome }, write).output).toContain("wrote-root");
      } finally {
        rmSync(planted, { recursive: true, force: true });
      }
    });
  });
});
