import {
  accessSync,
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderFailure } from "@octant/contracts";
import { Effect, Either, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  captureOpenCodeRuntimeConfig,
  createPrivateOpenCodeProfile,
  makeOpenCodeProcessLive,
  projectOpenCodeRuntimeConfig,
  probeOpenCodeBinary,
  resolveOpenCodeRuntimeConfig,
  supportsOpenCodeIsolation,
  type OpenCodeProcessDependencies,
  type OpenCodeProcessOptions,
  type OpenCodeProcessPort,
} from "./openCodeProcess";
import type { SeatbeltConfinementPort } from "../process/seatbeltProfile";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeOpenCodeCli.ts", import.meta.url));
const directories: string[] = [];

const passthroughConfinement: SeatbeltConfinementPort = {
  prepare: (input) => ({
    command: input.executable,
    args: input.args,
  }),
};

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
    `#!/bin/sh\nprintf 'broker-url=%s\\nbroker-token=%s\\ndesktop-secret=%s\\nallowed=%s\\nplugins=%s\\nclaude=%s\\nconfig=%s\\n' "\${OCTANT_CREDENTIAL_BROKER_URL-<unset>}" "\${OCTANT_CREDENTIAL_BROKER_TOKEN-<unset>}" "\${OCTANT_DESKTOP_BRIDGE_SECRET-<unset>}" "\${OCTANT_TEST_ALLOWED_ENV-<unset>}" "\${OPENCODE_DISABLE_DEFAULT_PLUGINS-<unset>}" "\${OPENCODE_DISABLE_CLAUDE_CODE-<unset>}" "\${OPENCODE_CONFIG_CONTENT-<unset>}" > '${environmentPath}'\nexec '${fakeCliPath}' "$@"\n`,
  );
  chmodSync(binaryPath, 0o755);
  return { binaryPath, environmentPath, root };
}

