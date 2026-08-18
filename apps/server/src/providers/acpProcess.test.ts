import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  makeAcpConfinementLive,
  makeAcpProcessLive,
  probeAcpBinary,
  sanitizeAcpEnvironment,
  type AcpConfinementPort,
  type AcpProcessOptions,
} from "./acpProcess";
import { acpProviderProfiles, type AcpProviderProfile } from "./acpProfiles";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeAcpAgent.py", import.meta.url));
const directories: string[] = [];

const kilo = acpProviderProfiles.kilo;
const devin = acpProviderProfiles.devin;
const vibe = acpProviderProfiles["mistral-vibe"];
const kimi = acpProviderProfiles["kimi-code"];
const grok = acpProviderProfiles.grok;
const profiles = Object.values(acpProviderProfiles);
const denyDefaultProfiles = [kilo, devin, vibe, grok];

/** `--version` outputs per profile: [ready, too-old, malformed]. */
const versionOutputs: Record<AcpProviderProfile["kind"], readonly [string, string, string]> = {
  kilo: ["7.4.11", "0.9.9", "kilo release 7.4.11 extra"],
  devin: ["devin 3000.1.27 (0d4bf12e)", "devin 3000.1.26 (0d4bf12e)", "devin release 3000.1.27"],
  "mistral-vibe": ["vibe-acp 2.24.1", "vibe-acp 2.24.0", "mistral vibe release 2.24.1 extra"],
  "kimi-code": ["0.27.0", "0.25.9", "Kimi Code build 0.27.0 private-noise"],
  grok: [
    "grok 1.0.4 (d846eb93d94d)",
    "grok 0.9.9 (d846eb93d94d)",
    "grok build 1.0.4 private-noise",
  ],
};
const readyVersions: Record<AcpProviderProfile["kind"], string> = {
  kilo: "7.4.11",
  devin: "3000.1.27",
  "mistral-vibe": "2.24.1",
  "kimi-code": "0.27.0",
  grok: "1.0.4",
};

