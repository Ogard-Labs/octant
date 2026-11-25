import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
import { acpRunsOnOwnHome, sanitizeAcpEnvironment } from "./acpProcess";
import { acpProviderProfiles } from "./acpProfiles";
import { resolveProviderTerminal } from "./providerTerminal";

const HOST = {
  HOME: "/Users/person",
  PATH: "/usr/bin:/bin",
  ANTHROPIC_API_KEY: "host-canary-key",
  OPENAI_API_KEY: "host-canary-key",
};

function instance(
  kind: "claude" | "codex" | "ollama",
  overrides: { readonly enabled?: boolean; readonly binaryPath?: string } = {},
): ProviderInstance {
  const shared = {
    enabled: overrides.enabled ?? true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-11-21T09:00:00.000Z",
    updatedAt: "2026-11-21T09:00:00.000Z",
  } as const;
  if (kind === "claude")
    return decodeProviderInstance({
      id: "80000000-0000-4000-8000-0000000000b1",
      displayName: "Claude work",
      driverKind: "claude",
      configuration: {
        kind: "claude-agent-sdk",
        binaryPath: overrides.binaryPath ?? "/opt/tools/claude's bin/claude",
        authentication: "subscription",
        configDirectory: "/Users/person/.octant/claude-work",
      },
      ...shared,
    });
  if (kind === "codex")
    return decodeProviderInstance({
      id: "80000000-0000-4000-8000-0000000000b2",
      displayName: "Codex work",
      driverKind: "codex",
      configuration: {
        kind: "codex-cli",
        binaryPath: overrides.binaryPath ?? "/opt/tools/codex",
        codexHome: "/Users/person/.octant/codex-work",
      },
      ...shared,
    });
  return decodeProviderInstance({
    id: "80000000-0000-4000-8000-0000000000b3",
    displayName: "Local models",
    driverKind: "ollama",
    configuration: { kind: "ollama-native-http", baseUrl: "http://127.0.0.1:11434" },
    ...shared,
  });
}

const resolve = (
  candidate: ProviderInstance | undefined,
  platform: NodeJS.Platform = "darwin",
  shell = "/bin/zsh",
  strict = true,
) =>
  resolveProviderTerminal({
    instance: candidate,
    hostEnvironment: HOST,
    homeDirectory: "/Users/person",
    platform,
    shell,
    strict,
  });

