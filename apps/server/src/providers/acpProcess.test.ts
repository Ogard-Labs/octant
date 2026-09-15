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
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
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
const opencode = acpProviderProfiles.opencode;
const devin = acpProviderProfiles.devin;
const vibe = acpProviderProfiles["mistral-vibe"];
const kimi = acpProviderProfiles["kimi-code"];
const grok = acpProviderProfiles.grok;
const goose = acpProviderProfiles.goose;
const glm = acpProviderProfiles.glm;
const gemini = acpProviderProfiles.gemini;
const copilot = acpProviderProfiles.copilot;
const cline = acpProviderProfiles.cline;
const qwen = acpProviderProfiles.qwen;
const profiles = Object.values(acpProviderProfiles).filter(
  (profile) => profile.kind !== "opencode",
);
const denyDefaultProfiles = [kilo, devin, vibe, grok, goose, glm, gemini, copilot, cline, qwen];

/** `--version` outputs per profile: [ready, too-old, malformed]. */
const versionOutputs: Record<AcpProviderProfile["kind"], readonly [string, string, string]> = {
  opencode: ["opencode2 v0.0.0-beta-18721", "opencode2 v0.0.0-beta-18720", "opencode2 preview"],
  kilo: ["7.4.11", "0.9.9", "kilo release 7.4.11 extra"],
  devin: ["devin 3000.1.27 (0d4bf12e)", "devin 3000.1.26 (0d4bf12e)", "devin release 3000.1.27"],
  "mistral-vibe": ["vibe-acp 2.24.1", "vibe-acp 2.24.0", "mistral vibe release 2.24.1 extra"],
  "kimi-code": ["0.27.0", "0.25.9", "Kimi Code build 0.27.0 private-noise"],
  grok: [
    "grok 1.0.4 (d846eb93d94d)",
    "grok 0.9.9 (d846eb93d94d)",
    "grok build 1.0.4 private-noise",
  ],
  goose: ["1.48.0", "1.47.9", "goose release 1.48.0 private-noise"],
  glm: ["1.8.0", "1.7.9", "glm-acp-agent 1.8.0 private-noise"],
  gemini: ["0.58.0", "0.57.9", "gemini-cli release 0.58.0 private-noise"],
  copilot: [
    "GitHub Copilot CLI 1.0.82.",
    "GitHub Copilot CLI 1.0.81.",
    "GitHub Copilot CLI 1.0.82. trailing-noise",
  ],
  cline: ["3.0.61", "3.0.60", "cline release 3.0.61 private-noise"],
  qwen: ["0.23.0", "0.22.9", "qwen-code release 0.23.0 private-noise"],
};
const readyVersions: Record<AcpProviderProfile["kind"], string> = {
  opencode: "0.0.0",
  kilo: "7.4.11",
  devin: "3000.1.27",
  "mistral-vibe": "2.24.1",
  "kimi-code": "0.27.0",
  grok: "1.0.4",
  goose: "1.48.0",
  glm: "1.8.0",
  gemini: "0.58.0",
  copilot: "1.0.82",
  cline: "3.0.61",
  qwen: "0.23.0",
};