function fixture(profile: AcpProviderProfile, mode = "ready") {
  const root = mkdtempSync(join(tmpdir(), "octant-acp-"));
  directories.push(root);
  const binaryPath = join(root, "agent-fixture");
  const [ready, old, malformed] = versionOutputs[profile.kind];
  const versionOutput =
    mode === "version-old" ? old : mode === "version-malformed" ? malformed : ready;
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${versionOutput}'; exit 0; fi\nFAKE_ACP_MODE='${mode}' FAKE_ACP_ROOT='${root}' FAKE_ACP_AGENT_NAME='${profile.process.agentName}' exec /usr/bin/python3 '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  const sandboxPath = join(root, "sandbox-exec");
  writeFileSync(sandboxPath, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
  chmodSync(sandboxPath, 0o700);
  return { binaryPath, root, sandboxPath, canonicalRoot: realpathSync(root) };
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

function spawnRecord(root: string) {
  return records(root).find((record) => record.kind === "spawn") as
    | { args: string[]; cwd: string; environment: Record<string, string> }
    | undefined;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function failureOf<A>(effect: Effect.Effect<A, ProviderFailure, never>) {
  const either = await Effect.runPromise(Effect.either(effect));
  expect(Either.isLeft(either)).toBe(true);
  if (Either.isRight(either)) throw new Error("Expected a typed provider failure.");
  return either.left;
}

const passthroughConfinement: AcpConfinementPort = {
  prepare: (input) =>
    Effect.succeed({
      command: input.binaryPath,
      args: [],
      cwd: input.root,
      environment: input.environment,
    }),
};

function port(overrides: Partial<AcpProcessOptions> = {}) {
  return makeAcpProcessLive({
    confinement: passthroughConfinement,
    startupTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    ...overrides,
  });
}

beforeAll(() => chmodSync(fakeCliPath, 0o755));

afterAll(() => {
  for (const root of directories.splice(0)) {
    for (const record of records(root)) {
      if (record.kind !== "pid") continue;
      try {
        process.kill(-Number(record.pid), "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe.each(profiles)("ACP process boundary ($displayName)", (profile) => {
  it("forces feature denial and strips inherited credentials and executable authority", () => {
    const environment = sanitizeAcpEnvironment(
      profile,
      {
        PATH: "/usr/bin",
        HOME: "/Users/test",
        KIMI_CODE_HOME: "/Users/test/.kimi-code",
        KIMI_CODE_EXPERIMENTAL_FLAG: "danger",
        MISTRAL_API_KEY: "must-not-cross",
        MOONSHOT_API_KEY: "must-not-cross",
        ANTHROPIC_API_KEY: "must-not-cross",
        OCTANT_SECRET: "must-not-cross",
        NODE_OPTIONS: "--require private-hook",
        HTTPS_PROXY: "http://proxy.invalid",
      },
      { managedHome: "/private/tmp/octant-acp-home" },
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      ...(profile.process.passthroughVariables.includes("HOME") ? { HOME: "/Users/test" } : {}),
      ...profile.process.environment({
        managedHome: "/private/tmp/octant-acp-home",
        executionPolicy: "approval-gated",
      }),
      ...profile.process.guards,
    });
    expect(JSON.stringify(environment)).not.toContain("must-not-cross");
    expect(environment).not.toHaveProperty("NODE_OPTIONS");
    expect(environment).not.toHaveProperty("HTTPS_PROXY");
    expect(environment).not.toHaveProperty("KIMI_CODE_EXPERIMENTAL_FLAG");
  });

  it("probes exact supported versions and rejects older or malformed output", async () => {
    const ready = fixture(profile);
    await expect(Effect.runPromise(probeAcpBinary(profile, ready.binaryPath))).resolves.toEqual({
      binaryPath: ready.binaryPath,
      version: readyVersions[profile.kind],
    });
    const old = fixture(profile, "version-old");
    await expect(failureOf(probeAcpBinary(profile, old.binaryPath))).resolves.toEqual({
      category: "incompatible",
      message: `${profile.displayName} ${profile.process.minimumVersion.join(".")} or later is required.`,
    });
    const malformed = fixture(profile, "version-malformed");
    await expect(failureOf(probeAcpBinary(profile, malformed.binaryPath))).resolves.toMatchObject({
      category: "protocol",
    });
  }, 15_000);

  it("spawns the agent through confinement with a sanitized environment and negotiates ACP", async () => {
    const target = fixture(profile);
    const prepare = vi.fn(passthroughConfinement.prepare);
    const processPort = port({
      confinement: { prepare },
      inheritedEnvironment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        KIMI_CODE_HOME: "/Users/test/.kimi-code",
        OCTANT_SECRET: "remove",
        NODE_OPTIONS: "--require private-hook",
        HTTPS_PROXY: "http://proxy.invalid",
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* processPort.start({
            profile,
            binaryPath: target.binaryPath,
            root: target.root,
            managedHome: target.root,
            mode: "code",
            executionPolicy: "approval-gated",
          });
          expect(connection.version).toBe(readyVersions[profile.kind]);
          expect(connection.initialized.agentInfo?.name).toBe(profile.process.agentName);
          yield* Effect.promise(() =>
            expect.poll(() => spawnRecord(target.root) !== undefined).toBe(true),
          );
        }),
      ),
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        profile,
        binaryPath: target.binaryPath,
        root: target.root,
        managedHome: target.root,
        mode: "code",
        executionPolicy: "approval-gated",
      }),
    );
    const spawn = spawnRecord(target.root);
    expect(spawn).toMatchObject({ args: [], cwd: target.canonicalRoot });
    expect(spawn?.environment).toMatchObject(profile.process.guards);
    expect(spawn?.environment).toMatchObject(
      profile.process.environment({ managedHome: target.root, executionPolicy: "approval-gated" }),
    );
    for (const key of Object.keys(spawn?.environment ?? {})) {
      expect(key.startsWith("OCTANT_")).toBe(false);
    }
    expect(spawn?.environment).not.toHaveProperty("NODE_OPTIONS");
    expect(spawn?.environment).not.toHaveProperty("HTTPS_PROXY");
    expect(spawn?.environment).not.toHaveProperty("HTTP_PROXY");
  });
});

describe("ACP process lifecycle", () => {
  it("injects a Mistral Vibe API key only when selected", () => {
    const environment = sanitizeAcpEnvironment(
      vibe,
      { PATH: "/usr/bin", MISTRAL_API_KEY: "inherited-must-not-cross" },
      { managedHome: "/private/tmp/octant-acp-home", apiKey: "selected-key" },
    );
    expect(environment.MISTRAL_API_KEY).toBe("selected-key");
    expect(JSON.stringify({ ...environment, MISTRAL_API_KEY: "redacted" })).not.toContain(
      "selected-key",
    );
    expect(
      sanitizeAcpEnvironment(kilo, { PATH: "/usr/bin" }, { managedHome: "/x", apiKey: "k" }),
    ).not.toHaveProperty("MISTRAL_API_KEY");
  });

  it("preserves a fast version probe when receipt persistence loses the exit race", async () => {
    const target = fixture(kilo);
    await expect(
      Effect.runPromise(
        probeAcpBinary(kilo, target.binaryPath, {
          onProcessStarted: async () => {
            throw new Error("receipt raced process exit");
          },
        }),
      ),
    ).resolves.toEqual({ binaryPath: target.binaryPath, version: "7.4.11" });
  });

  it("refuses to spawn when the requested authority cannot be confined", async () => {
    const target = fixture(kimi);
    const confinement: AcpConfinementPort = {
      prepare: () =>
        Effect.fail({ category: "unavailable", message: "Confinement is unavailable." }),
    };
    const failure = await failureOf(
      Effect.scoped(
        port({ confinement }).start({
          profile: kimi,
          binaryPath: target.binaryPath,
          root: target.root,
          managedHome: join(target.canonicalRoot, "managed"),
          mode: "code",
          executionPolicy: "plan",
        }),
      ),
    );
    expect(failure.category).toBe("unavailable");
    expect(spawnRecord(target.root)).toBeUndefined();
  });

  it("persists process ownership before ACP initialization", async () => {
    const target = fixture(kilo);
    let releaseOwnership!: () => void;
    const ownershipReady = new Promise<void>((resolve) => {
      releaseOwnership = resolve;
    });
    const receipt = { ready: Promise.resolve(), remove: async () => undefined };
    let processCount = 0;
    const connectionPromise = Effect.runPromise(
      Effect.scoped(
        port().start({
          profile: kilo,
          binaryPath: target.binaryPath,
          root: target.root,
          managedHome: target.root,
          mode: "code",
          executionPolicy: "approval-gated",
          onProcessStarted: async () => {
            processCount += 1;
            if (processCount === 2) await ownershipReady;
            return receipt;
          },
        }),
      ),
    );

    await vi.waitFor(() => expect(spawnRecord(target.root)).toBeDefined());
    expect(records(target.root).some((record) => record.kind === "message")).toBe(false);
    releaseOwnership();
    await expect(connectionPromise).resolves.toMatchObject({
      initialized: { protocolVersion: 1 },
    });
  });

  it.each(["descendant", "stubborn-descendant"])(
    "terminates the owned %s process group without a global kill",
    async (mode) => {
      const target = fixture(kilo, mode);
      let pids: number[] = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* port().start({
              profile: kilo,
              binaryPath: target.binaryPath,
              root: target.root,
              managedHome: target.root,
              mode: "code",
              executionPolicy: "approval-gated",
            });
            yield* Effect.promise(() =>
              expect
                .poll(() => records(target.root).filter((record) => record.kind === "pid").length)
                .toBe(2),
            );
            pids = records(target.root)
              .filter((record) => record.kind === "pid")
              .map((record) => Number(record.pid));
          }),
        ),
      );
      await expect.poll(() => pids.every((pid) => !isRunning(pid)), { timeout: 3_000 }).toBe(true);
    },
  );
});

