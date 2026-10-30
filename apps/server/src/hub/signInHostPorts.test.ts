import { describe, expect, it, vi } from "vitest";
import type {
  ProviderAccountAuthentication,
  ProviderInstance,
  ProviderReadiness,
} from "@octant/contracts";
import { createSignInHostPorts } from "./signInHostPorts";

function instance(
  driverKind: "claude" | "codex",
  authentication?: "subscription" | "api-key",
  directory?: string,
) {
  return {
    id: `${driverKind}-${authentication ?? "cli"}`,
    driverKind,
    enabled: true,
    configuration:
      driverKind === "claude"
        ? {
            kind: "claude-agent-sdk",
            binaryPath: "/bin/claude",
            authentication,
            ...(directory === undefined ? {} : { configDirectory: directory }),
          }
        : {
            kind: "codex-cli",
            binaryPath: "/bin/codex",
            ...(directory === undefined ? {} : { codexHome: directory }),
          },
  } as unknown as ProviderInstance;
}

function ports(
  instances: ReadonlyArray<ProviderInstance>,
  readiness: ProviderReadiness,
  accountAuthentication?: ProviderAccountAuthentication,
) {
  const probe = vi.fn(
    async () =>
      ({
        readiness,
        ...(accountAuthentication === undefined ? {} : { accountAuthentication }),
      }) as never,
  );
  return {
    probe,
    host: createSignInHostPorts({
      providers: { bootstrap: async () => ({ instances }) as never, probe },
    }),
  };
}

describe("what this host says about a provider's own sign-in", () => {
  it("reports signed-in when the subscription row's probe is ready", async () => {
    const { host } = ports([instance("claude", "subscription")], "ready", "subscription");
    expect(await host.accountState("claude-subscription")).toBe("signed-in");
  });

  it("reports signed-out when the probe says unauthenticated", async () => {
    const { host } = ports([instance("codex")], "unauthenticated");
    expect(await host.accountState("codex-subscription")).toBe("signed-out");
  });

  it("never counts a Claude API-key row, and reports unavailable with no row", async () => {
    const { host, probe } = ports([instance("claude", "api-key")], "ready", "api-key");
    expect(await host.accountState("claude-subscription")).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports unavailable when the provider cannot be reached", async () => {
    const { host } = ports([instance("codex")], "unavailable");
    expect(await host.accountState("codex-subscription")).toBe("unavailable");
  });

  it("does not count a ready Codex that runs on an API key or no login as a subscription", async () => {
    for (const kind of ["api-key", "none"] as const) {
      const { host } = ports([instance("codex")], "ready", kind);
      expect(await host.accountState("codex-subscription")).toBe("signed-out");
    }
  });

  it("does not count a ready probe that cannot name its account", async () => {
    const { host } = ports([instance("codex")], "ready");
    expect(await host.accountState("codex-subscription")).toBe("unavailable");
  });
});

describe("the sign-in command this host shows", () => {
  it("names the Codex binary and its isolated account directory", async () => {
    const { host } = ports([instance("codex", undefined, "/Users/a/.codex-accounts/x")], "ready");
    expect(await host.signInCommand("codex-subscription")).toBe(
      "CODEX_HOME='/Users/a/.codex-accounts/x' '/bin/codex' login",
    );
  });

  it("names the Claude binary and its isolated account directory", async () => {
    const { host } = ports(
      [instance("claude", "subscription", "/Users/a/.claude-accounts/x")],
      "ready",
    );
    expect(await host.signInCommand("claude-subscription")).toBe(
      "CLAUDE_CONFIG_DIR='/Users/a/.claude-accounts/x' CLAUDE_SECURESTORAGE_CONFIG_DIR='/Users/a/.claude-accounts/x' '/bin/claude' auth login",
    );
  });

  it("is the host-profile command when the account has no directory, and none with no row", async () => {
    const { host } = ports([instance("codex")], "ready");
    expect(await host.signInCommand("codex-subscription")).toBe("'/bin/codex' login");
    expect(await host.signInCommand("claude-subscription")).toBeUndefined();
  });
});
