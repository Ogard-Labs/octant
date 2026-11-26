import {
  accessSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderExecutionPolicy, ProviderFailure } from "@octant/contracts";
import { Effect, Either, Fiber } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  WINDOWS_KEPT_SANDBOX_REFUSAL,
  WINDOWS_STRICT_CHAT_REFUSAL,
  WINDOWS_STRICT_REFUSAL,
  windowsStrictRuntimeRefusal,
} from "@octant/domain/guardrail-policy";
import {
  captureOpenCodeRuntimeConfig,
  createOwnOpenCodeProfile,
  createPrivateOpenCodeProfile,
  makeOpenCodeProcessLive,
  OPENCODE_CHAT_PLAN_REFUSAL,
  OPENCODE_UPGRADE_MESSAGE,
  openCodeServerArgs,
  projectOpenCodeRuntimeConfig,
  probeOpenCodeBinary,
  resolveOpenCodeRuntimeConfig,
  supportsOpenCodeIsolation,
  type OpenCodeProcessDependencies,
  type OpenCodeProcessOptions,
  type OpenCodeProcessPort,
  type OpenCodeProcessStartInput,
} from "./openCodeProcess";
import type { ProcessConfinementPort } from "../process/seatbeltProfile";
import { applyProtectedFilesChoice } from "../process/secretGuard";

const fakeCliPath = fileURLToPath(new URL("./fixtures/fakeOpenCodeCli.ts", import.meta.url));
const directories: string[] = [];

const passthroughConfinement: ProcessConfinementPort = {
  prepare: (input) => ({
    command: input.executable,
    args: input.args,
  }),
};

/**
 * These suites assert process lifecycle, not the profile. The live builder
 * refuses on a host without `sandbox-exec`, and a real profile would deny the
 * fixture the mode and pid files it keeps beside itself, so the version launch
 * is prepared with the confinement passed straight through.
 */
