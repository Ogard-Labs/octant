import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ProviderExecutionPolicy, ProviderToolDefinition } from "@octant/contracts";
import { Effect } from "effect";
import {
  WINDOWS_KEPT_SANDBOX_REFUSAL,
  WINDOWS_STRICT_REFUSAL,
} from "@octant/domain/guardrail-policy";
import { afterEach, describe, expect, it } from "vitest";
import {
  makePiConfinementLive,
  makePiProcessLive,
  piArguments,
  piExtensionSource,
  piProcessEnvironment,
  sanitizePiEnvironment,
  type PiConfinementPort,
} from "./piProcess";
import {
  seatbeltAllowRule,
  seatbeltDenyRule,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";

/**
 * These cases assert credential wiring and lifecycle, not the profile. The live
 * builder refuses on a host with no sandbox runtime — Linux CI has no
 * bubblewrap — so the version launch is prepared with confinement passed
 * straight through.
 */
const passthroughVersionProbeConfinement: ProcessConfinementPort = {
  prepare: (input) => ({ command: input.executable, args: input.args }),
};

const roots: string[] = [];

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-pi-")));
  roots.push(base);
  const root = join(base, "project");
  const home = join(base, "managed");
  const binary = join(base, "pi");
  const auth = join(base, "auth.json");
  const models = join(base, "models.json");
  const sandbox = join(base, "sandbox-exec");
  const bwrap = join(base, "bwrap");
  mkdirSync(root);
  writeFileSync(binary, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(sandbox, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(bwrap, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  writeFileSync(auth, "private", { mode: 0o600 });
  writeFileSync(models, '{"providers":[]}', { mode: 0o600 });
  chmodSync(binary, 0o700);
  return { base, root, home, binary, auth, models, sandbox, bwrap };
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi process boundary", () => {
  it("prepends the binary directory and approved home bins so env-shebang runtimes resolve", () => {
    const environment = piProcessEnvironment(
      "/Users/test/lib/node_modules/pkg/dist/cli.js",
      { HOME: "/Users/test", PATH: ["/usr/bin", "/bin"].join(delimiter) },
      "/tmp/pi-home",
    );

    expect(environment.PATH).toBe(
      [
        "/Users/test/lib/node_modules/pkg/dist",
        "/Users/test/.local/bin",
        "/Users/test/.bun/bin",
        "/Users/test/.kimi-code/bin",
        "/Users/test/.grok/bin",
        "/usr/bin",
        "/bin",
      ].join(delimiter),
    );
  });

  it("gives a Pi process only the credentials its model provider reads", () => {
    const host = {
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "anthropic-key",
      ANTHROPIC_OAUTH_TOKEN: "anthropic-token",
      OPENAI_API_KEY: "openai-key",
      OPENAI_BASE_URL: "https://openai.example",
      AZURE_OPENAI_API_KEY: "azure-key",
      AZURE_OPENAI_BASE_URL: "https://azure.example",
      AZURE_OPENAI_RESOURCE_NAME: "azure-resource",
      GEMINI_API_KEY: "gemini-key",
      OPENROUTER_API_KEY: "openrouter-key",
      XAI_API_KEY: "xai-key",
    };
    const credentialsFor = (provider: string) =>
      Object.keys(sanitizePiEnvironment(host, "/managed", "enabled", provider))
        .filter((name) => /(_API_KEY|_TOKEN|_BASE_URL|_RESOURCE_NAME)$/.test(name))
        .sort();

    expect(credentialsFor("anthropic")).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]);
    expect(credentialsFor("openai")).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    expect(credentialsFor("azure-openai-responses")).toEqual([
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
      "AZURE_OPENAI_RESOURCE_NAME",
    ]);
    expect(credentialsFor("azure")).toEqual(credentialsFor("azure-openai-responses"));
    expect(credentialsFor("openrouter")).toEqual(["OPENROUTER_API_KEY"]);
    expect(sanitizePiEnvironment(host, "/managed", "enabled", "xai")).toMatchObject({
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      HOME: "/managed",
      PI_CODING_AGENT_DIR: "/managed",
      XAI_API_KEY: "xai-key",
    });
  });

  it("outside Strict gives a Pi process the host's environment less Octant's variables and other providers' keys, with telemetry left to the person", () => {
    const host = {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      GH_TOKEN: "gh-token",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      OCTANT_PI_TOOL_BRIDGE_TOKEN: "octant-secret",
    };
    const open = sanitizePiEnvironment(host, "/managed", "enabled", "openai", false);
    expect(open).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/managed",
      PI_CODING_AGENT_DIR: "/managed",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      GH_TOKEN: "gh-token",
      OPENAI_API_KEY: "openai-key",
      PI_SKIP_VERSION_CHECK: "1",
    });
    expect(open).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(open).not.toHaveProperty("OCTANT_PI_TOOL_BRIDGE_TOKEN");
    expect(open).not.toHaveProperty("PI_TELEMETRY");
    const strict = sanitizePiEnvironment(host, "/managed", "enabled", "openai");
    expect(strict).toMatchObject({ PI_TELEMETRY: "0" });
    expect(strict).not.toHaveProperty("GH_TOKEN");
  });

  it("gives a discovery run, or a provider with no host variable, no provider credential", () => {
    const host = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "anthropic-key",
      OPENAI_API_KEY: "openai-key",
      XAI_API_KEY: "xai-key",
    };
    const held = (environment: NodeJS.ProcessEnv) =>
      Object.keys(environment).filter((name) => name.endsWith("_API_KEY"));

    expect(held(sanitizePiEnvironment(host, "/managed"))).toEqual([]);
    // Pi keeps an OAuth login in auth.json, so its provider has nothing to read here.
    expect(held(sanitizePiEnvironment(host, "/managed", "enabled", "openai-codex"))).toEqual([]);
    // The name is a model ID prefix, never a key into the table's own prototype.
    expect(held(sanitizePiEnvironment(host, "/managed", "enabled", "constructor"))).toEqual([]);
    expect(sanitizePiEnvironment(host, "/managed").PATH).toBe("/usr/bin");
  });

  it("starts Pi holding only the credentials of the model provider it was asked to run", async () => {
    const f = fixture();
    const binary = join(f.base, "fake-pi");
    writeFileSync(
      binary,
      '#!/bin/sh\n[ "$1" = "--version" ] && echo 0.85.1 && exit 0\nexec cat\n',
      {
        mode: 0o700,
      },
    );
    const prepared: NodeJS.ProcessEnv[] = [];
    const confinement: PiConfinementPort = {
      prepare: (input) =>
        Effect.sync(() => {
          prepared.push(input.environment);
          return {
            command: input.binaryPath,
            args: [],
            cwd: f.root,
            environment: input.environment,
          };
        }),
    };
    const port = makePiProcessLive({
      confinement,
      versionProbeConfinement: passthroughVersionProbeConfinement,
      inheritedEnvironment: {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
        XAI_API_KEY: "xai-key",
        DATABASE_PASSWORD: "synthetic-unrelated-host-value",
      },
    });
    const start = (modelProvider?: string, kept?: boolean) =>
      Effect.runPromise(
        Effect.scoped(
          port.start({
            binaryPath: binary,
            root: f.root,
            piHome: f.home,
            sessionDirectory: join(f.home, "sessions"),
            sessionId: "session-1",
            mode: "code",
            executionPolicy: kept === undefined ? "approval-gated" : "full-access",
            ...(kept === undefined ? {} : { strict: false, fullAccessSandbox: kept }),
            ...(modelProvider === undefined ? {} : { modelProvider }),
          }),
        ),
      );

    await start("anthropic");
    await start();
    await start("anthropic", true);
    await start("anthropic", false);

    expect(prepared[2]?.DATABASE_PASSWORD).toBeUndefined();
    expect(prepared[3]?.DATABASE_PASSWORD).toBe("synthetic-unrelated-host-value");
    expect(prepared[0]?.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(prepared[0]?.OPENAI_API_KEY).toBeUndefined();
    expect(prepared[0]?.XAI_API_KEY).toBeUndefined();
    expect(Object.keys(prepared[1] ?? {}).filter((name) => name.endsWith("_API_KEY"))).toEqual([]);
  });

  it("registers only the supplied app-managed tools in the explicit extension", () => {
    const tool: ProviderToolDefinition = {
      name: "octant_browser",
      description: "Use the Octant Browser session.",
      inputSchema: { type: "object", properties: { action: { type: "string" } } },
    };
    const extension = piExtensionSource([tool]);

    expect(extension).toContain("pi.registerTool");
    expect(extension).toContain('"name":"octant_browser"');
    expect(extension).toContain("name: definition.name");
    expect(extension).toContain("OCTANT_PI_TOOL_BRIDGE_URL");
    expect(extension).toContain("x-octant-pi-token");
    expect(extension).toContain("octant-tool-attestation");
    expect(
      piArguments("/bridge.ts", "/sessions", "code-1", "code", "approval-gated", [tool.name]),
    ).toEqual(
      expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls,octant_browser"]),
    );
  });

  it("starts Pi on Windows at Full access, below it and in Chat outside Strict with no sandbox, and refuses Strict and a kept sandbox by name", async () => {
    const f = fixture();
    const confinement = makePiConfinementLive({
      platform: "win32",
      credentialPath: f.auth,
      modelsPath: f.models,
      ownSetupPath: join(f.base, "own"),
    });
    const prepare = (level: {
      readonly mode?: "chat" | "code";
      readonly executionPolicy: ProviderExecutionPolicy;
      readonly fullAccessSandbox?: boolean;
      readonly strict?: boolean;
    }) =>
      Effect.runPromise(
        Effect.either(
          confinement.prepare({
            binaryPath: f.binary,
            root: f.root,
            piHome: f.home,
            sessionDirectory: join(f.home, "sessions"),
            sessionId: "session-1",
            mode: "code",
            environment: {},
            ...level,
          }),
        ),
      );
    for (const level of [
      { executionPolicy: "full-access" },
      { executionPolicy: "approval-gated", strict: false },
      { executionPolicy: "plan", strict: false },
      // Chat starts Pi with no built-in tool, so it needs no Octant sandbox.
      { mode: "chat", executionPolicy: "approval-gated", strict: false },
    ] as const) {
      const started = await prepare(level);
      expect(started).toMatchObject({ _tag: "Right", right: { command: f.binary, cwd: f.root } });
      if (started._tag === "Right" && "mode" in level)
        expect(started.right.args).toContain("--no-tools");
      // Pi's own approval bridge still asks Octant below Full access.
      if (started._tag === "Right")
        expect(started.right.environment.OCTANT_PI_APPROVALS).toBe(
          level.executionPolicy === "full-access" ? "disabled" : "enabled",
        );
    }
    expect(await prepare({ executionPolicy: "approval-gated" })).toMatchObject({
      _tag: "Left",
      left: { category: "incompatible", message: WINDOWS_STRICT_REFUSAL },
    });
    expect(await prepare({ mode: "chat", executionPolicy: "approval-gated" })).toMatchObject({
      _tag: "Left",
      left: { category: "incompatible", message: WINDOWS_STRICT_REFUSAL },
    });
    expect(
      await prepare({ executionPolicy: "full-access", fullAccessSandbox: true, strict: false }),
    ).toMatchObject({
      _tag: "Left",
      left: { category: "incompatible", message: WINDOWS_KEPT_SANDBOX_REFUSAL },
    });
  });

  it("refuses resume when the exact native history is missing", async () => {
    const f = fixture();
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      temporaryDirectory: f.base,
    });
    const result = await Effect.runPromise(
      Effect.either(
        confinement.prepare({
          binaryPath: f.binary,
          root: f.root,
          piHome: f.home,
          sessionDirectory: join(f.home, "sessions"),
          sessionId: "session-1",
          resume: true,
          mode: "code",
          executionPolicy: "full-access",
          environment: {},
        }),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { category: "stale-resume" } });
  });

  it("opens the exact native file and refuses a mismatched history header", async () => {
    const f = fixture();
    const directory = join(f.home, "sessions");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, "2026-09-21_session-1.jsonl");
    const contents = JSON.stringify({ type: "session", id: "session-1", cwd: f.root }) + "\n";
    writeFileSync(path, contents);
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      temporaryDirectory: f.base,
    });
    const input = {
      binaryPath: f.binary,
      root: f.root,
      piHome: f.home,
      sessionDirectory: directory,
      sessionId: "session-1",
      resume: true,
      mode: "code" as const,
      executionPolicy: "full-access" as const,
      environment: {},
    };
    const launch = await Effect.runPromise(confinement.prepare(input));
    expect(launch.args).toEqual(expect.arrayContaining(["--session", path]));
    expect(launch.args).not.toContain("--session-id");
    expect(readFileSync(path, "utf8")).toBe(contents);
    writeFileSync(
      path,
      JSON.stringify({ type: "session", id: "session-1", cwd: "/another-project" }) + "\n",
    );
    const refused = await Effect.runPromise(Effect.either(confinement.prepare(input)));
    expect(refused).toMatchObject({ _tag: "Left", left: { category: "stale-resume" } });
  });

  it("grants a Project's extra folder the root's writes, and none to a Chat launch", async () => {
    const f = fixture();
    const notes = `${f.root}-notes`;
    mkdirSync(notes, { recursive: true });
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      temporaryDirectory: f.base,
    });
    const profileFor = async (mode: "code" | "chat") =>
      (
        await Effect.runPromise(
          confinement.prepare({
            binaryPath: f.binary,
            root: mode === "chat" ? f.home : f.root,
            extraFolders: [notes],
            piHome: f.home,
            sessionDirectory: join(f.home, "sessions"),
            sessionId: `${mode}-1`,
            mode,
            executionPolicy: "approval-gated",
            environment: {},
          }),
        )
      ).args[1];
    expect(await profileFor("code")).toContain(`(allow file-write* (subpath "${notes}"))`);
    expect(await profileFor("chat")).not.toContain(notes);
  });

  it("wraps a Full access launch that keeps the sandbox, with no approvals, and leaves open Full access unwrapped", async () => {
    const f = fixture();
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      temporaryDirectory: f.base,
    });
    const launchFor = (fullAccessSandbox: boolean) =>
      Effect.runPromise(
        confinement.prepare({
          binaryPath: f.binary,
          root: f.root,
          piHome: f.home,
          sessionDirectory: join(f.home, "sessions"),
          sessionId: fullAccessSandbox ? "sandboxed-1" : "open-1",
          mode: "code",
          executionPolicy: "full-access",
          ...(fullAccessSandbox ? { fullAccessSandbox: true } : {}),
          environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
        }),
      );
    const open = await launchFor(false);
    expect(open.command).toBe(f.binary);

    const sandboxed = await launchFor(true);
    expect(sandboxed.command).toBe(f.sandbox);
    const profile = sandboxed.args[1] ?? "";
    expect(profile).toContain(`(allow file-write* (subpath "${f.root}"))`);
    expect(profile).toContain("(allow process-exec)");
    // Nothing prompts: Pi's approvals stay off, as at open Full access.
    expect(sandboxed.environment.OCTANT_PI_APPROVALS).toBe("disabled");
    expect(sandboxed.args).toEqual(
      expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls"]),
    );
  });

  it("writes isolated configuration, links provider-owned auth and the person's own Pi setup, and loads the Octant bridge", async () => {
    const f = fixture();
    const own = join(f.base, "own-agent");
    mkdirSync(join(own, "skills"), { recursive: true });
    mkdirSync(join(own, "extensions", "status"), { recursive: true });
    writeFileSync(join(own, "extensions", "guard.ts"), "export default () => {};");
    writeFileSync(join(own, "extensions", "notes.md"), "not an extension");
    writeFileSync(join(own, "AGENTS.md"), "Prefer small diffs.");
    mkdirSync(join(own, "sessions"));
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
      ownSetupPath: own,
      temporaryDirectory: f.base,
    });
    const launch = await Effect.runPromise(
      confinement.prepare({
        binaryPath: f.binary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "session-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment(
          {
            PATH: "/usr/bin",
            ANTHROPIC_API_KEY: "provider-owned",
            AIROUTER_API_KEY: "airouter-owned",
            NODE_OPTIONS: "--inspect",
          },
          f.home,
          "enabled",
          "anthropic",
        ),
      }),
    );

    expect(launch.command).toBe(f.sandbox);
    expect(launch.args[1]).toContain("(allow process-fork)");
    expect(launch.args).toContain("--extension");
    expect(launch.args).toContain("bash,edit,write,read,grep,find,ls");
    // Pi's own discovery stays off; the person's resources are named by path.
    expect(launch.args).toContain("--no-extensions");
    expect(launch.args).toContain("--no-skills");
    expect(launch.args).not.toContain("--no-context-files");
    const piArgs = launch.args.slice(launch.args.indexOf("--no-approve"));
    expect(piArgs).toEqual(expect.arrayContaining(["--skill", join(own, "skills")]));
    const extensions = piArgs.flatMap((arg, index) =>
      piArgs[index - 1] === "--extension" ? [arg] : [],
    );
    expect(extensions).toEqual([
      join(f.home, "octant-approval-bridge.ts"),
      join(own, "extensions", "guard.ts"),
      join(own, "extensions", "status"),
    ]);
    expect(piArgs).not.toContain("--prompt-template");
    expect(lstatSync(join(f.home, "AGENTS.md")).isSymbolicLink()).toBe(true);
    for (const path of [
      join(own, "skills"),
      join(own, "extensions", "guard.ts"),
      join(own, "AGENTS.md"),
    ]) {
      expect(launch.args[1], path).toContain(path);
    }
    // The person's own sessions stay private to the wall.
    expect(launch.args[1]).not.toContain(join(own, "sessions"));
    expect(launch.args).toContain("--session-id");
    expect(launch.args).toContain("session-1");
    expect(launch.environment.ANTHROPIC_API_KEY).toBe("provider-owned");
    expect(launch.environment.AIROUTER_API_KEY).toBeUndefined();
    expect(launch.environment.NODE_OPTIONS).toBeUndefined();
    expect(launch.environment.PI_TELEMETRY).toBe("0");
    expect(launch.environment.PI_SKIP_VERSION_CHECK).toBe("1");
    expect(launch.environment.PI_CODING_AGENT_DIR).toBe(f.home);

    const auth = join(f.home, "auth.json");
    expect(lstatSync(auth).isSymbolicLink()).toBe(true);
    expect(readFileSync(auth, "utf8")).toBe("private");
    const models = join(f.home, "models.json");
    expect(lstatSync(models).isSymbolicLink()).toBe(true);
    expect(readFileSync(models, "utf8")).toBe('{"providers":[]}');
    const settings = JSON.parse(readFileSync(join(f.home, "settings.json"), "utf8"));
    expect(settings).toEqual({ defaultProjectTrust: "never", enableInstallTelemetry: false });
    const bridge = readFileSync(join(f.home, "octant-approval-bridge.ts"), "utf8");
    expect(bridge).toMatch(/tool_call/);
    expect(bridge).toMatch(/ctx\.ui\.confirm/);
    expect(bridge).toMatch(/OCTANT_PI_APPROVALS/);
    expect(bridge).not.toMatch(/install|registerTool|registerCommand/);

    const managed = fixture();
    const managedTool: ProviderToolDefinition = {
      name: "octant_browser",
      inputSchema: { type: "object", properties: {} },
    };
    const managedLaunch = await Effect.runPromise(
      confinement.prepare({
        binaryPath: managed.binary,
        root: managed.root,
        piHome: managed.home,
        sessionDirectory: join(managed.home, "sessions"),
        sessionId: "managed-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, managed.home),
        tools: [managedTool],
        toolBridge: { url: "http://127.0.0.1:43210/octant/test", token: "test-token" },
      }),
    );
    expect(managedLaunch.args).toContain("bash,edit,write,read,grep,find,ls,octant_browser");
    expect(managedLaunch.args[1]).toContain(
      '(allow network-outbound (remote ip "localhost:43210"))',
    );
    expect(managedLaunch.environment.OCTANT_PI_TOOL_BRIDGE_URL).toBe(
      "http://127.0.0.1:43210/octant/test",
    );
    expect(managedLaunch.environment.OCTANT_PI_TOOL_BRIDGE_TOKEN).toBe("test-token");
    const managedBridge = readFileSync(join(managed.home, "octant-approval-bridge.ts"), "utf8");
    expect(managedBridge).toContain('"name":"octant_browser"');
    expect(managedBridge).toContain("pi.registerTool");

    const noEgress = fixture();
    const noEgressLaunch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: noEgress.sandbox,
        temporaryDirectory: noEgress.base,
      }).prepare({
        binaryPath: noEgress.binary,
        root: noEgress.root,
        piHome: noEgress.home,
        sessionDirectory: join(noEgress.home, "sessions"),
        sessionId: "no-egress-1",
        mode: "chat",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, noEgress.home),
        tools: [managedTool],
        toolBridge: { url: "http://127.0.0.1:43211/octant/test", token: "test-token" },
      }),
    );
    expect(noEgressLaunch.args[1]).toContain(
      '(allow network-outbound (remote ip "localhost:43211"))',
    );
    expect(noEgressLaunch.args[1]).toContain("(allow network*)");
  });

  it("reaches only its own egress proxy and its tool bridge when the host routes the runtime through it", async () => {
    const proxied = fixture();
    const launch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: proxied.sandbox,
        temporaryDirectory: proxied.base,
      }).prepare({
        binaryPath: proxied.binary,
        root: proxied.root,
        piHome: proxied.home,
        sessionDirectory: join(proxied.home, "sessions"),
        sessionId: "proxied-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, proxied.home),
        tools: [{ name: "octant_browser", inputSchema: { type: "object", properties: {} } }],
        toolBridge: { url: "http://127.0.0.1:43212/octant/test", token: "test-token" },
        network: {
          endpoint: { kind: "loopback", port: 47006 },
          environment: { HTTPS_PROXY: "http://octant:token@127.0.0.1:47006" },
        },
      }),
    );
    expect(launch.args[1]).not.toContain("(allow network*)");
    expect(launch.args[1]).toContain('(allow network-outbound (remote ip "localhost:47006"))');
    expect(launch.args[1]).toContain('(allow network-outbound (remote ip "localhost:43212"))');
    expect(launch.environment.HTTPS_PROXY).toBe("http://octant:token@127.0.0.1:47006");
  });

  it("lets Pi's own ssh read the Project's server folder and use its agent socket", async () => {
    const f = fixture();
    const folder = join(f.base, "server-folder");
    mkdirSync(join(folder, "bin"), { recursive: true });
    const launch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: f.sandbox,
        temporaryDirectory: f.base,
      }).prepare({
        binaryPath: f.binary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "servers-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
        tools: [],
        servers: { folder, binDirectory: join(folder, "bin"), agentSocket: join(folder, "agent") },
      }),
    );
    expect(launch.args[1]).toContain(folder);
    expect(launch.args[1]).toContain("com.apple.system.opendirectoryd.libinfo");
    expect(launch.environment.SSH_AUTH_SOCK).toBe(join(folder, "agent"));
    expect(launch.environment.PATH).toBe(`${join(folder, "bin")}:/usr/bin`);
  });

  it("loads the person's own Pi skills, templates and context in Work and Code, and their extensions only outside Plan", () => {
    const own = {
      skills: "/own/skills",
      prompts: "/own/prompts",
      extensions: ["/own/extensions/guard.ts"],
    };
    const launch = (mode: "chat" | "work" | "code", policy: ProviderExecutionPolicy) =>
      piArguments("/bridge.ts", "/sessions", "s-1", mode, policy, [], undefined, own);
    const extensionsOf = (args: ReadonlyArray<string>) =>
      args.flatMap((arg, index) => (args[index - 1] === "--extension" ? [arg] : []));
    // Discovery stays off everywhere, which keeps Pi's built-in extensions
    // and a Project's own resources out.
    for (const args of [launch("chat", "approval-gated"), launch("code", "plan")]) {
      expect(args).toEqual(
        expect.arrayContaining(["--no-extensions", "--no-skills", "--no-prompt-templates"]),
      );
    }
    const chat = launch("chat", "approval-gated");
    expect(chat).toEqual(expect.arrayContaining(["--no-context-files", "--no-tools"]));
    expect(chat).not.toContain("--skill");
    expect(extensionsOf(chat)).toEqual(["/bridge.ts"]);
    const plan = launch("code", "plan");
    expect(plan).toEqual(
      expect.arrayContaining(["--skill", "/own/skills", "--prompt-template", "/own/prompts"]),
    );
    expect(plan).not.toContain("--no-context-files");
    expect(extensionsOf(plan)).toEqual(["/bridge.ts"]);
    expect(plan).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls"]));
    for (const policy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      const work = launch("work", policy);
      expect(work).toEqual(expect.arrayContaining(["--skill", "/own/skills"]));
      expect(extensionsOf(work)).toEqual(["/bridge.ts", "/own/extensions/guard.ts"]);
      // The tool list still names only Pi's built-ins, so the bridge decides
      // every side effect below Full access.
      expect(work).toEqual(
        expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls"]),
      );
    }
  });

  it("offers the person's extension tools on a release that takes tool additions, asking for each, and never in Plan", async () => {
    const own = { extensions: ["/own/extensions/deploy.ts"] };
    const launch = (policy: ProviderExecutionPolicy, version: string | undefined) =>
      piArguments(
        "/bridge.ts",
        "/s",
        "s-1",
        "code",
        policy,
        ["octant_browser"],
        undefined,
        own,
        version,
      );
    const toolsOf = (args: ReadonlyArray<string>) => args[args.indexOf("--tools") + 1];
    // Additions to Pi's defaults leave no allowlist, so an extension's tool
    // is registered and offered as in Pi itself.
    expect(toolsOf(launch("approval-gated", "1.1.0"))).toBe("+grep,+find,+ls,+octant_browser");
    expect(toolsOf(launch("full-access", "1.5.2"))).toBe("+grep,+find,+ls,+octant_browser");
    // An older or unknown release keeps the allowlist, which leaves them out.
    expect(toolsOf(launch("approval-gated", "1.0.3"))).toBe(
      "bash,edit,write,read,grep,find,ls,octant_browser",
    );
    expect(toolsOf(launch("approval-gated", undefined))).toBe(
      "bash,edit,write,read,grep,find,ls,octant_browser",
    );
    // Plan loads no extension and keeps its read-only allowlist.
    const plan = launch("plan", "1.1.0");
    expect(plan).not.toContain("/own/extensions/deploy.ts");
    expect(toolsOf(plan)).toBe("read,grep,find,ls,octant_browser");
    // The bridge asks for every tool but the known reads and Octant's own.
    const bridge = piExtensionSource([
      { name: "octant_browser", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(bridge).toContain(
      "if (knownReads.has(event.toolName) || octantTools.has(event.toolName)) return undefined;",
    );
    expect(bridge).toContain('const knownReads = new Set(["read","grep","find","ls"]);');
    expect(piExtensionSource([])).toContain(
      "if (knownReads.has(event.toolName)) return undefined;",
    );
  });

  it("maps modes to the minimum Pi tools and keeps full access genuine", async () => {
    expect(piArguments("/bridge.ts", "/sessions", "chat-1", "chat", "approval-gated")).toContain(
      "--no-tools",
    );
    expect(piArguments("/bridge.ts", "/sessions", "plan-1", "code", "plan")).toEqual(
      expect.arrayContaining(["--tools", "read,grep,find,ls"]),
    );
    expect(piArguments("/bridge.ts", "/sessions", "full-1", "code", "full-access")).toEqual(
      expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls"]),
    );
    // Work and Code share one capability set at the thread's level.
    for (const policy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      expect(piArguments("/bridge.ts", "/sessions", "work-1", "work", policy)).toEqual(
        piArguments("/bridge.ts", "/sessions", "work-1", "code", policy),
      );
    }
    expect(piArguments("/bridge.ts", "/sessions", "work-1", "work", "approval-gated")).toEqual(
      expect.arrayContaining(["--tools", "bash,edit,write,read,grep,find,ls"]),
    );

    const f = fixture();
    const launch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: f.sandbox,
        temporaryDirectory: f.base,
      }).prepare({
        binaryPath: f.binary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "full-1",
        mode: "code",
        executionPolicy: "full-access",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
      }),
    );
    expect(launch.command).toBe(f.binary);
    expect(launch.args[0]).toBe("--mode");
    expect(launch.environment.OCTANT_PI_APPROVALS).toBe("disabled");
    expect(existsSync(join(f.home, "octant-approval-bridge.ts"))).toBe(true);

    const plan = fixture();
    const planLaunch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: plan.sandbox,
        temporaryDirectory: plan.base,
      }).prepare({
        binaryPath: plan.binary,
        root: plan.root,
        piHome: plan.home,
        sessionDirectory: join(plan.home, "sessions"),
        sessionId: "plan-1",
        mode: "code",
        executionPolicy: "plan",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, plan.home),
      }),
    );
    expect(planLaunch.args[1]).not.toContain("(allow process-fork)");
    expect(planLaunch.args[1]).not.toContain("(allow process-exec)");
    expect(planLaunch.args[1]).not.toContain(`(allow file-write* (subpath "${plan.root}"))`);

    const chat = fixture();
    const chatLaunch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: chat.sandbox,
        temporaryDirectory: chat.base,
      }).prepare({
        binaryPath: chat.binary,
        root: chat.root,
        piHome: chat.home,
        sessionDirectory: join(chat.home, "sessions"),
        sessionId: "chat-1",
        mode: "chat",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, chat.home),
      }),
    );
    expect(chatLaunch.args[1]).not.toContain("(allow process-fork)");
    expect(chatLaunch.args[1]).not.toContain("(allow process-exec)");
    expect(chatLaunch.args[1]).not.toContain(`(allow file-write* (subpath "${chat.root}"))`);

    // Work shares Code's shell at the thread's level, so a Work launch gets
    // the jail a Code launch at the same level gets, exec and fork included.
    for (const executionPolicy of ["approval-gated", "auto-accept-edits", "full-access"] as const) {
      const work = fixture();
      const launchFor = (mode: "work" | "code") =>
        Effect.runPromise(
          makePiConfinementLive({
            platform: "darwin",
            sandboxPath: work.sandbox,
            temporaryDirectory: work.base,
          }).prepare({
            binaryPath: work.binary,
            root: work.root,
            piHome: work.home,
            sessionDirectory: join(work.home, "sessions"),
            sessionId: "work-1",
            mode,
            executionPolicy,
            environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, work.home),
          }),
        );
      const workLaunch = await launchFor("work");
      expect(workLaunch.args).toEqual((await launchFor("code")).args);
      if (executionPolicy !== "full-access") {
        expect(workLaunch.args[1]).toContain("(allow process-fork)");
        expect(workLaunch.args[1]).toContain("(allow process-exec)");
      }
    }
  });

  it("fails closed for non-macOS bounded modes and pre-existing provider-owned targets", async () => {
    const f = fixture();
    const occupied = join(f.home, "auth.json");
    mkdirSync(f.home, { recursive: true });
    symlinkSync(f.binary, occupied);
    await expect(
      Effect.runPromise(
        makePiConfinementLive({
          platform: "darwin",
          sandboxPath: f.sandbox,
          credentialPath: f.auth,
          modelsPath: f.models,
          temporaryDirectory: f.base,
        }).prepare({
          binaryPath: f.binary,
          root: f.root,
          piHome: f.home,
          sessionDirectory: join(f.home, "sessions"),
          sessionId: "x",
          mode: "code",
          executionPolicy: "plan",
          environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
        }),
      ),
    ).rejects.toThrow(/invalid-configuration/);

    const occupiedModels = fixture();
    mkdirSync(occupiedModels.home, { recursive: true });
    writeFileSync(join(occupiedModels.home, "models.json"), "occupied", { mode: 0o600 });
    await expect(
      Effect.runPromise(
        makePiConfinementLive({
          platform: "darwin",
          sandboxPath: occupiedModels.sandbox,
          modelsPath: occupiedModels.models,
          temporaryDirectory: occupiedModels.base,
        }).prepare({
          binaryPath: occupiedModels.binary,
          root: occupiedModels.root,
          piHome: occupiedModels.home,
          sessionDirectory: join(occupiedModels.home, "sessions"),
          sessionId: "x",
          mode: "code",
          executionPolicy: "plan",
          environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, occupiedModels.home),
        }),
      ),
    ).rejects.toThrow(/invalid-configuration/);

    const other = fixture();
    const linux = await Effect.runPromise(
      makePiConfinementLive({
        platform: "linux",
        sandboxPath: other.bwrap,
        temporaryDirectory: other.base,
      }).prepare({
        binaryPath: other.binary,
        root: other.root,
        piHome: other.home,
        sessionDirectory: join(other.home, "sessions"),
        sessionId: "x",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, other.home),
      }),
    );
    expect(linux.command).toBe(other.bwrap);
    expect(linux.args).toContain("--unshare-all");
    expect(linux.args).toContain("--");
    expect(linux.args).toContain(other.binary);

    // On a proxied Linux launch the tool bridge rides the forwarder's loopback relay.
    const sockets = mkdtempSync(join(other.base, "sockets-"));
    const relayed = await Effect.runPromise(
      makePiConfinementLive({
        platform: "linux",
        sandboxPath: other.bwrap,
        temporaryDirectory: other.base,
      }).prepare({
        binaryPath: other.binary,
        root: other.root,
        piHome: other.home,
        sessionDirectory: join(other.home, "sessions"),
        sessionId: "relayed",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, other.home),
        tools: [{ name: "octant_browser", inputSchema: { type: "object", properties: {} } }],
        toolBridge: { url: "http://127.0.0.1:43213/octant/test", token: "test-token" },
        network: {
          endpoint: { kind: "unix-socket", path: join(sockets, "proxy.sock") },
          environment: { HTTPS_PROXY: "http://octant:token@127.0.0.1:3128" },
        },
      }),
    );
    expect(relayed.args).not.toContain("--share-net");
    const loopback = relayed.args.indexOf("--loopback");
    expect(relayed.args.slice(loopback, loopback + 2)).toEqual(["--loopback", "43213"]);
  });

  it("keeps the configured launcher directory readable when the binary is a symlink", async () => {
    // `~/.local/bin/pi` -> `.../_versions/1.2.3/bin/pi` is a normal install
    // shape. The profile allows the resolved directory; the link's own
    // directory needs read-metadata too, or the kernel cannot resolve the
    // configured path to the allowed realpath.
    const f = fixture();
    const shimDirectory = join(f.base, "shims");
    mkdirSync(shimDirectory);
    const linkedBinary = join(shimDirectory, "pi");
    symlinkSync(f.binary, linkedBinary);
    const launch = await Effect.runPromise(
      makePiConfinementLive({
        platform: "darwin",
        sandboxPath: f.sandbox,
        temporaryDirectory: f.base,
      }).prepare({
        binaryPath: linkedBinary,
        root: f.root,
        piHome: f.home,
        sessionDirectory: join(f.home, "sessions"),
        sessionId: "linked-1",
        mode: "code",
        executionPolicy: "approval-gated",
        environment: sanitizePiEnvironment({ PATH: "/usr/bin" }, f.home),
      }),
    );
    const profile = launch.args[1]!;
    expect(profile).not.toContain(seatbeltAllowRule("file-read*", shimDirectory));
    expect(profile).not.toContain(seatbeltDenyRule("file-read*", linkedBinary));
  });
});