describe.each(denyDefaultProfiles)("ACP deny-default confinement ($displayName)", (profile) => {
  function confinement(target: ReturnType<typeof fixture>, temporary = true) {
    return makeAcpConfinementLive({
      platform: "darwin",
      sandboxPath: target.sandboxPath,
      ...(temporary ? { temporaryDirectory: join(target.canonicalRoot, "tmp") } : {}),
      hostAuthenticationPath: join(target.canonicalRoot, "host-auth"),
    });
  }

  it("uses Seatbelt for bounded modes and bypasses it only for explicit Full access", async () => {
    const target = fixture(profile);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const hostAuthentication = profile.process.hostAuthentication;
    if (hostAuthentication?.kind === "credential-file") {
      writeFileSync(join(target.canonicalRoot, "host-auth"), "fixture-only\n", { mode: 0o600 });
    }
    const bounded = await Effect.runPromise(
      confinement(target).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
        environment: { PATH: "/usr/bin" },
      }),
    );
    const args = profile.process.args({ root: target.canonicalRoot, managedHome });
    expect(bounded.command).toBe(target.sandboxPath);
    expect(bounded.args.slice(-(args.length + 1))).toEqual([target.binaryPath, ...args]);
    const seatbelt = bounded.args[1]!;
    expect(seatbelt).toContain(`(allow file-write* (subpath "${target.canonicalRoot}"))`);
    expect(seatbelt).toContain(`(allow file-write* (subpath "${managedHome}"))`);
    expect(seatbelt).toContain(`(deny file-read* (subpath "${realpathSync(homedir())}"))`);
    if (hostAuthentication?.kind === "directory") {
      const hostAuth = join(target.canonicalRoot, "host-auth");
      expect(seatbelt).toContain(`(allow file-read* (subpath "${hostAuth}"))`);
      expect(seatbelt).toContain(`(allow file-write* (subpath "${hostAuth}"))`);
    }
    if (hostAuthentication?.kind === "credential-file") {
      const hostAuth = join(target.canonicalRoot, "host-auth");
      expect(seatbelt).toContain(`(allow file-read* (subpath "${hostAuth}"))`);
      expect(seatbelt).not.toContain(`(allow file-write* (subpath "${hostAuth}"))`);
      expect(realpathSync(join(managedHome, hostAuthentication.managedRelativePath))).toBe(
        hostAuth,
      );
    }
    for (const file of profile.process.managedFiles({
      managedHome,
      executionPolicy: "approval-gated",
    })) {
      expect(readFileSync(file.path, "utf8")).toBe(file.content);
    }

    const fullAccess = await Effect.runPromise(
      confinement(target).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "full-access",
        environment: { PATH: "/usr/bin" },
      }),
    );
    expect(fullAccess).toMatchObject({ command: target.binaryPath, args });
    for (const file of profile.process.managedFiles({
      managedHome,
      executionPolicy: "full-access",
    })) {
      expect(readFileSync(file.path, "utf8")).toBe(file.content);
    }
  });

  it("requires an existing Project root without creating or chmodding it", async () => {
    const target = fixture(profile);
    const missingRoot = join(target.canonicalRoot, "missing-project");
    const result = await failureOf(
      confinement(target, false).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: missingRoot,
        managedHome: join(target.canonicalRoot, "managed-home"),
        mode: "code",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    expect(result).toMatchObject({ category: "invalid-configuration" });
    expect(existsSync(missingRoot)).toBe(false);
  });

  it("creates the managed home before using it as the root for auth and probe sessions", async () => {
    const target = fixture(profile);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const launch = await Effect.runPromise(
      confinement(target, false).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: managedHome,
        managedHome,
        mode: "chat",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    expect(launch.cwd).toBe(managedHome);
    expect(existsSync(managedHome)).toBe(true);
  });

  it("keeps Plan read-only and fails closed off macOS", async () => {
    const target = fixture(profile);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const plan = await Effect.runPromise(
      confinement(target).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "plan",
        environment: {},
      }),
    );
    expect(plan.args[1]).not.toContain(`(allow file-write* (subpath "${target.canonicalRoot}"))`);
    expect(plan.args[1]).toContain(`(allow file-read* (subpath "${target.canonicalRoot}"))`);

    const unsupported = await failureOf(
      makeAcpConfinementLive({ platform: "linux" }).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(unsupported.category).toBe("incompatible");
  });
});