function probeOpenCode(
  binaryPath: string,
  onProcessStarted?: Parameters<typeof probeOpenCodeBinary>[1],
) {
  return probeOpenCodeBinary(binaryPath, onProcessStarted, {
    confinement: passthroughConfinement,
  });
}

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
    `#!/bin/sh\nprintf 'broker-url=%s\\nbroker-token=%s\\ndesktop-secret=%s\\nallowed=%s\\nupdater=%s\\nclaude-skills=%s\\nconfig=%s\\n' "\${OCTANT_CREDENTIAL_BROKER_URL-<unset>}" "\${OCTANT_CREDENTIAL_BROKER_TOKEN-<unset>}" "\${OCTANT_DESKTOP_BRIDGE_SECRET-<unset>}" "\${OCTANT_TEST_ALLOWED_ENV-<unset>}" "\${OPENCODE_DISABLE_AUTOUPDATE-<unset>}" "\${OPENCODE_DISABLE_CLAUDE_CODE_SKILLS-<unset>}" "\${OPENCODE_CONFIG_CONTENT-<unset>}" > '${environmentPath}'\nexec '${fakeCliPath}' "$@"\n`,
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
    expect(supportsOpenCodeIsolation("1.18.21")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.4.1")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode2 v0.0.0-beta-18721")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.0.22")).toBe(true);
    expect(supportsOpenCodeIsolation("opencode v2.0.21")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.0.23")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.0.27")).toBe(true);
    expect(supportsOpenCodeIsolation("opencode v2.0.26")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.0.28")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode v2.0.27-custom")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode2 v2.0.27")).toBe(false);
    expect(supportsOpenCodeIsolation("2.0.27")).toBe(false);
    expect(supportsOpenCodeIsolation("opencode2 v2.0.22")).toBe(false);
    expect(supportsOpenCodeIsolation("2.0.22")).toBe(false);
  });

  // This is deliberately opt-in: it launches the installed provider runtime
  // and is evidence for that local version only. Default CI exercises the
  // synthetic fixture and must not be presented as installed-runtime proof.
  it.skipIf(process.env.OCTANT_OPENCODE_PROFILE_SMOKE !== "1")(
    "keeps hostile project and global plugin fixtures out of the installed runtime",
    async () => {
      const binaryPath = process.env.OCTANT_OPENCODE_BINARY ?? "/opt/homebrew/bin/opencode";
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
        OCTANT_BROWSER_BROKER_TOKEN: "internal-secret",
      },
      () => root,
    );
    try {
      const environment = profile.environment;
      expect(environment.XDG_DATA_HOME).toBe("/synthetic/data");
      expect(environment.OPENCODE_CONFIG_CONTENT).toBeUndefined();
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

  it("keeps OpenCode's own skill discovery only for a launch whose person allowed it, and every other guard", () => {
    const root = fixtureRoot();
    const skillSwitches = ["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"];
    const locked = createPrivateOpenCodeProfile({ content: "{}" }, { HOME: root }, () => root);
    const own = createPrivateOpenCodeProfile(
      { content: "{}" },
      { HOME: root },
      () => root,
      undefined,
      true,
    );
    try {
      for (const name of skillSwitches) {
        expect(locked.environment[name], name).toBe("1");
        expect(own.environment, name).not.toHaveProperty(name);
      }
      for (const name of [
        "OPENCODE_DISABLE_AUTOUPDATE",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
        "OPENCODE_DISABLE_MODELS_FETCH",
      ]) {
        expect(own.environment[name], name).toBe("1");
      }
      // The installed opencode v2.4.1 reads none of these, so no launch sets them.
      for (const name of [
        "OPENCODE_DISABLE_DEFAULT_PLUGINS",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS",
        "OPENCODE_DISABLE_LSP_DOWNLOAD",
      ]) {
        expect(locked.environment, name).not.toHaveProperty(name);
      }
      const config = (profile: typeof own) =>
        JSON.parse(readFileSync(profile.environment.OPENCODE_CONFIG ?? "", "utf8")) as {
          readonly permission: Record<string, unknown>;
        };
      expect(config(locked).permission).toEqual({ skill: { "*": "deny" }, "*_*": "deny" });
      // Every MCP tool but Octant's own bridge stays denied either way.
      expect(config(own).permission).toEqual({ "*_*": "deny" });
    } finally {
      locked.cleanup();
      own.cleanup();
    }
  });

  it("leaves the person's config locations alone on their own configuration and layers only Octant's rules", () => {
    const posture = [
      { action: "*", resource: "*", effect: "ask" },
      { action: "read", resource: "*", effect: "allow" },
    ] as const;
    const host = {
      HOME: "/home/person",
      OPENCODE_CONFIG: "/home/person/work.json",
      OPENCODE_CONFIG_DIR: "/home/person/.opencode-work",
      XDG_CONFIG_HOME: "/home/person/.config",
      XDG_CACHE_HOME: "/home/person/.cache",
      XDG_STATE_HOME: "/home/person/.state",
      TMPDIR: "/home/person/tmp",
      OCTANT_CREDENTIAL_BROKER_TOKEN: "broker-secret",
    };
    const profile = createOwnOpenCodeProfile(host, posture, "darwin");
    expect(profile).toBeDefined();
    const environment = profile?.environment ?? {};
    for (const name of [
      "HOME",
      "OPENCODE_CONFIG",
      "OPENCODE_CONFIG_DIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
      "TMPDIR",
    ] as const) {
      expect(environment[name], name).toBe(host[name]);
    }
    expect(environment).not.toHaveProperty("XDG_DATA_HOME");
    expect(environment).not.toHaveProperty("OCTANT_CREDENTIAL_BROKER_TOKEN");
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({ permissions: posture });
    // Default plugins and the language-server download behave as on its own.
    expect(environment).not.toHaveProperty("OPENCODE_DISABLE_DEFAULT_PLUGINS");
    expect(environment).not.toHaveProperty("OPENCODE_DISABLE_LSP_DOWNLOAD");
    // The updater follows the person's switch; the catalogue fetch and a
    // Project's own configuration keep their guards.
    expect(environment.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(environment.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
    expect(environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    const updating = createOwnOpenCodeProfile(host, posture, "darwin", false, false, true);
    expect(updating?.environment).not.toHaveProperty("OPENCODE_DISABLE_AUTOUPDATE");
    expect(updating?.environment.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
  });

  it("puts Octant's rules after the rules of an inline configuration the person's environment already carries", () => {
    const posture = [{ action: "*", resource: "*", effect: "ask" }] as const;
    const profile = createOwnOpenCodeProfile(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          share: "disabled",
          permissions: [{ action: "*", resource: "*", effect: "allow" }],
        }),
      },
      posture,
      "darwin",
    );
    expect(JSON.parse(profile?.environment.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      share: "disabled",
      permissions: [{ action: "*", resource: "*", effect: "allow" }, ...posture],
    });
  });

  it("holds the person's tool servers off on their own configuration with a policy after any the environment already carries", () => {
    const posture = [{ action: "*", resource: "*", effect: "ask" }] as const;
    const profile = createOwnOpenCodeProfile(
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          policies: [{ action: "mcp.use", resource: "docs", effect: "allow" }],
        }),
      },
      posture,
      "darwin",
      false,
      false,
      false,
      true,
    );
    expect(JSON.parse(profile?.environment.OPENCODE_CONFIG_CONTENT ?? "")).toEqual({
      policies: [
        { action: "mcp.use", resource: "docs", effect: "allow" },
        { action: "mcp.use", resource: "*", effect: "deny" },
        { action: "mcp.use", resource: "octant-*", effect: "allow" },
      ],
      permissions: posture,
    });
  });

  it("keeps the private configuration when Octant's rules do not fit an environment variable", () => {
    const posture = Array.from({ length: 400 }, (_, index) => ({
      action: "read",
      resource: `/home/person/protected/${String(index).padStart(40, "0")}`,
      effect: "deny" as const,
    }));
    expect(createOwnOpenCodeProfile({}, posture, "win32")).toBeUndefined();
    expect(createOwnOpenCodeProfile({}, posture, "darwin")).toBeDefined();
  });

  it("lifts only the updater switch when the person lets providers update themselves", () => {
    const root = fixtureRoot();
    const updating = createPrivateOpenCodeProfile(
      { content: "{}" },
      { HOME: root },
      () => root,
      undefined,
      false,
      undefined,
      false,
      false,
      true,
    );
    try {
      expect(updating.environment).not.toHaveProperty("OPENCODE_DISABLE_AUTOUPDATE");
      expect(updating.environment.OPENCODE_DISABLE_MODELS_FETCH).toBe("1");
      expect(updating.environment.OPENCODE_DISABLE_PROJECT_CONFIG).toBe("1");
    } finally {
      updating.cleanup();
    }
  });

  it("lets OpenCode read CLAUDE.md as it does on its own, while its .claude skills stay off until the person allows them", () => {
    const root = fixtureRoot();
    const launches = [
      createPrivateOpenCodeProfile({ content: "{}" }, { HOME: root }, () => root),
      createPrivateOpenCodeProfile({ content: "{}" }, { HOME: root }, () => root, undefined, true),
      createPrivateOpenCodeProfile(
        { content: "{}" },
        { HOME: root },
        () => root,
        undefined,
        false,
        undefined,
        true,
      ),
    ];
    try {
      for (const profile of launches) {
        // Neither switch is set: the skills switch alone keeps `.claude`
        // skills off, and instruction text grants no authority.
        expect(profile.environment).not.toHaveProperty("OPENCODE_DISABLE_CLAUDE_CODE");
        expect(profile.environment).not.toHaveProperty("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT");
      }
      const [locked, own, projectConfig] = launches;
      expect(locked?.environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
      expect(projectConfig?.environment.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS).toBe("1");
      expect(own?.environment).not.toHaveProperty("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
    } finally {
      for (const profile of launches) profile.cleanup();
    }
  });

  it("writes the person's own MCP servers into the private configuration and stops denying every namespaced tool", () => {
    const root = fixtureRoot();
    const servers = { docs: { type: "local", command: ["docs-server"] } };
    const loaded = createPrivateOpenCodeProfile(
      { content: "{}" },
      { HOME: root },
      () => root,
      undefined,
      false,
      servers,
    );
    const locked = createPrivateOpenCodeProfile({ content: "{}" }, { HOME: root }, () => root);
    try {
      const config = (profile: typeof loaded) =>
        JSON.parse(readFileSync(profile.environment.OPENCODE_CONFIG ?? "", "utf8")) as {
          readonly permission: Record<string, unknown>;
          readonly mcp?: unknown;
        };
      expect(config(loaded).mcp).toEqual(servers);
      expect(config(loaded).permission).toEqual({ skill: { "*": "deny" } });
      expect(config(locked)).not.toHaveProperty("mcp");
      expect(config(locked).permission).toEqual({ skill: { "*": "deny" }, "*_*": "deny" });
    } finally {
      loaded.cleanup();
      locked.cleanup();
    }
  });

  it("makes OpenCode's default provider data root explicit for confinement", () => {
    const root = fixtureRoot();
    const profile = createPrivateOpenCodeProfile({ content: "{}" }, { HOME: root }, () => root);
    try {
      expect(profile.environment.XDG_DATA_HOME).toBe(join(root, ".local", "share"));
    } finally {
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
    const failure = await failureOf(probeOpenCode("opencode"));
    expect(failure).toEqual({
      category: "invalid-configuration",
      message: "OpenCode binary path must be absolute.",
    });
  });

  it("rejects an absolute path that is not executable", async () => {
    const path = join(fixtureRoot(), "not-executable");
    writeFileSync(path, "not executable");
    chmodSync(path, 0o644);

    const failure = await failureOf(probeOpenCode(path));
    expect(failure.category).toBe("invalid-configuration");
    expect(failure.message).toBe("OpenCode binary path must reference an executable file.");
  });

  it("reads the release the installed OpenCode prints", async () => {
    await expect(Effect.runPromise(probeOpenCode(fakeCliPath))).resolves.toEqual({
      binaryPath: fakeCliPath,
      version: "opencode v2.4.1",
    });
  });

  it("reads the bare number an OpenCode 1 install prints, so it can be told to upgrade", async () => {
    const fixture = probeWrapper("probe-v1");
    await expect(Effect.runPromise(probeOpenCode(fixture.binaryPath))).resolves.toEqual({
      binaryPath: fixture.binaryPath,
      version: "1.18.21",
    });
  });

  it("reads the version from stdout when the program warns on stderr before answering", async () => {
    // Given a throwaway home the program may explain what it could not set up.
    // Folded into one buffer, that first line made a working install unreadable.
    const root = fixtureRoot();
    const binaryPath = join(root, "opencode-noisy");
    writeFileSync(
      binaryPath,
      "#!/bin/sh\nprintf 'warn: no data home\\n' >&2\nsleep 0.1\nprintf 'opencode v2.0.1\\n'\n",
    );
    chmodSync(binaryPath, 0o755);

    await expect(Effect.runPromise(probeOpenCode(binaryPath))).resolves.toEqual({
      binaryPath,
      version: "opencode v2.0.1",
    });
  });

  it("falls back to stderr when the program prints its version there instead", async () => {
    const root = fixtureRoot();
    const binaryPath = join(root, "opencode-stderr");
    writeFileSync(binaryPath, "#!/bin/sh\nprintf 'opencode v2.0.1\\n' >&2\n");
    chmodSync(binaryPath, 0o755);

    await expect(Effect.runPromise(probeOpenCode(binaryPath))).resolves.toEqual({
      binaryPath,
      version: "opencode v2.0.1",
    });
  });

  it("preserves a successful fast probe when receipt persistence loses the exit race", async () => {
    await expect(
      Effect.runPromise(
        probeOpenCode(fakeCliPath, async () => {
          throw new Error("receipt raced process exit");
        }),
      ),
    ).resolves.toEqual({ binaryPath: fakeCliPath, version: "opencode v2.4.1" });
  });

  it("does not expose managed-server authority to the version probe", async () => {
    const fixture = environmentRecordingWrapper();
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_URL", "http://127.0.0.1:41000/");
    vi.stubEnv("OCTANT_CREDENTIAL_BROKER_TOKEN", "broker-secret");
    vi.stubEnv("OCTANT_DESKTOP_BRIDGE_SECRET", "desktop-secret");
    vi.stubEnv("OCTANT_TEST_ALLOWED_ENV", "allowed-value");

    await Effect.runPromise(probeOpenCode(fixture.binaryPath));

    // The brokers are stripped, and so is every other inherited variable the
    // version read has no use for: only a fixed set of names reaches it, so a
    // credential in the server's environment cannot reach a replaced binary.
    // OpenCode's own static switches (no updater, no `.claude` skills) stay.
    expect(readFileSync(fixture.environmentPath, "utf8")).toBe(
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=<unset>\nupdater=1\nclaude-skills=1\nconfig=<unset>\n",
    );
    expect(process.env.OCTANT_CREDENTIAL_BROKER_URL).toBe("http://127.0.0.1:41000/");
    expect(process.env.OCTANT_CREDENTIAL_BROKER_TOKEN).toBe("broker-secret");
    expect(process.env.OCTANT_DESKTOP_BRIDGE_SECRET).toBe("desktop-secret");
  });

  it("rejects output that merely contains a semantic version", async () => {
    const fixture = probeWrapper("probe-misleading-version");
    const failure = await failureOf(probeOpenCode(fixture.binaryPath));
    expect(failure).toEqual({
      category: "protocol",
      message: "OpenCode binary returned an unrecognized version.",
    });
  });

  it("terminates probe descendants before returning a successful version", async () => {
    const fixture = probeWrapper("probe-success-descendant");
    await expect(Effect.runPromise(probeOpenCode(fixture.binaryPath))).resolves.toEqual({
      binaryPath: fixture.binaryPath,
      version: "opencode v2.4.1",
    });
    for (const pid of await waitForPids(fixture.root, 2)) await expectProcessMissing(pid);
  });

  it("terminates probe descendants before returning a non-zero exit failure", async () => {
    const fixture = probeWrapper("probe-failure-descendant");
    const failure = await failureOf(probeOpenCode(fixture.binaryPath));
    expect(failure).toEqual({
      category: "unavailable",
      message: "OpenCode binary probe did not succeed.",
    });
    for (const pid of await waitForPids(fixture.root, 2)) await expectProcessMissing(pid);
  });
});

describe("OpenCodeProcessPort", () => {
  it("serves on the loopback port the launch reserved", () => {
    expect(openCodeServerArgs(43123)).toEqual([
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "43123",
    ]);
  });

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
      { reserveLoopbackPort: async () => 43123, ...dependencies },
    );

  it("passes the explicit mode, policy and extra folders to the OS confinement port before spawning", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    // The configured path is a launcher link; the kernel needs read-metadata on
    // the link's directory before it can resolve to the realpath the profile
    // allows. The fixture's own directory is not the link's.
    const shimDirectory = join(fixture.root, "shims");
    mkdirSync(shimDirectory);
    const linkedBinary = join(shimDirectory, "opencode");
    symlinkSync(fixture.binaryPath, linkedBinary);
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          // Named, because Plan's jail differs by host: macOS lets OpenCode
          // fork to run the always-failing git stand-in and nothing else.
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: linkedBinary,
          cwd: fixture.root,
          extraFolders: ["/tmp/octant-opencode-notes"],
          mode: "work",
          executionPolicy: "plan",
        }),
      ),
    );
    expect(captured).toMatchObject({
      boundRoot: realpathSync(fixture.root),
      // An extra folder is bound beside the root and read-only with it in Plan.
      extraBoundRoots: ["/tmp/octant-opencode-notes"],
      // Plan withholds writing and running something, not the model call the
      // agent makes to produce the plan.
      networkEgress: "allow",
      writeBoundRoot: false,
      allowProcessExec: false,
      allowProcessFork: true,
    });
    expect(captured?.readRoots).not.toContain(realpathSync(shimDirectory));
    expect(captured?.privateHomeAllowPaths).toContain(realpathSync(shimDirectory));
    expect(captured?.privateHomeAllowPaths).toContain(realpathSync(linkedBinary));
  });

  // OpenCode 2 runs `git rev-parse` at startup to resolve its project. Under
  // the Chat/Plan/Work jail the stand-in puts an always-failing `git` (a
  // symlink to /usr/bin/false) first on PATH, allows fork, and grants exec
  // of exactly /usr/bin/false. Code mode stays unchanged.
  it("allows fork and exec of only /usr/bin/false for a 2.x Chat or Plan launch", async () => {
    const fixture = probeWrapper("ready");
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "chat",
          executionPolicy: "plan",
        }),
      ),
    );
    // Fork is allowed so OpenCode can spawn the failing git; exec stays
    // denied except for the single /usr/bin/false literal grant.
    expect(captured?.allowProcessFork).toBe(true);
    expect(captured?.allowProcessExec).toBe(false);
    const rules = captured?.extraRules ?? [];
    expect(rules).toContain('(allow process-exec (literal "/usr/bin/false"))');
    // No other exec grant appears in the launch's own rules: the only
    // process-exec literal rule is the stand-in target.
    const execRules = rules.filter((rule) => rule.includes("process-exec"));
    expect(execRules).toEqual(['(allow process-exec (literal "/usr/bin/false"))']);
  });

  it("refuses a Windows launch that needs Octant's sandbox by name before OpenCode is read or served", async () => {
    const fixture = probeWrapper("ready");
    for (const [launch, message] of [
      [{ mode: "code", executionPolicy: "approval-gated" }, WINDOWS_STRICT_REFUSAL],
      [
        { mode: "code", executionPolicy: "full-access", strict: true },
        windowsStrictRuntimeRefusal("opencode"),
      ],
      [
        { mode: "code", executionPolicy: "full-access", fullAccessSandbox: true, strict: false },
        WINDOWS_KEPT_SANDBOX_REFUSAL,
      ],
      [
        { mode: "chat", executionPolicy: "approval-gated", strict: true },
        WINDOWS_STRICT_CHAT_REFUSAL,
      ],
      [{ mode: "chat", executionPolicy: "plan" }, WINDOWS_STRICT_CHAT_REFUSAL],
    ] as const) {
      const prepare = vi.fn((input: { executable: string; args: ReadonlyArray<string> }) => ({
        command: input.executable,
        args: input.args,
      }));
      const refused = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(
            makeOpenCodeProcessLive({
              confinement: { prepare },
              platform: "win32",
              runtimeConfigResolver: async () => undefined,
              startupTimeoutMs: 2_000,
            }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, ...launch }),
          ),
        ),
      );
      expect(refused).toMatchObject({ category: "incompatible", message });
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("writes a deny-everything Chat permission configuration for OpenCode on Windows outside Strict", () => {
    const profile = createPrivateOpenCodeProfile(
      projectOpenCodeRuntimeConfig({}),
      {},
      tmpdir,
      [{ action: "*", resource: "*", effect: "deny" }],
      true,
      { docs: { type: "local", command: ["node", "docs.js"] } },
      true,
      true,
    );
    try {
      const configPath = profile.environment.OPENCODE_CONFIG;
      expect(configPath).toBeDefined();
      const written = JSON.parse(readFileSync(configPath ?? "", "utf8")) as Record<string, unknown>;
      expect(written.permission).toEqual({ "*": "deny" });
      expect(written.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
      expect(written.mcp).toBeUndefined();
    } finally {
      profile.cleanup();
    }
  });

  it("starts OpenCode Chat on Windows outside Strict unconfined with a deny-everything permission ruleset and separates private-config attestation from OS confinement", async () => {
    const unverified = probeWrapper("ready");
    const verified = probeWrapper("isolation-supported");
    const prepare = vi.fn((input: { executable: string; args: ReadonlyArray<string> }) => ({
      command: input.executable,
      args: input.args,
    }));
    const unverifiedStarted = await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement: { prepare },
          platform: "win32",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: unverified.binaryPath,
          cwd: unverified.root,
          mode: "chat",
          executionPolicy: "approval-gated",
          strict: false,
        }),
      ),
    );
    expect(unverifiedStarted.isolatedConfiguration).toBeUndefined();
    expect(unverifiedStarted.privateConfiguration).toBeUndefined();

    const verifiedStarted = await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement: { prepare },
          platform: "win32",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: verified.binaryPath,
          cwd: verified.root,
          mode: "chat",
          executionPolicy: "approval-gated",
          strict: false,
        }),
      ),
    );
    expect(verifiedStarted.isolatedConfiguration).toBeUndefined();
    expect(verifiedStarted.privateConfiguration).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("refuses a 2.x Chat or Plan launch before anything starts where the jail can start no process", async () => {
    const fixture = probeWrapper("ready");
    for (const launch of [
      { mode: "chat", executionPolicy: "plan" },
      { mode: "chat", executionPolicy: "full-access" },
      { mode: "code", executionPolicy: "plan" },
      { mode: "work", executionPolicy: "plan" },
    ] as const) {
      let servePrepared = false;
      const confinement: ProcessConfinementPort = {
        prepare: (input) => {
          if (input.args.includes("serve")) servePrepared = true;
          return { command: input.executable, args: input.args };
        },
      };
      const refused = await Effect.runPromise(
        Effect.flip(
          Effect.scoped(
            makeOpenCodeProcessLive({
              confinement,
              platform: "freebsd",
              runtimeConfigResolver: async () => undefined,
              startupTimeoutMs: 2_000,
            }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, ...launch }),
          ),
        ),
      );
      expect(refused).toMatchObject({
        category: "unsupported",
        message: OPENCODE_CHAT_PLAN_REFUSAL,
      });
      expect(servePrepared).toBe(false);
    }
  });

  it("starts a 2.x Chat or Plan launch on Linux in a read-only view that admits processes, with the git stand-in first", async () => {
    const fixture = probeWrapper("ready");
    for (const launch of [
      { mode: "chat", executionPolicy: "approval-gated" },
      { mode: "code", executionPolicy: "plan" },
      { mode: "work", executionPolicy: "plan" },
    ] as const) {
      let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
      let standinTarget: string | undefined;
      const confinement: ProcessConfinementPort = {
        prepare: (input) => {
          captured = input;
          const standin = readdirSync(input.temporaryDirectory).find((entry) =>
            entry.startsWith("git-standin-"),
          );
          if (standin !== undefined) {
            standinTarget = readlinkSync(join(input.temporaryDirectory, standin, "bin", "git"));
          }
          return { command: input.executable, args: input.args };
        },
      };
      await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement,
            platform: "linux",
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
          }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, ...launch }),
        ),
      );
      expect(captured, `${launch.mode} ${launch.executionPolicy}`).toMatchObject({
        writeBoundRoot: false,
        allowProcessExec: true,
        allowProcessFork: true,
      });
      expect(captured?.extraRules).toBeUndefined();
      // A repository's own Git configuration never runs from Chat or Plan.
      expect(standinTarget).toBe("/usr/bin/false");
    }
  });

  it("lets a 2.x Work or Code launch outside Plan fork and exec on Linux", async () => {
    const fixture = probeWrapper("ready");
    for (const launch of [
      { mode: "work", executionPolicy: "approval-gated" },
      { mode: "code", executionPolicy: "auto-accept-edits" },
    ] as const) {
      let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
      const confinement: ProcessConfinementPort = {
        prepare: (input) => {
          captured = input;
          return { command: input.executable, args: input.args };
        },
      };
      await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement,
            platform: "linux",
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
          }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, ...launch }),
        ),
      );
      expect(captured?.allowProcessFork).toBe(true);
      expect(captured?.allowProcessExec).toBe(true);
      expect(captured?.extraRules).toBeUndefined();
    }
  });

  it("lifts OpenCode's Project configuration switch only for a trusted Project outside Plan", async () => {
    const launch = async (executionPolicy: "approval-gated" | "plan") => {
      const root = fixtureRoot("isolation-supported");
      const binaryPath = join(root, "opencode-project-config-fixture");
      const recordPath = join(root, ".fake-opencode-project-config");
      writeFileSync(
        binaryPath,
        `#!/bin/sh\ncd '${root}'\nprintf '%s' "\${OPENCODE_DISABLE_PROJECT_CONFIG-<unset>}" > '${recordPath}'\nexec '${fakeCliPath}' "$@"\n`,
      );
      chmodSync(binaryPath, 0o755);
      const server = await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            // A wrapping launcher, as the real confinement uses, so isolation
            // could be attested where the launch allows it.
            confinement: {
              prepare: (input) => ({ command: "/bin/sh", args: [input.executable, ...input.args] }),
            },
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
          }).start({ binaryPath, cwd: root, mode: "code", executionPolicy, projectConfig: true }),
        ),
      );
      return { switch: readFileSync(recordPath, "utf8"), server };
    };

    const trusted = await launch("approval-gated");
    expect(trusted.switch).toBe("<unset>");
    // The Project's own plugins and servers may enter, so it is never isolated.
    expect(trusted.server.isolatedConfiguration).toBeUndefined();
    const plan = await launch("plan");
    expect(plan.switch).toBe("1");
    expect(plan.server.isolatedConfiguration).toBe(true);
  });

  it("keeps Code mode exec allowed without the stand-in exec grant", async () => {
    const fixture = probeWrapper("ready");
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "code",
          executionPolicy: "approval-gated",
        }),
      ),
    );
    // Code mode allows exec behind approvals; the stand-in grant is not added.
    expect(captured?.allowProcessExec).toBe(true);
    expect(captured?.allowProcessFork).toBe(true);
    const rules = captured?.extraRules ?? [];
    expect(
      rules.some((rule) => rule.includes('(allow process-exec (literal "/usr/bin/false"))')),
    ).toBe(false);
  });

  it("starts Full access with no wrapper around the runtime", async () => {
    const fixture = probeWrapper("ready");
    const prepared: Array<ReadonlyArray<string>> = [];
    const confinement: ProcessConfinementPort = {
      // The version probe is confined as at every level; the runtime launch
      // is not wrapped at all.
      prepare: (input) => {
        prepared.push(input.args);
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "code",
          executionPolicy: "full-access",
        }),
      ),
    );
    expect(prepared.some((args) => args.includes("serve"))).toBe(false);
  });

  it("starts Work and Code below Full access outside Strict with no wrapper, on OpenCode's own permission rules", async () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const mode of ["work", "code"] as const) {
        for (const executionPolicy of ["approval-gated", "auto-accept-edits"] as const) {
          const fixture = profileRecordingWrapper("isolation-supported");
          const prepared: Array<ReadonlyArray<string>> = [];
          let proxied = 0;
          const started = await Effect.runPromise(
            Effect.scoped(
              makeOpenCodeProcessLive({
                confinement: {
                  prepare: (input) => {
                    prepared.push(input.args);
                    return { command: input.executable, args: input.args };
                  },
                },
                platform,
                runtimeConfigResolver: async () => undefined,
                startupTimeoutMs: 2_000,
                runtimeNetwork: {
                  start: async () => {
                    proxied += 1;
                    return { status: "open" };
                  },
                },
              }).start({
                binaryPath: fixture.binaryPath,
                cwd: fixture.root,
                mode,
                executionPolicy,
                strict: false,
              }),
            ),
          );
          expect(prepared.some((args) => args.includes("serve"))).toBe(false);
          expect(proxied).toBe(0);
          // A verified release on Octant's private configuration still
          // carries app-managed tools, without claiming OS confinement.
          expect(started.isolatedConfiguration).toBeUndefined();
          expect(started.privateConfiguration).toBe(true);
        }
      }
    }
  });

  it("keeps the wrapper below Full access under Strict, in Plan and Chat, for a kept sandbox, and for the readiness check", async () => {
    for (const launch of [
      { mode: "code", executionPolicy: "approval-gated" },
      { mode: "work", executionPolicy: "auto-accept-edits", strict: true },
      { mode: "code", executionPolicy: "plan", strict: false },
      { mode: "chat", executionPolicy: "approval-gated", strict: false },
      { mode: "code", executionPolicy: "full-access", fullAccessSandbox: true, strict: false },
      { mode: "code", executionPolicy: "approval-gated", purpose: "probe" },
    ] as const) {
      const fixture = profileRecordingWrapper("isolation-supported");
      const prepared: Array<ReadonlyArray<string>> = [];
      const started = await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement: {
              prepare: (input) => {
                prepared.push(input.args);
                return { command: input.executable, args: input.args };
              },
            },
            platform: "darwin",
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
          }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, ...launch }),
        ),
      );
      expect(prepared.some((args) => args.includes("serve"))).toBe(true);
      expect(started.privateConfiguration).toBeUndefined();
    }
  });

  it("wraps a Full access server that keeps the sandbox as Accept edits would, on its own egress proxy", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const prepared: Parameters<ProcessConfinementPort["prepare"]>[0][] = [];
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        prepared.push(input);
        return { command: input.executable, args: input.args };
      },
    };
    const policies: Array<string> = [];
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
          runtimeNetwork: {
            start: async (input) => {
              policies.push(input.executionPolicy);
              return {
                status: "proxied",
                endpoint: { kind: "loopback", port: 47004 },
                environment: { HTTPS_PROXY: "http://octant:token@127.0.0.1:47004" },
                release: async () => undefined,
              };
            },
          },
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "code",
          executionPolicy: "full-access",
          fullAccessSandbox: true,
        }),
      ),
    );
    const server = prepared.find((input) => input.args.includes("serve"));
    expect(server).toMatchObject({
      boundRoot: realpathSync(fixture.root),
      writeBoundRoot: true,
      allowProcessExec: true,
      networkEgress: { kind: "proxied", endpoint: { kind: "loopback", port: 47004 } },
    });
    expect(policies).toEqual(["auto-accept-edits"]);
  });

  it("starts the server on its own egress proxy below Full access and keeps loopback off the proxy", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    const started: Array<{ readonly runtime: string; readonly root: string }> = [];
    let released = 0;
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
          runtimeNetwork: {
            start: async (input) => {
              started.push({ runtime: input.runtime, root: input.root });
              return {
                status: "proxied",
                endpoint: { kind: "loopback", port: 47003 },
                environment: { HTTPS_PROXY: "http://octant:token@127.0.0.1:47003" },
                release: async () => {
                  released += 1;
                },
              };
            },
          },
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "code",
          executionPolicy: "approval-gated",
        }),
      ),
    );
    expect(started).toEqual([{ runtime: "opencode", root: fixture.root }]);
    expect(captured?.networkEgress).toEqual({
      kind: "proxied",
      endpoint: { kind: "loopback", port: 47003 },
    });
    expect(released).toBe(1);
  });

  it.each(["approval-gated", "auto-accept-edits", "full-access"] as const)(
    "launches a Work session at %s under the confinement a Code session at that level gets",
    async (executionPolicy) => {
      const launchFor = async (mode: "work" | "code") => {
        const fixture = profileRecordingWrapper("isolation-supported");
        const prepared: Parameters<ProcessConfinementPort["prepare"]>[0][] = [];
        const confinement: ProcessConfinementPort = {
          prepare: (input) => {
            prepared.push(input);
            return { command: input.executable, args: input.args };
          },
        };
        await Effect.runPromise(
          Effect.scoped(
            makeOpenCodeProcessLive({
              confinement,
              platform: "darwin",
              runtimeConfigResolver: async () => undefined,
              startupTimeoutMs: 2_000,
            }).start({ binaryPath: fixture.binaryPath, cwd: fixture.root, mode, executionPolicy }),
          ),
        );
        return prepared.map((input) => ({
          writeBoundRoot: input.writeBoundRoot,
          allowProcessExec: input.allowProcessExec,
          allowProcessFork: input.allowProcessFork,
          networkEgress: input.networkEgress,
        }));
      };
      const work = await launchFor("work");
      expect(work).toEqual(await launchFor("code"));
    },
  );

  // The agent is a loopback HTTP server, so the confinement has to let it
  // listen on the port this launch reserved. Without the bind it exits before
  // readiness when OS egress is none. Chat and Work turns now allow the
  // provider endpoints; Plan still needs the bind.
  it("lets the confined server listen on the port it reserved", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          // Seatbelt spellings only exist for Darwin; off it the launch's
          // loopback rides network egress and carries no extra rules.
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "work",
          executionPolicy: "approval-gated",
          loopbackPorts: [41_234],
        }),
      ),
    );

    const rules = captured?.extraRules ?? [];
    expect(rules.find((rule) => rule.includes("network-bind"))).toMatch(
      /^\(allow network-bind \(local ip "localhost:\d+"\)\)$/,
    );
    expect(rules.some((rule) => rule.includes("network-inbound"))).toBe(true);
    expect(rules).toContain('(allow network-outbound (remote ip "localhost:41234"))');
    // Work shares Code's shell at the thread's level, so a Work launch may
    // exec and fork exactly as a Code launch at the same level does.
    expect(captured?.allowProcessExec).toBe(true);
    expect(captured?.allowProcessFork).toBe(true);
  });

  // Bubblewrap refuses any rule it cannot express: per-port loopback has no
  // spelling there — loopback rides the launch's network egress choice — and
  // the tool-home discovery reads are already covered by file-read-star.
  it("sends no Seatbelt rules to a Linux confinement", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const captured: Parameters<ProcessConfinementPort["prepare"]>[0][] = [];
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured.push(input);
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "linux",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "work",
          executionPolicy: "approval-gated",
          loopbackPorts: [41_234],
        }),
      ),
    );
    expect(captured.length).toBeGreaterThan(0);
    for (const input of captured) expect(input.extraRules).toBeUndefined();
  });

  it("hands a proxied Linux launch its tool bridge ports to relay, and a shared-network one none", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const launches = async (proxied: boolean) => {
      const prepared: Parameters<ProcessConfinementPort["prepare"]>[0][] = [];
      await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement: {
              prepare: (input) => {
                prepared.push(input);
                return { command: input.executable, args: input.args };
              },
            },
            platform: "linux",
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
            runtimeNetwork: {
              start: async () =>
                proxied
                  ? {
                      status: "proxied",
                      endpoint: { kind: "unix-socket", path: "/tmp/octant-egress.sock" },
                      environment: {},
                      release: async () => undefined,
                    }
                  : { status: "open" },
            },
          }).start({
            binaryPath: fixture.binaryPath,
            cwd: fixture.root,
            mode: "code",
            executionPolicy: "approval-gated",
            loopbackPorts: [41_234],
          }),
        ),
      );
      return prepared.find((input) => input.args.includes("serve"));
    };
    expect((await launches(true))?.loopbackRelayPorts).toEqual([41_234]);
    const shared = await launches(false);
    expect(shared?.networkEgress).toBe("allow");
    expect(shared?.loopbackRelayPorts).toBeUndefined();
  });

  // OpenCode 2 resolves each bundled coding tool's home directory while it
  // lists providers, and a refusal there is fatal to the listing, so the
  // confined child has to resolve those paths without being able to read them.
  it("resolves the tool home directories OpenCode probes without opening them", async () => {
    const fixture = profileRecordingWrapper("isolation-supported");
    const home = mkdtempSync(join(tmpdir(), "octant-opencode-discovery-"));
    directories.push(home);
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".agents"));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".claude.json"), "{}");
    const resolvedHome = realpathSync(home);
    let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    const confinement: ProcessConfinementPort = {
      prepare: (input) => {
        captured = input;
        return { command: input.executable, args: input.args };
      },
    };
    await Effect.runPromise(
      Effect.scoped(
        makeOpenCodeProcessLive({
          confinement,
          platform: "darwin",
          runtimeConfigResolver: async () => undefined,
          startupTimeoutMs: 2_000,
          inheritedEnvironment: { ...process.env, HOME: home },
        }).start({
          binaryPath: fixture.binaryPath,
          cwd: fixture.root,
          mode: "work",
          executionPolicy: "approval-gated",
        }),
      ),
    );

    const rules = captured?.extraRules ?? [];
    expect(rules).toContain(
      `(allow file-read-metadata (literal "${join(resolvedHome, ".claude")}"))`,
    );
    expect(rules).toContain(`(allow file-read-data (literal "${join(resolvedHome, ".claude")}"))`);
    expect(rules).toContain(`(allow file-read-data (literal "${join(resolvedHome, ".agents")}"))`);
    expect(rules).toContain(
      `(allow file-read-metadata (literal "${join(resolvedHome, ".claude.json")}"))`,
    );
    // A bundled tool home OpenCode does not probe stays out of the set even
    // when it exists, and no rule opens a subtree: the probe may resolve each
    // node and still read nothing inside.
    expect(rules.some((rule) => rule.includes(`"${join(resolvedHome, ".codex")}"`))).toBe(false);
    expect(rules.some((rule) => rule.includes(`(subpath "${resolvedHome}`))).toBe(false);
  });

  describe("the person's global CLAUDE.md under confinement", () => {
    function claudeHome(): { readonly home: string; readonly file: string } {
      const home = mkdtempSync(join(tmpdir(), "octant-opencode-claude-home-"));
      directories.push(home);
      mkdirSync(join(home, ".claude", "projects"), { recursive: true });
      writeFileSync(join(home, ".claude", "CLAUDE.md"), "Prefer small diffs.\n");
      writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
      writeFileSync(join(home, ".claude", "settings.json"), "{}");
      return { home, file: join(realpathSync(home), ".claude", "CLAUDE.md") };
    }

    async function confinedLaunch(
      home: string,
      platform: NodeJS.Platform,
    ): Promise<Parameters<ProcessConfinementPort["prepare"]>[0]> {
      const fixture = profileRecordingWrapper();
      let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
      await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement: {
              prepare: (input) => {
                captured = input;
                return { command: input.executable, args: input.args };
              },
            },
            platform,
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
            inheritedEnvironment: { ...process.env, HOME: home },
          }).start({
            binaryPath: fixture.binaryPath,
            cwd: fixture.root,
            mode: "work",
            executionPolicy: "approval-gated",
          }),
        ),
      );
      if (captured === undefined) throw new Error("the launch was never confined");
      return captured;
    }

    // The wall used to reopen this one file for OpenCode 1, which read it
    // where it found no global AGENTS.md. No launch opens it now.
    it("opens no file in .claude for a launch", async () => {
      const { home, file } = claudeHome();
      for (const platform of ["darwin", "linux"] as const) {
        const input = await confinedLaunch(home, platform);
        expect((input.extraRules ?? []).some((rule) => rule.includes("CLAUDE.md"))).toBe(false);
        expect(input.privateHomeAllowPaths ?? []).not.toContain(file);
      }
    });
  });

  describe("the person's global OpenCode AGENTS.md", () => {
    function agentsHome(): {
      readonly home: string;
      readonly file: string;
      readonly folder: string;
    } {
      const home = mkdtempSync(join(tmpdir(), "octant-opencode-agents-home-"));
      directories.push(home);
      mkdirSync(join(home, ".config", "opencode"), { recursive: true });
      writeFileSync(join(home, ".config", "opencode", "AGENTS.md"), "Answer in British English.\n");
      writeFileSync(join(home, ".config", "opencode", "opencode.json"), "{}");
      const folder = join(realpathSync(home), ".config", "opencode");
      return { home, file: join(folder, "AGENTS.md"), folder };
    }

    /**
     * Starts OpenCode with a stand-in that records what it finds at its own
     * global lookup, `$OPENCODE_CONFIG_DIR/AGENTS.md`, and the wall it got.
     * The launch is outside Strict and in Plan unless a test says otherwise:
     * only a launch outside Strict links the file, and Plan keeps the wall
     * whose rules these tests read.
     */
    async function launch(
      home: string,
      options: {
        readonly platform: NodeJS.Platform;
        readonly executionPolicy?: ProviderExecutionPolicy;
        readonly runsAsItself?: boolean;
        readonly mode?: string;
        readonly environment?: NodeJS.ProcessEnv;
        readonly strict?: true;
      },
    ): Promise<{
      readonly seen: string;
      readonly input: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
    }> {
      const root = fixtureRoot(options.mode ?? "v2-2-ready");
      const binaryPath = join(root, "opencode-agents-fixture");
      const seenPath = join(root, ".seen-global-agents");
      writeFileSync(
        binaryPath,
        `#!/bin/sh\ncd '${root}'\ncat "$OPENCODE_CONFIG_DIR/AGENTS.md" > '${seenPath}' 2>/dev/null\nexec '${fakeCliPath}' "$@"\n`,
      );
      chmodSync(binaryPath, 0o755);
      let captured: Parameters<ProcessConfinementPort["prepare"]>[0] | undefined;
      await Effect.runPromise(
        Effect.scoped(
          makeOpenCodeProcessLive({
            confinement: {
              prepare: (input) => {
                captured = input;
                return { command: input.executable, args: input.args };
              },
            },
            platform: options.platform,
            runtimeConfigResolver: async () => undefined,
            startupTimeoutMs: 2_000,
            inheritedEnvironment: {
              ...process.env,
              HOME: home,
              XDG_CONFIG_HOME: "",
              OPENCODE_CONFIG_DIR: "",
              ...options.environment,
            },
          }).start({
            binaryPath,
            cwd: root,
            mode: "work",
            executionPolicy: options.executionPolicy ?? "plan",
            ...(options.runsAsItself === false ? {} : { runsAsItself: true as const }),
            ...(options.strict === true ? {} : { strict: false }),
          }),
        ),
      );
      return { seen: readFileSync(seenPath, "utf8"), input: captured };
    }

    it("is not found or opened when OpenCode does not run as itself", async () => {
      const { home, folder } = agentsHome();
      for (const platform of ["darwin", "linux"] as const) {
        const { seen, input } = await launch(home, { platform, runsAsItself: false });
        expect(seen).toBe("");
        expect((input?.extraRules ?? []).some((rule) => rule.includes(folder))).toBe(false);
        expect((input?.privateHomeAllowPaths ?? []).some((path) => path.startsWith(folder))).toBe(
          false,
        );
      }
    });

    it("refuses an AGENTS.md the person protected", async () => {
      const { home, file } = agentsHome();
      applyProtectedFilesChoice({ added: [file], removed: [] });
      try {
        for (const platform of ["darwin", "linux"] as const) {
          const { seen, input } = await launch(home, { platform });
          expect(seen).toBe("");
          expect((input?.extraRules ?? []).some((rule) => rule.includes("AGENTS.md"))).toBe(false);
          expect(input?.privateHomeAllowPaths ?? []).not.toContain(file);
        }
      } finally {
        applyProtectedFilesChoice({ added: [], removed: [] });
      }
    });

    it("refuses an AGENTS.md that is a link, or that sits in a linked folder", async () => {
      const { home } = agentsHome();
      const elsewhere = join(realpathSync(home), "private-notes.md");
      writeFileSync(elsewhere, "not instructions\n");
      const link = join(home, ".config", "opencode", "AGENTS.md");
      rmSync(link);
      symlinkSync(elsewhere, link);
      const linkedFolder = mkdtempSync(join(tmpdir(), "octant-opencode-agents-linked-"));
      directories.push(linkedFolder);
      writeFileSync(join(linkedFolder, "AGENTS.md"), "from a linked folder\n");
      const linkedHome = mkdtempSync(join(tmpdir(), "octant-opencode-agents-home-"));
      directories.push(linkedHome);
      mkdirSync(join(linkedHome, ".config"));
      symlinkSync(linkedFolder, join(linkedHome, ".config", "opencode"));
      for (const candidate of [home, linkedHome]) {
        for (const platform of ["darwin", "linux"] as const) {
          const { seen, input } = await launch(candidate, { platform });
          expect(seen).toBe("");
          const rules = input?.extraRules ?? [];
          expect(rules.some((rule) => rule.includes("AGENTS.md"))).toBe(false);
          expect(
            (input?.privateHomeAllowPaths ?? []).some(
              (path) => path.endsWith("AGENTS.md") || path === elsewhere,
            ),
          ).toBe(false);
        }
      }
    });

    it("is found where OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME names the folder", async () => {
      const { home } = agentsHome();
      const real = realpathSync(home);
      mkdirSync(join(real, "own-config"));
      writeFileSync(join(real, "own-config", "AGENTS.md"), "From the config folder.\n");
      mkdirSync(join(real, "xdg", "opencode"), { recursive: true });
      writeFileSync(join(real, "xdg", "opencode", "AGENTS.md"), "From XDG.\n");
      const fromConfigDirectory = await launch(home, {
        platform: "linux",
        environment: { OPENCODE_CONFIG_DIR: join(real, "own-config") },
      });
      expect(fromConfigDirectory.seen).toBe("From the config folder.\n");
      const fromXdg = await launch(home, {
        platform: "linux",
        environment: { XDG_CONFIG_HOME: join(real, "xdg") },
      });
      expect(fromXdg.seen).toBe("From XDG.\n");
    });

    it("refuses an AGENTS.md behind a linked OPENCODE_CONFIG_DIR or a link inside XDG_CONFIG_HOME", async () => {
      const { home } = agentsHome();
      const real = realpathSync(home);
      const elsewhere = mkdtempSync(join(tmpdir(), "octant-opencode-agents-elsewhere-"));
      directories.push(elsewhere);
      mkdirSync(join(elsewhere, "opencode"));
      writeFileSync(join(elsewhere, "AGENTS.md"), "behind a linked config folder\n");
      writeFileSync(join(elsewhere, "opencode", "AGENTS.md"), "behind a linked XDG folder\n");
      symlinkSync(elsewhere, join(real, "linked-config"));
      for (const environment of [
        { OPENCODE_CONFIG_DIR: join(real, "linked-config") },
        { XDG_CONFIG_HOME: join(real, "linked-config") },
      ]) {
        for (const platform of ["darwin", "linux"] as const) {
          const { seen, input } = await launch(home, { platform, environment });
          expect(seen).toBe("");
          expect((input?.extraRules ?? []).some((rule) => rule.includes("AGENTS.md"))).toBe(false);
          expect(
            (input?.privateHomeAllowPaths ?? []).some((path) => path.startsWith(elsewhere)),
          ).toBe(false);
        }
      }
    });

    it("is what a launch running as itself finds outside Strict, opened by the wall where it is confined", async () => {
      const { home, file, folder } = agentsHome();
      // Work below Full access outside Strict runs with no Octant sandbox, as
      // Full access does; Plan keeps the wall, whose rules open the file.
      for (const executionPolicy of ["approval-gated", "full-access"] as const) {
        const unconfined = await launch(home, { platform: "linux", executionPolicy });
        expect(unconfined.seen).toBe("Answer in British English.\n");
      }
      const onLinux = await launch(home, { platform: "linux" });
      expect(onLinux.seen).toBe("Answer in British English.\n");
      const granted = [
        ...(onLinux.input?.privateHomeAllowPaths ?? []),
        ...(onLinux.input?.readRoots ?? []),
      ];
      expect(granted.filter((path) => path.startsWith(folder))).toEqual([file]);
      expect(onLinux.input?.additionalWriteRoots ?? []).not.toContain(file);
      const onMac = await launch(home, { platform: "darwin" });
      expect(onMac.seen).toBe("Answer in British English.\n");
      expect(
        new Set((onMac.input?.extraRules ?? []).filter((rule) => rule.includes(folder))),
      ).toEqual(
        new Set([
          `(allow file-read-metadata (literal "${folder}"))`,
          `(allow file-read* (literal "${file}"))`,
        ]),
      );
      expect(
        (onMac.input?.privateHomeAllowPaths ?? []).some((path) => path.startsWith(folder)),
      ).toBe(false);
    });

    it("opens nothing for a launch under Strict, or one not running as itself", async () => {
      const { home, folder } = agentsHome();
      for (const platform of ["darwin", "linux"] as const) {
        for (const options of [{ strict: true }, { runsAsItself: false }] as const) {
          const { seen, input } = await launch(home, { platform, ...options });
          expect(seen).toBe("");
          expect((input?.extraRules ?? []).some((rule) => rule.includes(folder))).toBe(false);
        }
      }
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
          expect(decoded).toMatch(/^opencode:[A-Za-z0-9_-]{40,}$/);
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

  it("reports the release it read and serves under OpenCode's own auth identity", async () => {
    const fixture = probeWrapper("ready");
    const observed = await Effect.runPromise(
      Effect.scoped(makePort().start({ binaryPath: fixture.binaryPath, cwd: fixture.root })),
    );

    expect(observed.url.hostname).toBe("127.0.0.1");
    expect(observed.version).toBe("opencode v2.4.1");
    expect(observed.authorization).toMatch(/^Basic b3BlbmNvZGU6/);
  });

  it("writes a launch's permission posture into its private configuration and reports its readable scratch directory", async () => {
    const root = fixtureRoot();
    const binaryPath = join(root, "opencode-config-fixture");
    const configCopy = join(root, ".fake-opencode-config");
    writeFileSync(
      binaryPath,
      `#!/bin/sh\ncd '${root}'\nif [ "$1" = "serve" ]; then cp "$OPENCODE_CONFIG" '${configCopy}'; fi\nOCTANT_FAKE_OPENCODE_MODE=ready exec '${fakeCliPath}' "$@"\n`,
    );
    chmodSync(binaryPath, 0o755);
    const posture = [
      { action: "*", resource: "*", effect: "ask" },
      { action: "octant-bridge_*", resource: "*", effect: "allow" },
    ] as const;

    const scratch = await Effect.runPromise(
      Effect.scoped(
        makePort()
          .start({ binaryPath, cwd: root, permissions: posture })
          .pipe(
            Effect.map((server) => {
              expect(server.temporaryDirectory).toBeDefined();
              expect(existsSync(server.temporaryDirectory ?? "")).toBe(true);
              return server.temporaryDirectory;
            }),
          ),
      ),
    );
    expect(JSON.parse(readFileSync(configCopy, "utf8")).permissions).toEqual(posture);
    expect(existsSync(scratch ?? "")).toBe(false);

    await Effect.runPromise(Effect.scoped(makePort().start({ binaryPath, cwd: root })));
    expect(JSON.parse(readFileSync(configCopy, "utf8")).permissions).toEqual([
      { action: "*", resource: "*", effect: "deny" },
    ]);
  });

  it("starts a supported release older than the newest one read", async () => {
    const probe = probeWrapper("probe-v2-2");
    await expect(Effect.runPromise(probeOpenCode(probe.binaryPath))).resolves.toEqual({
      binaryPath: probe.binaryPath,
      version: "opencode v2.2.0",
    });

    const server = probeWrapper("v2-2-ready");
    const observed = await Effect.runPromise(
      Effect.scoped(makePort().start({ binaryPath: server.binaryPath, cwd: server.root })),
    );
    expect(observed.version).toBe("opencode v2.2.0");
  });

  it.each([
    ["an OpenCode 1 install", "v1-ready", "1.18.21"],
    ["an OpenCode 2 release older than the oldest one supported", "too-old-ready", "2.0.1"],
  ] as const)(
    "reports %s incompatible with the upgrade sentence and starts no server",
    async (_name, mode, detectedVersion) => {
      const fixture = probeWrapper(mode);
      const failure = await failureOf(
        Effect.scoped(makePort().start({ binaryPath: fixture.binaryPath, cwd: fixture.root })),
      );
      expect(failure).toEqual({
        category: "incompatible",
        reason: "runtime-incompatible",
        message: OPENCODE_UPGRADE_MESSAGE,
        diagnostic: {
          stage: "version-check",
          kind: "version-mismatch",
          detectedVersion,
          supportedVersion: "2.0.22",
        },
      });
      expect(failure.message).toBe(
        "This OpenCode is too old for Octant. Upgrade to OpenCode 2 (2.0.22 or later), then check the provider again.",
      );
      // The fixture records each server process it starts; only the version
      // read ran, and that mode records none.
      expect(pids(fixture.root)).toEqual([]);
    },
  );

  it("retries the server on a fresh port when the first launch exits before readiness", async () => {
    const root = fixtureRoot("early-exit");
    const binaryPath = join(root, "opencode-retry-fixture");
    const invocationPath = join(root, ".fake-opencode-invocations");
    writeFileSync(
      binaryPath,
      `#!/bin/sh
cd '${root}'
n=$(cat '${invocationPath}' 2>/dev/null || echo 0)
n=$((n+1))
echo "$n" > '${invocationPath}'
if [ "$1" = "--version" ]; then exec env OCTANT_FAKE_OPENCODE_MODE=ready '${fakeCliPath}' "$@"; fi
if [ "$n" -le 2 ]; then exec env OCTANT_FAKE_OPENCODE_MODE=early-exit '${fakeCliPath}' "$@"; fi
exec env OCTANT_FAKE_OPENCODE_MODE=ready '${fakeCliPath}' "$@"
`,
    );
    chmodSync(binaryPath, 0o755);

    const reservedPorts: number[] = [];
    await Effect.runPromise(
      Effect.scoped(
        makePort(
          {},
          {
            reserveLoopbackPort: async () => {
              const port = 44_100 + reservedPorts.length;
              reservedPorts.push(port);
              return port;
            },
          },
        ).start({ binaryPath, cwd: root }),
      ),
    );

    // The first launch lost its reserved port and exited; the second got a
    // fresh reservation instead of reporting the provider unavailable.
    expect(reservedPorts).toEqual([44_100, 44_101]);
  });

  describe("a Work or Code launch outside Plan", () => {
    const posture = [
      { action: "*", resource: "*", effect: "ask" },
      { action: "octant-bridge_*", resource: "*", effect: "allow" },
    ] as const;
    const ownSetup = { runsAsItself: true, ownToolServers: {} } as const;
    const launch = async (input: {
      readonly strict?: false;
      readonly runsAsItself?: true;
      readonly ownToolServers?: Record<string, never>;
      readonly ownToolServersOff?: true;
      readonly ownChannels?: { readonly telemetry: boolean; readonly selfUpdate: boolean };
      readonly executionPolicy?: "plan";
      /** The release the launch reports; the one read for own configuration by default. */
      readonly release?: string;
    }) => {
      const { release = "opencode v2.4.1", ...start } = input;
      const root = fixtureRoot();
      const binaryPath = join(root, "opencode-own-config-fixture");
      const recordPath = join(root, ".fake-opencode-own-config");
      writeFileSync(
        binaryPath,
        `#!/bin/sh\ncd '${root}'\nif [ "$1" = "--version" ]; then echo '${release}'; exit 0; fi\nif [ "$1" = "serve" ]; then printf 'config=%s\\nconfig-home=%s\\ntmp=%s\\nplugins=%s\\nlsp=%s\\nupdate=%s\\nmodels=%s\\nhost-switch=%s\\ncontent=%s\\n' "\${OPENCODE_CONFIG-<unset>}" "\${XDG_CONFIG_HOME-<unset>}" "\${TMPDIR-<unset>}" "\${OPENCODE_DISABLE_DEFAULT_PLUGINS-<unset>}" "\${OPENCODE_DISABLE_LSP_DOWNLOAD-<unset>}" "\${OPENCODE_DISABLE_AUTOUPDATE-<unset>}" "\${OPENCODE_DISABLE_MODELS_FETCH-<unset>}" "\${OCTANT_TEST_HOST_SWITCH-<unset>}" "\${OPENCODE_CONFIG_CONTENT-<unset>}" > '${recordPath}'; fi\nOCTANT_FAKE_OPENCODE_MODE=ready exec '${fakeCliPath}' "$@"\n`,
      );
      chmodSync(binaryPath, 0o755);
      const server = await Effect.runPromise(
        Effect.scoped(
          makePort({
            inheritedEnvironment: {
              ...process.env,
              XDG_CONFIG_HOME: "/home/person/.config",
              TMPDIR: "/home/person/tmp",
              OCTANT_TEST_HOST_SWITCH: "host-only",
            },
          }).start({
            binaryPath,
            cwd: root,
            mode: "code",
            executionPolicy: "approval-gated",
            permissions: posture,
            ...start,
          }),
        ),
      );
      const recorded = Object.fromEntries(
        readFileSync(recordPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
      return { server, recorded };
    };

    it("reads the person's own configuration outside Strict when the session carries their setup", async () => {
      const { server, recorded } = await launch({ strict: false, ...ownSetup });
      expect(server.ownConfiguration).toBe(true);
      expect(server.unsandboxed).toBe(true);
      expect(server.privateConfiguration).toBeUndefined();
      expect(server.isolatedConfiguration).toBeUndefined();
      expect(recorded).toMatchObject({
        config: "<unset>",
        "config-home": "/home/person/.config",
        tmp: "/home/person/tmp",
        plugins: "<unset>",
        lsp: "<unset>",
        update: "1",
        models: "1",
        "host-switch": "<unset>",
      });
      expect(JSON.parse(recorded.content ?? "")).toEqual({ permissions: posture });
    });

    it("reads the person's own configuration with their tool servers switched off by policy when those are off", async () => {
      const { server, recorded } = await launch({
        strict: false,
        runsAsItself: true,
        ownToolServersOff: true,
      });
      expect(server.ownConfiguration).toBe(true);
      expect(recorded.config).toBe("<unset>");
      expect(JSON.parse(recorded.content ?? "")).toEqual({
        permissions: posture,
        policies: [
          { action: "mcp.use", resource: "*", effect: "deny" },
          { action: "mcp.use", resource: "octant-*", effect: "allow" },
        ],
      });
    });

    it("lets OpenCode update itself there once the person's self-update switch is on", async () => {
      const { recorded } = await launch({
        strict: false,
        ...ownSetup,
        ownChannels: { telemetry: false, selfUpdate: true },
      });
      expect(recorded.update).toBe("<unset>");
      expect(recorded.models).toBe("1");
    });

    // The last column: whether the launch still runs with no Octant sandbox
    // outside Strict, which is what admits Octant's tools beside the rest.
    it.each([
      ["under Strict", { ...ownSetup }, undefined],
      ["outside Strict when the session's own setup is off", { strict: false }, true],
      [
        "outside Strict when the person's tool servers are off and cannot be held off there",
        { strict: false, runsAsItself: true },
        true,
      ],
      [
        "under Strict when the person's tool servers are off",
        { runsAsItself: true, ownToolServersOff: true },
        undefined,
      ],
      ["in Plan", { strict: false, ...ownSetup, executionPolicy: "plan" }, undefined],
      [
        "on a release older than the one read for it",
        { strict: false, ...ownSetup, release: "opencode v2.2.0" },
        true,
      ],
    ] as const)("keeps Octant's private configuration %s", async (_name, input, unsandboxed) => {
      const { server, recorded } = await launch(input);
      expect(server.ownConfiguration).toBeUndefined();
      expect(server.unsandboxed).toBe(unsandboxed);
      expect(recorded.config).toMatch(/octant-config-home-.*\/opencode\.json$/);
      expect(recorded["config-home"]).toMatch(/octant-config-home-/);
      expect(recorded.tmp).toMatch(/octant-tmp-/);
      expect(recorded.content).toBe("<unset>");
      expect(recorded.plugins).toBe("<unset>");
      expect(recorded.lsp).toBe("<unset>");
      expect(recorded.update).toBe("1");
      expect(recorded.models).toBe("1");
    });

    it("keeps every variable of Octant's own out of a launch, under Strict and outside it", async () => {
      expect((await launch({ strict: false })).recorded["host-switch"]).toBe("<unset>");
      expect((await launch({})).recorded["host-switch"]).toBe("<unset>");
    });
  });

  describe("the environment a launch receives", () => {
    const names = [
      "HOME",
      "PATH",
      "LC_ALL",
      "XDG_DATA_HOME",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "NPM_TOKEN",
      "HTTPS_PROXY",
      "OCTANT_TEST_HOST_SWITCH",
    ] as const;
    const launch = async (start: Partial<OpenCodeProcessStartInput>) => {
      const root = fixtureRoot();
      const binaryPath = join(root, "opencode-environment-list-fixture");
      const recordPath = join(root, ".fake-opencode-environment-list");
      writeFileSync(
        binaryPath,
        `#!/bin/sh\ncd '${root}'\nif [ "$1" = "serve" ]; then { ${names
          .map((name) => `printf '${name}=%s\\n' "\${${name}-<unset>}"`)
          .join("; ")}; } > '${recordPath}'; fi\nexec '${fakeCliPath}' "$@"\n`,
      );
      chmodSync(binaryPath, 0o755);
      await Effect.runPromise(
        Effect.scoped(
          makePort({
            inheritedEnvironment: {
              HOME: "/home/person",
              PATH: process.env.PATH,
              LC_ALL: "en_GB.UTF-8",
              XDG_DATA_HOME: "/home/person/.local/share",
              OPENAI_API_KEY: "model-key",
              GH_TOKEN: "github-token",
              NPM_TOKEN: "npm-token",
              HTTPS_PROXY: "http://proxy.invalid:8080",
              OCTANT_TEST_HOST_SWITCH: "host-only",
            },
          }).start({ binaryPath, cwd: root, mode: "code", executionPolicy: "plan", ...start }),
        ),
      );
      return Object.fromEntries(
        readFileSync(recordPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => {
            const at = line.indexOf("=");
            return [line.slice(0, at), line.slice(at + 1)];
          }),
      );
    };

    it("gives a Strict thread a short fixed list, every model provider's key, and the names the person let through", async () => {
      const strict = await launch({
        ownChannels: {
          telemetry: false,
          selfUpdate: false,
          // A model provider's key and a variable of Octant's own never join
          // the list, whatever a stored list holds.
          credentialPassThrough: ["NPM_TOKEN", "OCTANT_TEST_HOST_SWITCH"],
        },
      });
      expect(strict).toEqual({
        HOME: "/home/person",
        PATH: expect.stringContaining(process.env.PATH ?? ""),
        LC_ALL: "en_GB.UTF-8",
        XDG_DATA_HOME: "/home/person/.local/share",
        OPENAI_API_KEY: "model-key",
        GH_TOKEN: "<unset>",
        NPM_TOKEN: "npm-token",
        HTTPS_PROXY: "<unset>",
        OCTANT_TEST_HOST_SWITCH: "<unset>",
      });
      // With no list, nothing beyond the fixed names crosses.
      expect((await launch({})).NPM_TOKEN).toBe("<unset>");
    });

    it("leaves the person's environment as it was outside Strict, whatever the list holds", async () => {
      const open = await launch({
        strict: false,
        ownChannels: { telemetry: false, selfUpdate: false, credentialPassThrough: [] },
      });
      expect(open).toMatchObject({
        GH_TOKEN: "github-token",
        NPM_TOKEN: "npm-token",
        HTTPS_PROXY: "http://proxy.invalid:8080",
        OPENAI_API_KEY: "model-key",
        OCTANT_TEST_HOST_SWITCH: "<unset>",
      });
    });

    it("keeps the host environment for the readiness check and for a thread outside Strict that keeps its sandbox", async () => {
      for (const start of [
        { purpose: "probe" },
        { strict: false, executionPolicy: "full-access", fullAccessSandbox: true },
      ] as const) {
        expect(await launch(start)).toMatchObject({
          GH_TOKEN: "github-token",
          HTTPS_PROXY: "http://proxy.invalid:8080",
          // The broker variables are stripped; any other variable of
          // Octant's own reached these launches before and still does.
          OCTANT_TEST_HOST_SWITCH: "host-only",
        });
      }
    });
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
      "broker-url=<unset>\nbroker-token=<unset>\ndesktop-secret=<unset>\nallowed=<unset>\nupdater=1\nclaude-skills=1\nconfig=<unset>\n",
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
      diagnostic: { stage: "launch", kind: "timed-out" },
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
    // The launch diagnostic is what explains a death that printed nothing, and
    // the bytes the process did write arrive as the classifier's sentence
    // rather than as themselves.
    expect(failure.diagnostic).toEqual({
      stage: "launch",
      kind: "exited",
      exitCode: 23,
      stderrContext: "Provider process wrote redacted diagnostic output.",
    });
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