function fixture(profile: AcpProviderProfile, mode = "ready") {
  const root = mkdtempSync(join(tmpdir(), "octant-acp-"));
  directories.push(root);
  const binaryPath = join(root, "agent-fixture");
  const [ready, old, malformed] = versionOutputs[profile.kind];
  const versionOutput =
    mode === "version-old" ? old : mode === "version-malformed" ? malformed : ready;
  if (profile.process.npmPackageName !== undefined) {
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: profile.process.npmPackageName, version: versionOutput })}\n`,
    );
  }
  writeFileSync(
    binaryPath,
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf '%s\\n' '${versionOutput}'; exit 0; fi\nif [ '${mode}' = 'startup-argument-error' ]; then printf '%s\\n' 'error: unexpected argument --private-token=must-not-cross' >&2; exit 2; fi\nFAKE_ACP_MODE='${mode}' FAKE_ACP_ROOT='${root}' FAKE_ACP_AGENT_NAME='${profile.process.agentName}' exec /usr/bin/python3 '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  const sandboxPath = join(root, "sandbox-exec");
  writeFileSync(sandboxPath, '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o700 });
  chmodSync(sandboxPath, 0o700);
  const bwrapPath = join(root, "bwrap");
  writeFileSync(bwrapPath, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  chmodSync(bwrapPath, 0o700);
  return { binaryPath, root, sandboxPath, bwrapPath, canonicalRoot: realpathSync(root) };
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
    // The process suite runs profiles in parallel under the monorepo test
    // load. Keep fixture startup tolerant of scheduler contention; production
    // uses the separate 10s default in acpProcess.ts.
    startupTimeoutMs: 2_000,
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
  it("reports a bounded classified diagnostic when the provider rejects startup arguments", async () => {
    const target = fixture(devin, "startup-argument-error");
    const result = await failureOf(
      Effect.scoped(
        port({ confinement: passthroughConfinement }).start({
          profile: devin,
          binaryPath: target.binaryPath,
          root: target.root,
          managedHome: target.root,
          mode: "code",
          executionPolicy: "approval-gated",
        }),
      ),
    );

    expect(result).toMatchObject({
      category: "unavailable",
      diagnostic: {
        stage: "initialization",
        kind: "exited",
        exitCode: 2,
        detectedVersion: readyVersions.devin,
        stderrContext: "Provider process rejected its configured arguments.",
      },
    });
    expect(JSON.stringify(result)).not.toContain("must-not-cross");
  });

  it("uses Devin's supported ACP launch flags", () => {
    const managedHome = "/private/tmp/octant-devin-home";
    expect(devin.process.args({ root: "/private/tmp/octant-root", managedHome })).toEqual([
      "--config",
      join(managedHome, ".config/devin/config.json"),
      "--respect-workspace-trust",
      "true",
      "--permission-mode",
      "auto",
      "acp",
    ]);
    const files = devin.process.managedFiles({
      managedHome,
      executionPolicy: "approval-gated",
    });
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: join(managedHome, ".config/devin/mcp_config.json") }),
      ]),
    );
    expect(files.map((file) => file.path)).not.toContain(
      join(managedHome, ".config/devin/octant-agent.json"),
    );
    expect(files.find((file) => file.path.endsWith("/config.json"))?.content).toContain(
      '"subagents_enabled": false',
    );
  });

  it("does not send the unsupported session close method to Devin", () => {
    expect(devin.closesSessions).toBe(false);
  });

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
        // This test deliberately waits for the second ownership callback
        // before allowing initialization to continue. Keep enough startup
        // budget for the fixture process when the full server suite is busy;
        // production startup defaults stay unchanged.
        port({ startupTimeoutMs: 5_000 }).start({
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

    // Observe failures immediately even while the test waits for the fixture
    // to start; always release the held receipt before deleting its directory.
    void connectionPromise.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(spawnRecord(target.root)).toBeDefined(), { timeout: 5_000 });
      expect(records(target.root).some((record) => record.kind === "message")).toBe(false);
      releaseOwnership();
      await expect(connectionPromise).resolves.toMatchObject({
        initialized: { protocolVersion: 1 },
      });
    } finally {
      releaseOwnership();
      await connectionPromise.catch(() => undefined);
    }
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

describe("ACP child-server profiles", () => {
  it("describes the beta OpenCode ACP launch and keeps structured questions unsupported", () => {
    expect(opencode.process.args({ root: "/tmp/project", managedHome: "/tmp/managed" })).toEqual([
      "acp",
    ]);
    expect(opencode.process.versionPattern.test("opencode2 v0.0.0-beta-18721")).toBe(true);
    expect(opencode.userQuestions).toBe("unsupported");
    const environment = sanitizeAcpEnvironment(
      opencode,
      { PATH: "/usr/bin" },
      { managedHome: "/tmp/managed" },
    );
    const expectedConfig =
      [
        join(homedir(), ".config/opencode/opencode.jsonc"),
        join(homedir(), ".config/opencode/opencode.json"),
      ].find((path) => existsSync(path)) ?? join(homedir(), ".config/opencode/opencode.jsonc");
    expect(environment).toMatchObject({
      OPENCODE_CONFIG: expectedConfig,
      OPENCODE_CONFIG_DIR: "/tmp/managed/config",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_PURE: "1",
    });
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "{}")).toMatchObject({
      permissions: expect.arrayContaining([
        { action: "external_directory", effect: "deny", resource: "*" },
        { action: "skill", effect: "deny", resource: "*" },
      ]),
    });
  });

  it("refuses chat and plan before spawning a nested OpenCode server", async () => {
    const target = fixture(opencode);
    const confinement = makeAcpConfinementLive({
      platform: "darwin",
      sandboxPath: target.sandboxPath,
      temporaryDirectory: join(target.canonicalRoot, "tmp"),
      hostAuthenticationPath: join(target.canonicalRoot, "host-auth"),
    });
    for (const [mode, executionPolicy] of [
      ["chat", "approval-gated"],
      ["code", "plan"],
    ] as const) {
      const result = await failureOf(
        confinement.prepare({
          profile: opencode,
          binaryPath: target.binaryPath,
          root: target.canonicalRoot,
          managedHome: join(target.canonicalRoot, "managed-home"),
          mode,
          executionPolicy,
          environment: { PATH: "/usr/bin" },
        }),
      );
      expect(result).toEqual({
        category: "incompatible",
        message:
          "OpenCode 2 cannot run in Chat or Plan mode because its ACP entrypoint requires a child server; use Code or Work mode.",
      });
    }
  });

  it("reads the existing user configuration without granting it write access", async () => {
    const target = fixture(opencode);
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: join(target.canonicalRoot, "host-auth"),
      }).prepare({
        profile: opencode,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome: join(target.canonicalRoot, "managed-home"),
        mode: "code",
        executionPolicy: "approval-gated",
        environment: { PATH: "/usr/bin" },
      }),
    );
    const hostConfigs = [
      join(homedir(), ".config/opencode/opencode.jsonc"),
      join(homedir(), ".config/opencode/opencode.json"),
    ].filter((path) => existsSync(path));
    for (const hostConfig of hostConfigs) {
      const canonical = realpathSync(hostConfig);
      expect(launch.args[1]).toContain(`(allow file-read* (subpath "${canonical}"))`);
      expect(launch.args[1]).not.toContain(`(allow file-write* (subpath "${canonical}"))`);
    }
  });
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

  it("keeps Plan read-only on macOS and uses Bubblewrap on Linux", async () => {
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
    expect(plan.args[1]).not.toContain("(allow process-exec)");
    expect(plan.args[1]).not.toContain("(allow process-fork)");
    expect(plan.args[1]).toContain(`(allow file-read* (subpath "${target.canonicalRoot}"))`);

    const chat = await Effect.runPromise(
      confinement(target).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome: join(target.canonicalRoot, "managed-chat"),
        mode: "chat",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(chat.args[1]).not.toContain(`(allow file-write* (subpath "${target.canonicalRoot}"))`);

    const hostAuth = join(target.canonicalRoot, "host-auth");
    if (profile.process.hostAuthentication?.kind === "directory") {
      mkdirSync(hostAuth, { recursive: true });
    } else if (profile.process.hostAuthentication?.kind === "credential-file") {
      writeFileSync(hostAuth, "", { mode: 0o600 });
    }
    const linux = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "linux",
        sandboxPath: target.bwrapPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        ...(profile.process.hostAuthentication === undefined
          ? {}
          : { hostAuthenticationPath: hostAuth }),
      }).prepare({
        profile,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(linux.command).toBe(target.bwrapPath);
    expect(linux.args).toContain("--unshare-all");
    expect(linux.args).toContain("--");
    expect(linux.args).toContain(target.binaryPath);
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

const directoryHostProfiles = Object.values(acpProviderProfiles).filter(
  (profile) => profile.process.hostAuthentication?.kind === "directory",
);
const apiKeyVariables: Partial<Record<AcpProviderProfile["kind"], string>> = {
  grok: "XAI_API_KEY",
  glm: "Z_AI_API_KEY",
  gemini: "GEMINI_API_KEY",
  cline: "CLINE_API_KEY",
  qwen: "OPENAI_API_KEY",
  "mistral-vibe": "MISTRAL_API_KEY",
};

function directoryHostAuthentication(profile: AcpProviderProfile) {
  const auth = profile.process.hostAuthentication;
  expect(auth?.kind).toBe("directory");
  if (auth?.kind !== "directory") {
    throw new Error("Expected a directory host profile.");
  }
  return auth;
}

function nativeHostProfilePath(hostHome: string, profile: AcpProviderProfile): string {
  return join(hostHome, relative(homedir(), directoryHostAuthentication(profile).defaultPath));
}

function seatbeltProfile(launch: { readonly args: ReadonlyArray<string> }): string {
  const profile = launch.args[1];
  expect(typeof profile).toBe("string");
  return typeof profile === "string" ? profile : "";
}

function seatbeltLines(launch: { readonly args: ReadonlyArray<string> }): ReadonlyArray<string> {
  return seatbeltProfile(launch).split("\n");
}

describe.each(directoryHostProfiles)("ACP host-profile contract ($displayName)", (profile) => {
  async function prepareHostLaunch(input: {
    readonly executionPolicy: ProviderExecutionPolicy;
    readonly apiKey?: string;
    readonly hostPresent?: boolean;
  }) {
    const target = fixture(profile);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const requestedHostPath = nativeHostProfilePath(hostHome, profile);
    if (input.hostPresent !== false) mkdirSync(requestedHostPath, { recursive: true });
    const hostAuthenticationPath =
      input.hostPresent === false ? requestedHostPath : realpathSync(requestedHostPath);
    const environment = sanitizeAcpEnvironment(
      profile,
      { PATH: "/usr/bin", HOME: "/Users/octant-test" },
      {
        managedHome,
        executionPolicy: input.executionPolicy,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      },
    );
    const result = await Effect.runPromise(
      Effect.either(
        makeAcpConfinementLive({
          platform: "darwin",
          sandboxPath: target.sandboxPath,
          temporaryDirectory: join(target.canonicalRoot, "tmp"),
          ...(input.hostPresent === false
            ? {}
            : { hostAuthenticationPath: hostAuthenticationPath }),
        }).prepare({
          profile:
            input.hostPresent === false
              ? {
                  ...profile,
                  process: {
                    ...profile.process,
                    hostAuthentication: {
                      kind: "directory",
                      defaultPath: hostAuthenticationPath,
                      loginHint: directoryHostAuthentication(profile).loginHint,
                      ...(directoryHostAuthentication(profile).environment === undefined
                        ? {}
                        : {
                            environment: directoryHostAuthentication(profile).environment,
                          }),
                    },
                  },
                }
              : profile,
          binaryPath: target.binaryPath,
          root: target.canonicalRoot,
          managedHome,
          mode: "code",
          executionPolicy: input.executionPolicy,
          environment,
        }),
      ),
    );
    return { target, managedHome, hostHome, hostAuthenticationPath, environment, result };
  }

  it("points the child at the native profile without granting the real home", async () => {
    const prepared = await prepareHostLaunch({ executionPolicy: "approval-gated" });
    expect(Either.isRight(prepared.result)).toBe(true);
    if (Either.isLeft(prepared.result)) throw new Error("Expected a confined host-profile launch.");
    const launch = prepared.result.right;
    const hostEnv =
      directoryHostAuthentication(profile).environment?.(prepared.hostAuthenticationPath) ?? {};
    expect(launch.environment).toMatchObject(hostEnv);
    expect(launch.environment.HOME).not.toBe(prepared.hostHome);
    expect(launch.environment.HOME).not.toBe(homedir());
    expect(launch.command).toBe(prepared.target.sandboxPath);
    const lines = seatbeltLines(launch);
    expect(lines).toContain(`(allow file-read* (subpath "${prepared.hostAuthenticationPath}"))`);
    expect(lines).toContain(`(allow file-write* (subpath "${prepared.hostAuthenticationPath}"))`);
    expect(lines).toContain(`(allow file-write* (subpath "${prepared.managedHome}"))`);
    expect(lines).not.toContain(`(allow file-write* (subpath "${prepared.hostHome}"))`);
    expect(lines).not.toContain(`(allow file-write* (subpath "${homedir()}"))`);
    const configParent = dirname(prepared.hostAuthenticationPath);
    if (configParent !== prepared.hostAuthenticationPath) {
      expect(lines).not.toContain(`(allow file-write* (subpath "${configParent}"))`);
    }
  });

  it("refuses to launch when the native profile directory is missing", async () => {
    const prepared = await prepareHostLaunch({
      executionPolicy: "approval-gated",
      hostPresent: false,
    });
    expect(prepared.result).toEqual(
      Either.left({
        category: "unauthenticated",
        message: `${profile.displayName} provider-owned authentication is unavailable. ${directoryHostAuthentication(profile).loginHint}`,
      }),
    );
  });

  it("keeps the native profile environment for explicit Full access", async () => {
    const prepared = await prepareHostLaunch({ executionPolicy: "full-access" });
    expect(Either.isRight(prepared.result)).toBe(true);
    if (Either.isLeft(prepared.result))
      throw new Error("Expected a Full access host-profile launch.");
    const launch = prepared.result.right;
    const hostEnv =
      directoryHostAuthentication(profile).environment?.(prepared.hostAuthenticationPath) ?? {};
    const deniesHostExtensions =
      (profile.process.hostDeniedEntries?.length ?? 0) > 0 ||
      (profile.process.forbiddenRootEntries?.length ?? 0) > 0 ||
      (profile.process.hostAuthentication?.kind === "directory" &&
        (profile.process.hostAuthentication.forbiddenEntries?.length ?? 0) > 0);
    expect(launch.command).toBe(
      deniesHostExtensions ? prepared.target.sandboxPath : prepared.target.binaryPath,
    );
    expect(launch.environment).toMatchObject(hostEnv);
    expect(launch.environment.HOME).not.toBe(prepared.hostHome);
    expect(launch.environment.HOME).not.toBe(homedir());
  });

  it("injects an API key only when that mode is selected", async () => {
    const variable = apiKeyVariables[profile.kind];
    const withoutKey = await prepareHostLaunch({ executionPolicy: "approval-gated" });
    expect(Either.isRight(withoutKey.result)).toBe(true);
    if (Either.isLeft(withoutKey.result)) throw new Error("Expected a host-profile launch.");
    if (variable === undefined) {
      expect(JSON.stringify(withoutKey.result.right.environment)).not.toContain("selected-key");
      return;
    }
    expect(withoutKey.result.right.environment[variable]).toBeUndefined();
    const withKey = await prepareHostLaunch({
      executionPolicy: "approval-gated",
      apiKey: "selected-key",
    });
    expect(Either.isRight(withKey.result)).toBe(true);
    if (Either.isLeft(withKey.result)) throw new Error("Expected an API-key host-profile launch.");
    expect(withKey.result.right.environment[variable]).toBe("selected-key");
    const redacted = { ...withKey.result.right.environment, [variable]: "redacted" };
    expect(JSON.stringify(redacted)).not.toContain("selected-key");
  });
});

describe("Grok Build consumed configuration", () => {
  it("applies documented process overlays against GROK_HOME instead of an unread managed config", async () => {
    const target = fixture(grok);
    const managedHome = join(target.canonicalRoot, "managed-grok");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const hostAuthenticationPath = join(hostHome, ".grok");
    mkdirSync(hostAuthenticationPath, { recursive: true });
    const canonicalHostPath = realpathSync(hostAuthenticationPath);
    const environment = sanitizeAcpEnvironment(
      grok,
      { PATH: "/usr/bin", HOME: "/Users/octant-test" },
      { managedHome, executionPolicy: "approval-gated" },
    );
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: canonicalHostPath,
      }).prepare({
        profile: grok,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
        environment,
      }),
    );

    expect(launch.environment.GROK_HOME).toBe(canonicalHostPath);
    expect(launch.environment.GROK_HOME).not.toBe(managedHome);
    expect(launch.environment.GROK_DISABLE_AUTOUPDATER).toBe("1");
    expect(JSON.parse(launch.environment.GROK_CONFIG ?? "{}")).toEqual({
      features: {
        telemetry: false,
        feedback: false,
        codebase_indexing: false,
        remote_fetch: false,
      },
    });
    expect(existsSync(join(managedHome, "config.toml"))).toBe(false);
  });
});

describe("Kimi Code host-profile extension surfaces", () => {
  it("denies reused MCP, skills, plugins, and hooks after granting the native profile", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const hostAuthenticationPath = join(hostHome, ".kimi-code");
    mkdirSync(join(hostAuthenticationPath, "skills"), { recursive: true });
    mkdirSync(join(hostAuthenticationPath, "plugins"), { recursive: true });
    mkdirSync(join(hostAuthenticationPath, "hooks"), { recursive: true });
    mkdirSync(join(hostAuthenticationPath, "credentials"), { recursive: true });
    writeFileSync(join(hostAuthenticationPath, "mcp.json"), "{}\n");
    writeFileSync(join(hostAuthenticationPath, "AGENTS.md"), "hostile\n");
    writeFileSync(join(hostAuthenticationPath, "config.toml"), "telemetry = false\n");
    const canonicalHostPath = realpathSync(hostAuthenticationPath);
    mkdirSync(join(target.canonicalRoot, ".kimi-code"));
    mkdirSync(join(target.canonicalRoot, ".agents"));
    const environment = sanitizeAcpEnvironment(
      kimi,
      { PATH: "/usr/bin", HOME: "/Users/octant-test" },
      { managedHome, executionPolicy: "approval-gated" },
    );
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: canonicalHostPath,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
        environment,
      }),
    );

    expect(launch.environment.KIMI_CODE_HOME).toBe(canonicalHostPath);
    const profileText = seatbeltProfile(launch);
    const allowHost = profileText.lastIndexOf(
      `(allow file-read* (subpath "${canonicalHostPath}"))`,
    );
    expect(allowHost).toBeGreaterThan(-1);
    for (const entry of ["mcp.json", "skills", "plugins", "hooks", "AGENTS.md"]) {
      const denied = join(canonicalHostPath, entry);
      const denyRead = profileText.lastIndexOf(`(deny file-read* (subpath "${denied}"))`);
      const denyWrite = profileText.lastIndexOf(`(deny file-write* (subpath "${denied}"))`);
      expect(denyRead).toBeGreaterThan(allowHost);
      expect(denyWrite).toBeGreaterThan(allowHost);
    }
    expect(profileText).not.toContain(
      `(deny file-read* (subpath "${join(canonicalHostPath, "config.toml")}"))`,
    );
    expect(profileText).not.toContain(
      `(deny file-read* (subpath "${join(canonicalHostPath, "credentials")}"))`,
    );
    expect(profileText).toContain(
      `(deny file-read* (subpath "${join(target.canonicalRoot, ".kimi-code")}"))`,
    );
    expect(profileText).toContain(
      `(deny file-read* (subpath "${join(target.canonicalRoot, ".agents")}"))`,
    );
  });

  it("still denies reused MCP, skills, plugins, and hooks under Full access", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const hostAuthenticationPath = join(hostHome, ".kimi-code");
    mkdirSync(join(hostAuthenticationPath, "skills"), { recursive: true });
    mkdirSync(join(hostAuthenticationPath, "plugins"), { recursive: true });
    mkdirSync(join(hostAuthenticationPath, "hooks"), { recursive: true });
    writeFileSync(join(hostAuthenticationPath, "mcp.json"), "{}\n");
    writeFileSync(join(hostAuthenticationPath, "AGENTS.md"), "hostile\n");
    const canonicalHostPath = realpathSync(hostAuthenticationPath);
    mkdirSync(join(target.canonicalRoot, ".kimi-code"));
    mkdirSync(join(target.canonicalRoot, ".agents"));
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: canonicalHostPath,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "full-access",
        environment: sanitizeAcpEnvironment(
          kimi,
          { PATH: "/usr/bin", HOME: "/Users/octant-test" },
          { managedHome, executionPolicy: "full-access" },
        ),
      }),
    );

    expect(launch.command).toBe(target.sandboxPath);
    expect(launch.environment.KIMI_CODE_HOME).toBe(canonicalHostPath);
    const profileText = seatbeltProfile(launch);
    expect(profileText).toContain("(allow default)");
    expect(profileText).not.toContain("(deny default)");
    for (const entry of ["mcp.json", "skills", "plugins", "hooks", "AGENTS.md"]) {
      const denied = join(canonicalHostPath, entry);
      expect(profileText).toContain(`(deny file-read* (subpath "${denied}"))`);
      expect(profileText).toContain(`(deny file-write* (subpath "${denied}"))`);
    }
    expect(profileText).toContain(
      `(deny file-read* (subpath "${join(target.canonicalRoot, ".kimi-code")}"))`,
    );
    expect(profileText).toContain(
      `(deny file-read* (subpath "${join(target.canonicalRoot, ".agents")}"))`,
    );
  });

  it("binds the host root on Linux Full access and overlays the denied extension paths", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const hostAuthenticationPath = join(hostHome, ".kimi-code");
    mkdirSync(hostAuthenticationPath, { recursive: true });
    writeFileSync(join(hostAuthenticationPath, "mcp.json"), "{}\n");
    const canonicalHostPath = realpathSync(hostAuthenticationPath);
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "linux",
        sandboxPath: target.bwrapPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: canonicalHostPath,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    expect(launch.command).toBe(target.bwrapPath);
    expect(launch.args.slice(0, 9)).toEqual([
      "--die-with-parent",
      "--dev-bind",
      "/dev",
      "/dev",
      "--proc",
      "/proc",
      "--bind",
      "/",
      "/",
    ]);
    expect(launch.args).toContainEqual("--tmpfs");
    expect(launch.args).toContain(join(canonicalHostPath, "skills"));
    expect(launch.args).toContain(join(canonicalHostPath, "mcp.json"));
  });

  it("uses native sandbox-exec so a Full access child cannot read planted MCP config", async () => {
    if (process.platform !== "darwin") return;
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostHome = realpathSync(mkdtempSync(join(tmpdir(), "octant-acp-host-")));
    directories.push(hostHome);
    const hostAuthenticationPath = join(hostHome, ".kimi-code");
    mkdirSync(join(hostAuthenticationPath, "skills"), { recursive: true });
    writeFileSync(join(hostAuthenticationPath, "mcp.json"), "hostile-mcp\n");
    writeFileSync(join(hostAuthenticationPath, "config.toml"), "telemetry = false\n");
    const canonicalHostPath = realpathSync(hostAuthenticationPath);
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: "/usr/bin/sandbox-exec",
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: canonicalHostPath,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "full-access",
        environment: {},
      }),
    );
    const profile = launch.args[1];
    expect(typeof profile).toBe("string");
    if (typeof profile !== "string") return;
    const denied = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "--", "/bin/cat", join(canonicalHostPath, "mcp.json")],
      { encoding: "utf8" },
    );
    const allowed = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "--", "/bin/cat", join(canonicalHostPath, "config.toml")],
      { encoding: "utf8" },
    );
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).not.toContain("hostile-mcp");
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).toContain("telemetry = false");
  });
});

describe("ACP probe confinement", () => {
  it("allows provider control-plane egress without granting Chat thread authority", async () => {
    const target = fixture(kilo);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const hostAuthenticationPath = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthenticationPath, { recursive: true });
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath,
      }).prepare({
        profile: kilo,
        binaryPath: target.binaryPath,
        root: managedHome,
        managedHome,
        mode: "chat",
        executionPolicy: "approval-gated",
        purpose: "probe",
        environment: sanitizeAcpEnvironment(
          kilo,
          { PATH: "/usr/bin", HOME: "/Users/octant-test" },
          { managedHome, executionPolicy: "approval-gated" },
        ),
      }),
    );
    const profileText = seatbeltProfile(launch);
    expect(profileText).toContain("(allow network*)");
    expect(profileText).not.toContain("(allow process-exec)\n");
    expect(profileText).not.toContain("(allow process-fork)");
  });

  it("keeps an ordinary Chat launch at no network egress", async () => {
    const target = fixture(kilo);
    const managedHome = join(target.canonicalRoot, "managed-home");
    const hostAuthenticationPath = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthenticationPath, { recursive: true });
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath,
      }).prepare({
        profile: kilo,
        binaryPath: target.binaryPath,
        root: managedHome,
        managedHome,
        mode: "chat",
        executionPolicy: "approval-gated",
        environment: sanitizeAcpEnvironment(
          kilo,
          { PATH: "/usr/bin", HOME: "/Users/octant-test" },
          { managedHome, executionPolicy: "approval-gated" },
        ),
      }),
    );
    // The probe exception must not widen a thread launch: the same mode and
    // policy without `purpose: "probe"` still gets no network at all.
    const profileText = seatbeltProfile(launch);
    expect(profileText).not.toContain("(allow network*)");
  });
});

it("ships every ACP profile through deny-default confinement", () => {
  for (const profile of Object.values(acpProviderProfiles)) {
    expect(profile.process.confinement.kind).toBe("deny-default-seatbelt");
    expect(profile.authentication.kind).toBe("provider-owned");
  }
});

describe("Kimi Code provider-owned profile", () => {
  function confinement(target: ReturnType<typeof fixture>, temporaryDirectory?: string) {
    const hostAuthenticationPath = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthenticationPath, { recursive: true });
    return makeAcpConfinementLive({
      platform: "darwin",
      sandboxPath: target.sandboxPath,
      ...(temporaryDirectory === undefined ? {} : { temporaryDirectory }),
      hostAuthenticationPath,
    });
  }

  it("launches the configured CLI with its native profile and Octant's process boundary", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostAuthentication = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthentication, { recursive: true });
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "darwin",
        sandboxPath: target.sandboxPath,
        temporaryDirectory: target.canonicalRoot,
        hostAuthenticationPath: hostAuthentication,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome,
        mode: "code",
        executionPolicy: "approval-gated",
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
      HOME: "/Users/test",
      KIMI_CODE_HOME: hostAuthentication,
    });
    expect(launch.command).toBe(target.sandboxPath);
    expect(launch.args).toContain(target.binaryPath);
    expect(launch.args[1]).toContain("(deny default)");
    expect(launch.args[1]).toContain(`(allow file-read* (subpath "${hostAuthentication}"))`);
    for (const entry of ["AGENTS.md", "mcp.json", "skills", "plugins", "hooks"]) {
      expect(launch.args[1]).toContain(
        `(deny file-read* (subpath "${join(hostAuthentication, entry)}"))`,
      );
      expect(launch.args[1]).toContain(
        `(deny file-write* (subpath "${join(hostAuthentication, entry)}"))`,
      );
    }
  });

  it("does not create a duplicate managed authentication profile", async () => {
    const target = fixture(kimi);
    const managedHome = join(target.canonicalRoot, "managed-kimi");
    const hostAuthentication = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthentication, { recursive: true });
    const input = {
      profile: kimi,
      binaryPath: target.binaryPath,
      root: target.canonicalRoot,
      managedHome,
      mode: "code" as const,
      executionPolicy: "approval-gated" as const,
      environment: { PATH: "/usr/bin" },
    };
    const prepared = makeAcpConfinementLive({
      platform: "darwin",
      sandboxPath: target.sandboxPath,
      temporaryDirectory: join(target.canonicalRoot, "sandbox-tmp"),
      hostAuthenticationPath: hostAuthentication,
    });
    await Effect.runPromise(prepared.prepare(input));
    expect(existsSync(join(managedHome, "config.toml"))).toBe(false);
    expect(existsSync(join(managedHome, "home"))).toBe(false);
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

  it("allows only the owned ACP tool bridge port without opening generic network egress", async () => {
    const target = fixture(kimi);
    const root = target.canonicalRoot;
    const launch = await Effect.runPromise(
      confinement(target, join(root, "sandbox-tmp")).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root,
        managedHome: join(root, "managed-kimi-loopback"),
        mode: "work",
        executionPolicy: "approval-gated",
        environment: {},
        loopbackPorts: [43_123],
      }),
    );
    expect(launch.args[1]).toContain('(allow network-outbound (remote ip "localhost:43123"))');
    expect(launch.args[1]).not.toContain("(allow network*)");
    const invalid = await failureOf(
      confinement(target).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root,
        managedHome: join(root, "managed-kimi-loopback-invalid"),
        mode: "work",
        executionPolicy: "approval-gated",
        environment: {},
        loopbackPorts: [65_536],
      }),
    );
    expect(invalid).toEqual({
      category: "invalid-configuration",
      message: "Kimi Code app-managed tool bridge port is invalid.",
    });
  });

  it("keeps provider-owned profile confinement on Linux with Bubblewrap", async () => {
    expect(kimi.process.confinement.kind).toBe("deny-default-seatbelt");
    const target = fixture(kimi);
    const hostAuthentication = join(target.canonicalRoot, "host-auth");
    mkdirSync(hostAuthentication, { recursive: true });
    const launch = await Effect.runPromise(
      makeAcpConfinementLive({
        platform: "linux",
        sandboxPath: target.bwrapPath,
        temporaryDirectory: join(target.canonicalRoot, "tmp"),
        hostAuthenticationPath: hostAuthentication,
      }).prepare({
        profile: kimi,
        binaryPath: target.binaryPath,
        root: target.canonicalRoot,
        managedHome: join(target.canonicalRoot, "managed-kimi"),
        mode: "code",
        executionPolicy: "approval-gated",
        environment: {},
      }),
    );
    expect(launch.command).toBe(target.bwrapPath);
    expect(launch.args).toContain(target.binaryPath);
  });

  it("fails closed on non-canonical roots", async () => {
    const target = fixture(kimi);
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
    const spawned = spawnRecord(target.root);
    expect(spawned?.cwd).toBe(root);
    expect(spawned?.args.at(-1)).toBe("acp");
  });
});
