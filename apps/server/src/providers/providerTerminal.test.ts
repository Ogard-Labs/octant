import { describe, expect, it } from "vitest";
import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts";
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
    expect(launch.environment.DISABLE_TELEMETRY).toBeUndefined();
    expect(launch.environment.ANTHROPIC_API_KEY).toBeUndefined();
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