describe("provider terminal", () => {
  it("starts Claude Code from the thread's account binary against that account's folder", () => {
    const launch = resolve(instance("claude"));
    expect(launch).toMatchObject({
      status: "resolved",
      name: "Claude Code",
      command: `exec '/opt/tools/claude'\\''s bin/claude'`,
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment.CLAUDE_CONFIG_DIR).toBe("/Users/person/.octant/claude-work");
    // The host's own key never decides which account the program signs in as.
    expect(launch.environment.ANTHROPIC_API_KEY).toBeUndefined();
    // Under Strict the launch's telemetry guard holds in the terminal too.
    expect(launch.environment.DISABLE_TELEMETRY).toBe("1");
  });

  it("gives Claude Code the open launch environment of a thread outside Strict", () => {
    const launch = resolve(instance("claude"), "darwin", "/bin/zsh", false);
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment.CLAUDE_CONFIG_DIR).toBe("/Users/person/.octant/claude-work");
    // With no settings to read, both of the provider's channels stay closed.
    expect(launch.environment.DISABLE_TELEMETRY).toBe("1");
    expect(launch.environment.DISABLE_AUTOUPDATER).toBe("1");
    expect(launch.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("opens a provider terminal outside Strict with the person's own tool credentials, and under Strict without them", () => {
    for (const kind of ["claude", "codex"] as const) {
      const open = (strict: boolean) => {
        const launch = resolveProviderTerminal({
          instance: instance(kind),
          hostEnvironment: { ...HOST, GH_TOKEN: "gh-canary", NPM_TOKEN: "npm-canary" },
          homeDirectory: "/Users/person",
          platform: "darwin",
          shell: "/bin/zsh",
          strict,
        });
        if (launch.status !== "resolved") throw new Error("expected a launch");
        return launch.environment;
      };
      expect(open(false), kind).toMatchObject({ GH_TOKEN: "gh-canary", NPM_TOKEN: "npm-canary" });
      expect(open(true).GH_TOKEN, kind).toBeUndefined();
      expect(open(true).NPM_TOKEN, kind).toBeUndefined();
    }
  });

  it("adds the names the person let through to a provider terminal under Strict, as the thread's turns do, and reads no list outside Strict", () => {
    for (const kind of ["claude", "codex"] as const) {
      const open = (strict: boolean, credentialPassThrough: ReadonlyArray<string>) => {
        const launch = resolveProviderTerminal({
          instance: instance(kind),
          hostEnvironment: { ...HOST, GH_TOKEN: "gh-canary", NPM_TOKEN: "npm-canary" },
          homeDirectory: "/Users/person",
          platform: "darwin",
          shell: "/bin/zsh",
          strict,
          ownChannels: () => ({ telemetry: false, selfUpdate: false, credentialPassThrough }),
        });
        if (launch.status !== "resolved") throw new Error("expected a launch");
        return launch.environment;
      };
      expect(open(true, ["GH_TOKEN"]).GH_TOKEN, kind).toBe("gh-canary");
      expect(open(true, ["GH_TOKEN"]).NPM_TOKEN, kind).toBeUndefined();
      expect(open(false, ["GH_TOKEN"]), kind).toEqual(open(false, []));
    }
  });

  const bothOn = () => ({ telemetry: true, selfUpdate: true });

  function openClaude(
    posture: Partial<Parameters<typeof resolveProviderTerminal>[0]> = {},
  ): Readonly<Record<string, string>> {
    const launch = resolveProviderTerminal({
      instance: instance("claude"),
      hostEnvironment: HOST,
      homeDirectory: "/Users/person",
      platform: "darwin",
      shell: "/bin/zsh",
      strict: false,
      mode: "code",
      executionPolicy: "approval-gated",
      ownChannels: bothOn,
      ...posture,
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    return launch.environment;
  }

  it("lets Claude Code send its own telemetry and update itself outside Strict when the person turned both on", () => {
    const environment = openClaude();
    expect(environment.DISABLE_TELEMETRY).toBeUndefined();
    expect(environment.DISABLE_ERROR_REPORTING).toBeUndefined();
    expect(environment.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it("follows each of the two provider switches on its own in Claude Code's terminal", () => {
    const telemetryOnly = openClaude({
      ownChannels: () => ({ telemetry: true, selfUpdate: false }),
    });
    expect(telemetryOnly.DISABLE_TELEMETRY).toBeUndefined();
    expect(telemetryOnly.DISABLE_AUTOUPDATER).toBe("1");
    const selfUpdateOnly = openClaude({
      ownChannels: () => ({ telemetry: false, selfUpdate: true }),
    });
    expect(selfUpdateOnly.DISABLE_TELEMETRY).toBe("1");
    expect(selfUpdateOnly.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it("keeps Claude Code's channels closed under Strict, a kept sandbox or a chosen sandbox policy, whatever the switches say", () => {
    for (const posture of [
      { strict: true },
      { executionPolicy: "full-access", fullAccessSandbox: true },
      { fullAccessSandbox: true },
      { sandboxPolicySelected: true },
    ] as const) {
      const environment = openClaude(posture);
      expect(environment.DISABLE_TELEMETRY, JSON.stringify(posture)).toBe("1");
      expect(environment.DISABLE_AUTOUPDATER, JSON.stringify(posture)).toBe("1");
    }
  });

  it("starts Codex with the account's own CODEX_HOME and without the host's key", () => {
    const launch = resolve(instance("codex"));
    expect(launch).toMatchObject({
      status: "resolved",
      name: "Codex",
      command: "exec '/opt/tools/codex'",
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment.CODEX_HOME).toBe("/Users/person/.octant/codex-work");
    expect(launch.environment.OPENAI_API_KEY).toBeUndefined();
  });

  it("writes the program in the Windows shell's own words", () => {
    const launch = resolve(
      instance("codex", { binaryPath: "C:\\Tools\\o'k\\codex.exe" }),
      "win32",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(launch).toMatchObject({ status: "resolved", command: "& 'C:\\Tools\\o''k\\codex.exe'" });
  });

  it("refuses a provider with no command-line program, a disabled one, and a missing one", () => {
    expect(resolve(instance("ollama"))).toMatchObject({ status: "refused" });
    expect(resolve(instance("claude", { enabled: false }))).toMatchObject({ status: "refused" });
    expect(resolve(undefined)).toMatchObject({ status: "refused" });
  });
});

describe("ACP agent terminal", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  function acpInstance(kind: "antigravity" | "gemini" | "kilo"): ProviderInstance {
    return decodeProviderInstance({
      id: "80000000-0000-4000-8000-0000000000c1",
      displayName: kind,
      driverKind: kind,
      configuration: {
        kind: `${kind}-acp`,
        binaryPath: `/opt/tools/${kind}`,
        ...(kind === "gemini" ? { authentication: "provider-owned" } : {}),
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-11-21T09:00:00.000Z",
      updatedAt: "2026-11-21T09:00:00.000Z",
    });
  }

  function resolveAcp(
    candidate: ProviderInstance,
    options: Partial<Parameters<typeof resolveProviderTerminal>[0]> = {},
  ) {
    const managedRoot = mkdtempSync(join(tmpdir(), "octant-acp-terminal-"));
    directories.push(managedRoot);
    const launch = resolveProviderTerminal({
      instance: candidate,
      hostEnvironment: HOST,
      homeDirectory: "/Users/person",
      platform: "darwin",
      shell: "/bin/zsh",
      strict: true,
      mode: "work",
      executionPolicy: "approval-gated",
      ...options,
      acpHome: (kind, instanceId) => join(managedRoot, kind, instanceId),
    });
    return {
      launch,
      managedHome: join(managedRoot, String(candidate.driverKind), String(candidate.id)),
    };
  }

  it("opens Google Antigravity's own CLI with the environment its ACP driver builds for a launch", () => {
    const { launch, managedHome } = resolveAcp(acpInstance("antigravity"));
    expect(launch).toMatchObject({
      status: "resolved",
      name: "Google Antigravity",
      // No `acp` arguments: `agy` alone is its interactive CLI.
      command: "exec '/opt/tools/antigravity'",
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment).toMatchObject(
      sanitizeAcpEnvironment(acpProviderProfiles.antigravity, HOST, {
        managedHome,
        executionPolicy: "approval-gated",
        mode: "work",
        interactive: true,
      }),
    );
    expect(launch.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    // Under Strict the host's other providers' keys stay out, as for a turn.
    expect(launch.environment.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("gives Gemini CLI its managed home and the open environment of a thread outside Strict", () => {
    const { launch, managedHome } = resolveAcp(acpInstance("gemini"), { strict: false });
    expect(launch).toMatchObject({ status: "resolved", command: "exec '/opt/tools/gemini'" });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment).toMatchObject(
      sanitizeAcpEnvironment(acpProviderProfiles.gemini, HOST, {
        managedHome,
        executionPolicy: "approval-gated",
        mode: "work",
        interactive: true,
        strict: false,
      }),
    );
    expect(launch.environment.HOME).toBe(managedHome);
    expect(existsSync(managedHome)).toBe(true);
  });

  it("keeps the guarded environment for a thread that kept its sandbox outside Strict", () => {
    const { launch, managedHome } = resolveAcp(acpInstance("gemini"), {
      strict: false,
      executionPolicy: "full-access",
      fullAccessSandbox: true,
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment).toMatchObject(
      sanitizeAcpEnvironment(acpProviderProfiles.gemini, HOST, {
        managedHome,
        executionPolicy: "full-access",
        mode: "work",
        interactive: true,
      }),
    );
  });

  it("runs an ACP agent's CLI on the home a turn of the thread runs on", () => {
    const setup = {
      subagents: true,
      webTools: true,
      skills: true,
      toolServers: true,
      hooks: true,
      projectCode: true,
    } as const;
    const postures = [
      { strict: false, nativeSetup: setup },
      { strict: false, nativeSetup: setup, executionPolicy: "full-access" },
      // Kept only at Full access: below it a turn starts with no sandbox.
      { strict: false, nativeSetup: setup, fullAccessSandbox: true },
      { strict: false, nativeSetup: setup, executionPolicy: "plan" },
      {
        strict: false,
        nativeSetup: setup,
        executionPolicy: "full-access",
        fullAccessSandbox: true,
      },
      { strict: false, nativeSetup: setup, sandboxPolicySelected: true },
      { strict: false },
      { strict: true, nativeSetup: setup },
    ] as const;
    // The two agents whose own CLI a terminal opens.
    for (const kind of ["gemini", "antigravity"] as const) {
      const profile = acpProviderProfiles[kind];
      for (const posture of postures) {
        const { launch, managedHome } = resolveAcp(acpInstance(kind), posture);
        if (launch.status !== "resolved") throw new Error("expected a launch");
        const executionPolicy =
          "executionPolicy" in posture ? posture.executionPolicy : "approval-gated";
        const keptSandbox =
          executionPolicy === "full-access" &&
          "fullAccessSandbox" in posture &&
          posture.fullAccessSandbox;
        const chosenSandbox = "sandboxPolicySelected" in posture;
        // What the process port decides for a turn of this thread.
        const turnOnOwnHome = acpRunsOnOwnHome({
          profile,
          mode: "work",
          executionPolicy,
          strict: posture.strict,
          ...(keptSandbox ? { fullAccessSandbox: true } : {}),
          sandboxPolicySelected: chosenSandbox,
          ...("nativeSetup" in posture ? { nativeSetup: posture.nativeSetup } : {}),
        });
        const turn = sanitizeAcpEnvironment(profile, HOST, {
          managedHome,
          executionPolicy,
          mode: "work",
          ...(posture.strict || keptSandbox || chosenSandbox ? {} : { strict: false }),
          ...(turnOnOwnHome ? { ownHome: true } : {}),
        });
        const label = `${kind} ${JSON.stringify(posture)}`;
        expect(launch.environment.HOME, label).toBe(turn.HOME);
        expect(launch.environment.XDG_DATA_HOME, label).toBe(turn.XDG_DATA_HOME);
        expect(launch.environment.XDG_STATE_HOME, label).toBe(turn.XDG_STATE_HOME);
      }
    }
    const home = (posture: (typeof postures)[number]) => {
      const { launch, managedHome } = resolveAcp(acpInstance("gemini"), posture);
      if (launch.status !== "resolved") throw new Error("expected a launch");
      return { home: launch.environment.HOME, managedHome };
    };
    // Gemini CLI keeps its sessions under `GEMINI_CLI_HOME`, so where a turn
    // runs on the person's home its CLI does too.
    expect(home(postures[0]).home).toBe(HOST.HOME);
    expect(home(postures[2]).home).toBe(HOST.HOME);
    const planning = home(postures[3]);
    expect(planning.home).toBe(planning.managedHome);
    const strict = home(postures[7]);
    expect(strict.home).toBe(strict.managedHome);
  });

  it("adds a let-through name to an ACP agent's terminal under Strict, and not for a thread outside Strict that kept its sandbox", () => {
    const open = (posture: {
      readonly strict: boolean;
      readonly executionPolicy?: "full-access";
      readonly fullAccessSandbox?: boolean;
    }) => {
      const { launch } = resolveAcp(acpInstance("gemini"), {
        ...posture,
        hostEnvironment: { ...HOST, GH_TOKEN: "gh-canary" },
        ownChannels: () => ({
          telemetry: false,
          selfUpdate: false,
          credentialPassThrough: ["GH_TOKEN"],
        }),
      });
      if (launch.status !== "resolved") throw new Error("expected a launch");
      return launch.environment;
    };
    expect(open({ strict: true }).GH_TOKEN).toBe("gh-canary");
    expect(
      open({ strict: false, executionPolicy: "full-access", fullAccessSandbox: true }).GH_TOKEN,
    ).toBeUndefined();
  });

  it("opens an ACP agent's CLI in colour while keeping its self-update guard, and leaves its turns without colour", () => {
    const { launch, managedHome } = resolveAcp(acpInstance("antigravity"));
    if (launch.status !== "resolved") throw new Error("expected a launch");
    // NO_COLOR keeps the ACP JSON-RPC stream free of escape codes; a person's
    // terminal is a TTY, where it only takes the CLI's colour away.
    expect(launch.environment.NO_COLOR).toBeUndefined();
    expect(launch.environment.AGY_CLI_DISABLE_AUTO_UPDATE).toBe("1");
    expect(
      sanitizeAcpEnvironment(acpProviderProfiles.antigravity, HOST, {
        managedHome,
        executionPolicy: "approval-gated",
        mode: "work",
      }).NO_COLOR,
    ).toBe("1");
  });

  it("lets an ACP agent's CLI update itself outside Strict only when the person turned that on", () => {
    const guard = (options: Parameters<typeof resolveAcp>[1]) => {
      const { launch } = resolveAcp(acpInstance("antigravity"), options);
      if (launch.status !== "resolved") throw new Error("expected a launch");
      return launch.environment.AGY_CLI_DISABLE_AUTO_UPDATE;
    };
    const on = () => ({ telemetry: true, selfUpdate: true });
    expect(guard({ strict: false, ownChannels: on })).toBeUndefined();
    expect(guard({ strict: false })).toBe("1");
    expect(
      guard({ strict: false, ownChannels: () => ({ telemetry: true, selfUpdate: false }) }),
    ).toBe("1");
    expect(guard({ strict: true, ownChannels: on })).toBe("1");
    expect(
      guard({
        strict: false,
        ownChannels: on,
        executionPolicy: "full-access",
        fullAccessSandbox: true,
      }),
    ).toBe("1");
    expect(guard({ strict: false, ownChannels: on, sandboxPolicySelected: true })).toBe("1");
  });

  it("keeps a person's own NO_COLOR in an ACP agent's terminal", () => {
    const managedRoot = mkdtempSync(join(tmpdir(), "octant-acp-terminal-"));
    directories.push(managedRoot);
    const launch = resolveProviderTerminal({
      instance: acpInstance("gemini"),
      hostEnvironment: { ...HOST, NO_COLOR: "yes" },
      homeDirectory: "/Users/person",
      platform: "darwin",
      shell: "/bin/zsh",
      strict: true,
      mode: "work",
      executionPolicy: "approval-gated",
      acpHome: (kind, instanceId) => join(managedRoot, kind, instanceId),
    });
    if (launch.status !== "resolved") throw new Error("expected a launch");
    expect(launch.environment.NO_COLOR).toBe("yes");
  });

  it("offers no terminal for an ACP agent whose CLI has no interactive mode Octant knows", () => {
    expect(resolveAcp(acpInstance("kilo")).launch).toMatchObject({ status: "refused" });
  });
});