function profileRecordingWrapper(mode = "ready"): {
  readonly binaryPath: string;
  readonly environmentPath: string;
  readonly root: string;
} {
  const root = fixtureRoot(mode);
  const binaryPath = join(root, "opencode-profile-fixture");
  const environmentPath = join(root, ".fake-opencode-profile");
  writeFileSync(
    binaryPath,
    `#!/bin/sh\ncd '${root}'\nprintf 'config=%s\\nconfig-content=%s\\nconfig-dir=%s\\ndata=%s\\n' "\${OPENCODE_CONFIG-<unset>}" "\${OPENCODE_CONFIG_CONTENT-<unset>}" "\${XDG_CONFIG_HOME-<unset>}" "\${XDG_DATA_HOME-<unset>}" > '${environmentPath}'\nexec '${fakeCliPath}' "$@"\n`,
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
  it("resolves only global OpenCode routing config and never project extension config", async () => {
    const root = fixtureRoot();
    const configHome = join(root, "xdg-config");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(
      join(configHome, "opencode", "opencode.jsonc"),
      '{\n  // routing only\n  "model": "synthetic/model",\n  "plugin": ["global-hostile"],\n  "provider": { "synthetic": { "options": { "baseURL": "https://provider.invalid" }, }, },\n}\n',
    );
    writeFileSync(join(root, "opencode.json"), '{"model":"project-hostile"}');
    const resolved = await resolveOpenCodeRuntimeConfig({
      binaryPath: "/synthetic/opencode",
      cwd: root,
      environment: { HOME: join(root, "home"), XDG_CONFIG_HOME: configHome },
    });
    expect(resolved).toMatchObject({ model: "synthetic/model" });
    expect(resolved).not.toHaveProperty("plugin");
  });

  it("only attests isolation for the verified OpenCode runtime version", () => {
    expect(supportsOpenCodeIsolation("1.18.21")).toBe(true);
    expect(supportsOpenCodeIsolation("1.18.22")).toBe(false);
    expect(supportsOpenCodeIsolation("1.18.20")).toBe(false);
    expect(supportsOpenCodeIsolation("1.18.21-custom")).toBe(false);
    expect(supportsOpenCodeIsolation("1.18.21+patched")).toBe(false);
    expect(supportsOpenCodeIsolation("1.17.19")).toBe(false);
    expect(supportsOpenCodeIsolation("1.19.0")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode2 v0.0.0-beta-18721")).toBe(false);
  });

  // This is deliberately opt-in: it launches the installed provider runtime
  // and is evidence for that local version only. Default CI exercises the
  // synthetic fixture and must not be presented as installed-runtime proof.
  it.skipIf(process.env.OCTANT_OPENCODE_PROFILE_SMOKE !== "1")(
    "keeps hostile project and global plugin fixtures out of the installed runtime",
    async () => {
      const binaryPath = "/opt/homebrew/bin/opencode";
      expect(() => accessSync(binaryPath)).not.toThrow();
      const root = mkdtempSync(join(tmpdir(), "octant-opencode-isolation-smoke-"));
      const markerPath = join(root, "hostile-plugin-loaded");
      const configHome = join(root, "config");
      const dataHome = join(root, "data");
      mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
      mkdirSync(join(configHome, "opencode", "plugins"), { recursive: true });
      mkdirSync(join(dataHome, "opencode", "plugins"), { recursive: true });
      const hostile = `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(markerPath)}, "loaded");\nexport const Hostile = async () => ({});\n`;
      writeFileSync(join(root, ".opencode", "plugins", "hostile.js"), hostile);
      writeFileSync(join(configHome, "opencode", "plugins", "hostile.js"), hostile);
      writeFileSync(join(dataHome, "opencode", "plugins", "hostile.js"), hostile);
      writeFileSync(
        join(configHome, "opencode", "opencode.jsonc"),
        '{ "plugin": ["hostile-plugin"], "provider": {}, }',
      );
      const environment = {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        XDG_STATE_HOME: join(root, "state"),
        XDG_CACHE_HOME: join(root, "cache"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
      };
      try {
        const server = await Effect.runPromise(
          Effect.scoped(
            makeOpenCodeProcessLive({
              inheritedEnvironment: environment,
              startupTimeoutMs: 20_000,
            }).start({ binaryPath, cwd: root }),
          ),
        );
        expect(server.isolatedConfiguration).toBe(true);
        expect(() => readFileSync(markerPath)).toThrow();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("projects provider routing while excluding executable extension surfaces", () => {
    const projected = projectOpenCodeRuntimeConfig({
      $schema: "https://example.invalid/config.json",
      model: "airouter/Qwen3.6",
      small_model: "airouter/Qwen3.6",
      provider: {
        airouter: {
          name: "aiRouter",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://router.invalid/v1", apiKey: "{env:OPENAI_API_KEY}" },
          models: {
            "Qwen3.6": {
              name: "Qwen3.6",
              limit: { context: 128000 },
              options: { apiKey: "raw-model-secret" },
              headers: { Authorization: "Bearer raw-model-header" },
            },
          },
          instructions: ["private-instruction-must-not-cross"],
        },
      },
      mcp: { foreign: { type: "remote", url: "https://foreign.invalid" } },
      plugin: ["foreign-plugin"],
      skills: ["foreign-skill"],
    });
    const parsed: unknown = JSON.parse(projected.content);
    expect(parsed).toMatchObject({
      model: "airouter/Qwen3.6",
      provider: {
        airouter: {
          name: "aiRouter",
          options: { baseURL: "https://router.invalid/v1", apiKey: "{env:OPENAI_API_KEY}" },
        },
      },
    });
    expect(parsed).not.toHaveProperty("mcp");
    expect(parsed).not.toHaveProperty("plugin");
    expect(parsed).not.toHaveProperty("skills");
    expect(parsed).not.toHaveProperty("provider.airouter.models.Qwen3.6.options");
    expect(parsed).not.toHaveProperty("provider.airouter.models.Qwen3.6.headers");
    expect(parsed).toHaveProperty("provider.airouter.options.apiKey", "{env:OPENAI_API_KEY}");
    expect(JSON.stringify(parsed)).not.toContain("private-instruction-must-not-cross");
  });

  it("refuses resolver payloads beyond the private size and nesting bounds", () => {
    expect(() =>
      projectOpenCodeRuntimeConfig({
        provider: { airouter: { models: { large: { description: "x".repeat(2_100_000) } } } },
      }),
    ).toThrow("exceeds the private routing limit");

    let nested: unknown = "leaf";
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    expect(() =>
      projectOpenCodeRuntimeConfig({ provider: { airouter: { models: { large: nested } } } }),
    ).toThrow("exceeds the private nesting limit");
  });

  it("captures only the projected resolver result", async () => {
    const resolver = vi.fn(async () => ({
      provider: {
        airouter: {
          options: { apiKey: "synthetic-secret" },
          models: { "Qwen3.6": { name: "Qwen3.6" } },
        },
      },
      mcp: { foreign: { type: "remote" } },
    }));
    const captured = await captureOpenCodeRuntimeConfig(
      { binaryPath: "/synthetic/opencode", cwd: "/synthetic/project" },
      resolver,
    );
    expect(resolver).toHaveBeenCalledWith({
      binaryPath: "/synthetic/opencode",
      cwd: "/synthetic/project",
    });
    expect(captured?.content).not.toContain("synthetic-secret");
    expect(captured?.content).not.toContain("foreign");
  });

  it("builds a private profile that leaves provider data ownership unchanged", () => {
    const root = fixtureRoot();
    const profile = createPrivateOpenCodeProfile(
      { content: '{"provider":{"airouter":{"options":{"apiKey":"{env:OPENAI_API_KEY}"}}}}' },
      {
        HOME: "/synthetic/home",
        PATH: "/synthetic/bin",
        OPENAI_API_KEY: "synthetic-provider-key",
        XDG_DATA_HOME: "/synthetic/data",
        XDG_CONFIG_HOME: "/synthetic/user-config",
        OPENCODE_CONFIG: "/synthetic/opencode.jsonc",
        OPENCODE_CONFIG_CONTENT: '{"plugin":["foreign"]}',
        OPENCODE_PERMISSION: "allow",
        OCTANT_BROWSER_BROKER_TOKEN: "internal-secret",
      },
      () => root,
    );
    try {
      const environment = profile.environment;
      expect(environment.XDG_DATA_HOME).toBe("/synthetic/data");
      expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      expect(environment.OPENCODE_PERMISSION).toBeUndefined();
      expect(environment.OCTANT_BROWSER_BROKER_TOKEN).toBeUndefined();
      const configPath = environment.OPENCODE_CONFIG;
      expect(configPath).toBeTypeOf("string");
      if (configPath === undefined) throw new Error("Expected a private config path.");
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(configPath, "utf8")).toContain("{env:OPENAI_API_KEY}");
      expect(readFileSync(configPath, "utf8")).toContain('"permission"');
      for (const name of [
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_STATE_HOME",
        "TMPDIR",
        "OPENCODE_CONFIG_DIR",
      ]) {
        const directory = environment[name];
        expect(directory).toBeTypeOf("string");
        if (directory === undefined) continue;
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      }
    } finally {
      profile.cleanup();
      profile.cleanup();
    }
  });

  it("does not persist raw provider credentials from a routing projection", () => {
    const root = fixtureRoot();
    const profile = createPrivateOpenCodeProfile(
      {
        content: JSON.stringify({
          provider: { airouter: { options: { apiKey: "raw-secret" } } },
        }),
      },
      {},
      () => root,
    );
    try {
      const configPath = profile.environment.OPENCODE_CONFIG;
      if (configPath === undefined) throw new Error("Expected a private config path.");
      const content = readFileSync(configPath, "utf8");
      expect(content).not.toContain("raw-secret");
      expect(content).toContain('"permission"');
    } finally {
      profile.cleanup();
    }
  });

  it("drops nested credential objects, tokens, and headers while keeping bounded placeholders", () => {
    const root = fixtureRoot();
    const profile = createPrivateOpenCodeProfile(
      {
        content: JSON.stringify({
          provider: {
            synthetic: {
              options: {
                apiKey: "{env:OPENAI_API_KEY}",
                accessToken: "{env:lowercase}",
                secret: "{file:/synthetic/key}",
                token: "raw-token",
                headers: [{ name: "Authorization", value: "Bearer raw-header" }],
                nested: { credential: { value: "raw-nested" }, value: "raw-value" },
              },
            },
          },
        }),
      },
      { OPENAI_API_KEY: "synthetic-provider-key" },
      () => root,
    );
    try {
      const configPath = profile.environment.OPENCODE_CONFIG;
      if (configPath === undefined) throw new Error("Expected a private config path.");
      const content = readFileSync(configPath, "utf8");
      expect(content).toContain("{env:OPENAI_API_KEY}");
      expect(content).not.toContain("{env:lowercase}");
      expect(content).not.toContain("{file:/synthetic/key}");
      expect(content).not.toContain("raw-token");
      expect(content).not.toContain("raw-header");
      expect(content).not.toContain("raw-nested");
      expect(content).not.toContain("raw-value");
    } finally {
      profile.cleanup();
    }
  });

  it("rejects URL credentials and secret query parameters in provider routing", () => {
    expect(() =>
      projectOpenCodeRuntimeConfig({
        provider: { synthetic: { options: { baseURL: "https://user:pass@example.invalid/v1" } } },
      }),
    ).toThrow("URL credentials");
    expect(() =>
      projectOpenCodeRuntimeConfig({
        provider: { synthetic: { options: { baseURL: "https://example.invalid/v1?api_key=raw" } } },
      }),
    ).toThrow("secret query");
  });

  it("rejects unbundled provider SDK module specs", () => {
    for (const npm of [
      "file:///tmp/provider.mjs",
      "https://example.invalid/provider",
      "git+ssh://example.invalid/provider",
      "unknown-provider",
    ]) {
      expect(() => projectOpenCodeRuntimeConfig({ provider: { synthetic: { npm } } })).toThrow(
        "bundled provider SDK package",
      );
      expect(() =>
        projectOpenCodeRuntimeConfig({
          provider: { synthetic: { models: { model: { provider: { npm } } } } },
        }),
      ).toThrow("bundled provider SDK package");
    }
  });

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

  it("preserves the beta runtime label instead of parsing it as a v1 semantic version", async () => {
    const fixture = probeWrapper("probe-v2");
    await expect(Effect.runPromise(probeOpenCodeBinary(fixture.binaryPath))).resolves.toEqual({
      binaryPath: fixture.binaryPath,
      version: "opencode2 v0.0.0-beta-18721",
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
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=allowed-value\nplugins=<unset>\nclaude=<unset>\nconfig=<unset>\n",
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
        runtimeConfigResolver: async () => undefined,
        confinement: passthroughConfinement,
        ...overrides,
      },
      dependencies,
    );

  it("passes the explicit mode and policy to the OS confinement port before spawning", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    let captured: Parameters<SeatbeltConfinementPort["prepare"]>[0] | undefined;
    const confinement: SeatbeltConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "work",
          executionPolicy: "plan",
        }),
      ),
    );
    expect(captured).toMatchObject({
      boundRoot: realpathSync(fixture.root),
      networkEgress: "none",
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: false,
    });
  });

  it("starts with a private config profile while withholding isolation without an OS receipt", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const inheritedEnvironment = {
      ...process.env,
      HOME: "/synthetic/home",
      XDG_DATA_HOME: "/synthetic/provider-data",
      XDG_CONFIG_HOME: "/synthetic/user-config",
      OPENCODE_CONFIG_CONTENT: '{"plugin":["foreign"]}',
    };
    const configPath = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makePort({ inheritedEnvironment }).start({
            binaryPath: fixture.binaryPath,
            cwd: fixture.root,
          });
          const values = readFileSync(fixture.environmentPath, "utf8");
          const config = values.match(/^config=(.*)$/m)?.[1];
          if (config === undefined || config === "<unset>") {
            throw new Error("Expected a private OpenCode config path.");
          }
          expect(values).toContain("config-content=<unset>");
          expect(values).toContain("config-dir=");
          expect(values).toContain("data=/synthetic/provider-data");
          expect(server.isolatedConfiguration).toBeUndefined();
          expect(readFileSync(config, "utf8")).toContain('"permission"');
          return config;
        }),
      ),
    );
    expect(() => readFileSync(configPath)).toThrow();
  });

  it("imports resolver routing into the private profile without forwarding extension settings", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const resolver = vi.fn(async () => ({
      model: "synthetic/model",
      provider: {
        synthetic: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://provider.invalid/v1" },
        },
      },
      plugin: ["foreign-plugin"],
    }));
    const configPath = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* makePort({ runtimeConfigResolver: resolver }).start({
            binaryPath: fixture.binaryPath,
            cwd: fixture.root,
          });
          const configPath = readFileSync(fixture.environmentPath, "utf8").match(
            /^config=(.*)$/m,
          )?.[1];
          if (configPath === undefined || configPath === "<unset>") {
            throw new Error("Expected a private OpenCode config path.");
          }
          const config = readFileSync(configPath, "utf8");
          expect(server.isolatedConfiguration).toBeUndefined();
          expect(config).toContain("synthetic/model");
          expect(config).toContain("https://provider.invalid/v1");
          expect(config).not.toContain("foreign-plugin");
          return configPath;
        }),
      ),
    );
    expect(resolver).toHaveBeenCalledWith({ binaryPath: fixture.binaryPath, cwd: fixture.root });
    expect(() => readFileSync(configPath)).toThrow();
  });

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

  it("starts the beta runtime with its own readiness line and auth identity", async () => {
    const fixture = probeWrapper("v2-ready");
    const observed = await Effect.runPromise(
      Effect.scoped(makePort().start({ binaryPath: fixture.binaryPath, cwd: fixture.root })),
    );

    expect(observed.url.hostname).toBe("127.0.0.1");
    expect(observed.runtime).toBe("beta");
    expect(observed.version).toBe("opencode2 v0.0.0-beta-18721");
    expect(observed.authorization).toMatch(/^Basic b3BlbmNvZGU6/);
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
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=allowed-value\nplugins=1\nclaude=1\nconfig=<unset>\n",
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
