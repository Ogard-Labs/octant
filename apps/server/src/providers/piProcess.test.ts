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
import type { ProviderToolDefinition } from "@octant/contracts";
import { Effect } from "effect";
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
import { seatbeltAllowRule, seatbeltDenyRule } from "../process/seatbeltProfile";

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
    expect(credentialsFor("openrouter")).toEqual(["OPENROUTER_API_KEY"]);
    expect(sanitizePiEnvironment(host, "/managed", "enabled", "xai")).toMatchObject({
      PATH: "/usr/bin",
      LC_ALL: "en_US.UTF-8",
      HOME: "/managed",
      PI_CODING_AGENT_DIR: "/managed",
      XAI_API_KEY: "xai-key",
    });
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
      inheritedEnvironment: {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "openai-key",
        XAI_API_KEY: "xai-key",
      },
    });
    const start = (modelProvider?: string) =>
      Effect.runPromise(
        Effect.scoped(
          port.start({
            binaryPath: binary,
            root: f.root,
            piHome: f.home,
            sessionDirectory: join(f.home, "sessions"),
            sessionId: "session-1",
            mode: "code",
            executionPolicy: "approval-gated",
            ...(modelProvider === undefined ? {} : { modelProvider }),
          }),
        ),
      );

    await start("anthropic");
    await start();

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

  it("writes isolated configuration, links provider-owned auth, and loads only the Octant bridge", async () => {
    const f = fixture();
    const confinement = makePiConfinementLive({
      platform: "darwin",
      sandboxPath: f.sandbox,
      credentialPath: f.auth,
      modelsPath: f.models,
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
    expect(launch.args).toContain("--no-extensions");
    expect(launch.args).toContain("--no-skills");
    expect(launch.args).toContain("--no-context-files");
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