describe("Kilo provider-owned data directory", () => {
  it("fails closed as unauthenticated when the host data directory is missing", async () => {
    const target = fixture(kilo);
    const failure = await failureOf(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
      }).prepare({
        profile: {
          ...kilo,
          process: {
            ...kilo.process,
            hostAuthentication: {
              kind: "directory",
              defaultPath: join(target.canonicalRoot, "absent-provider-data"),
              loginHint: "Run kilo auth login, then retry.",
            },
          },
        },
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome: join(target.canonicalRoot, "managed-home"),
        mode: "code",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(failure).toEqual({
      category: "unauthenticated",
      message:
        "Kilo provider-owned authentication is unavailable. Run kilo auth login, then retry.",
    });
  });
});

describe("Kimi Code immutable managed profile", () => {
  function confinement(target: ReturnType<typeof fixture>, temporaryDirectory?: string) {
    return makeAcpConfinementLive({
      platform: "darwin",
      sandboxPath: target.sandboxPath,
      ...(temporaryDirectory === undefined ? {} : { temporaryDirectory }),
    });
  }

  it("creates an isolated managed profile with immutable static tool denials", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const launch = await Effect.runPromise(
      confinement(target, target.canonicalRoot).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "full-access",
        environment: {
          PATH: "/usr/bin",
          HOME: "/Users/test",
          KIMI_CODE_HOME: "/Users/test/.kimi-code",
        },
      }),
    );

    expect(launch.cwd).toBe(target.canonicalRoot);
    expect(launch.args.at(-1)).toBe("acp");
    expect(launch.environment).toMatchObject({
      HOME: join(managedHome, "home"),
      KIMI_CODE_HOME: managedHome,
      TMPDIR: target.canonicalRoot,
    });
    expect(launch.args[1]).toContain("(allow default)");
    expect(launch.args[1]).toContain(
      `(deny file-write* (subpath "${join(managedHome, "config.toml")}"))`,
    );
    expect(launch.args[1]).toContain(
      `(deny file-read* (subpath "${join(target.canonicalRoot, ".agents")}"))`,
    );
    const configuration = readFileSync(join(managedHome, "config.toml"), "utf8");
    for (const tool of [
      "Skill",
      "Agent",
      "AgentSwarm",
      "CreateGoal",
      "GetGoal",
      "SetGoalBudget",
      "UpdateGoal",
      "TaskList",
      "TaskOutput",
      "TaskStop",
    ]) {
      expect(configuration).toContain(`pattern = "${tool}"`);
    }
    expect(configuration).toContain('decision = "deny"');
    expect(configuration).toContain("telemetry = false");
  });

  it("rejects managed extension content and a mutated generated policy", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const input = {
      profile: kimi,
      binaryPath: target.binaryPath,
      root: target.canonicalRoot,
      managedHome,
      mode: "code" as const,
      executionPolicy: "approval-gated" as const,
      environment: { PATH: "/usr/bin" },
    };
    const prepared = confinement(target, join(target.canonicalRoot, "sandbox-tmp"));
    await Effect.runPromise(prepared.prepare(input));

    mkdirSync(join(managedHome, "skills"));
    expect(await failureOf(prepared.prepare(input))).toEqual({
      category: "incompatible",
      message: "Kimi Code managed profile contains forbidden executable configuration.",
    });
    rmSync(join(managedHome, "skills"), { recursive: true });

    chmodSync(join(managedHome, "config.toml"), 0o644);
    expect((await failureOf(prepared.prepare(input))).category).toBe("incompatible");
    chmodSync(join(managedHome, "config.toml"), 0o600);

    writeFileSync(join(managedHome, "config.toml"), "telemetry = true\n");
    expect((await failureOf(prepared.prepare(input))).category).toBe("incompatible");
  });

  it("builds exact-root approval, read-only plan, and read-only chat Seatbelt profiles", async () => {
    const target = fixture(kimi);
    const root = target.canonicalRoot;
    const prepared = confinement(target, join(root, "sandbox-tmp"));
    const approval = await Effect.runPromise(
      prepared.prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root,
        managedHome: join(root, "managed-approval"),
        mode: "code",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(approval.args[1]).toContain("(deny default)");
    expect(approval.args[1]).toContain(`(allow file-read* (subpath "${root}"))`);
    expect(approval.args[1]).toContain(`(allow file-write* (subpath "${root}"))`);
    expect(approval.args[1]).toContain("(allow process-fork)");
    expect(approval.args[1]).not.toContain("(allow default)");

    for (const [mode, executionPolicy] of [
      ["code", "plan"],
      ["chat", "approval-gated"],
    ] as const) {
      const launch = await Effect.runPromise(
        prepared.prepare({
          profile: kimi,
          binaryPath: target.binaryPath,
          root,
          managedHome: join(root, `managed-${mode}-${executionPolicy}`),
          mode,
          executionPolicy,
          environment: {},
        }),
      );
      expect(launch.args[1]).toContain("(deny default)");
      expect(launch.args[1]).not.toContain(`(allow file-write* (subpath "${root}"))`);
      expect(launch.args[1]).not.toContain("(allow process-fork)");
    }
  });

  it("fails closed on unsupported hosts and non-canonical roots", async () => {
    const target = fixture(kimi);
    const unsupported = await failureOf(
      makeAcpConfinementLive({ platform: "linux" }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome: join(target.canonicalRoot, "managed-kimi"),
        mode: "code",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    expect(unsupported.category).toBe("incompatible");
    const invalidRoot = await failureOf(
      confinement(target).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: `${target.root}/..`,
        managedHome: join(target.canonicalRoot, "managed-kimi"),
        mode: "code",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    expect(invalidRoot.category).toBe("invalid-configuration");
  });

  it("starts the fake ACP runtime through the explicit Full Access Seatbelt profile", async () => {
    const target = fixture(kimi);
    const root = target.canonicalRoot;
    const processPort = makeAcpProcessLive({
      confinement: confinement(target, join(root, "sandbox-tmp")),
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 200,
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* processPort.start({
            profile: kimi,
            binaryPath: target.binaryPath,
            root,
            managedHome: join(root, "managed-seatbelt"),
            mode: "code",
            executionPolicy: "full-access",
          });
          expect(connection.initialized.agentInfo?.name).toBe("Kimi Code CLI");
        }),
      ),
    );
    expect(spawnRecord(target.root)).toMatchObject({ args: ["acp"], cwd: root });
  });
});
