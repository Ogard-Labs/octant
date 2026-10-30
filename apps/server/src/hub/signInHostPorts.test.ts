import { describe, expect, it, vi } from "vitest";
import type { ProviderInstance, ProviderReadiness } from "@octant/contracts";
import { createSignInHostPorts } from "./signInHostPorts";

function instance(driverKind: "claude" | "codex", authentication?: "subscription" | "api-key") {
  return {
    id: `${driverKind}-${authentication ?? "cli"}`,
    driverKind,
    enabled: true,
    configuration:
      driverKind === "claude"
        ? { kind: "claude-agent-sdk", binaryPath: "/bin/claude", authentication }
        : { kind: "codex-cli", binaryPath: "/bin/codex" },
  } as unknown as ProviderInstance;
}

function ports(instances: ReadonlyArray<ProviderInstance>, readiness: ProviderReadiness) {
  const probe = vi.fn(async () => ({ readiness }) as never);
  return {
    probe,
    host: createSignInHostPorts({
      providers: { bootstrap: async () => ({ instances }) as never, probe },
    }),
  };
}

describe("what this host says about a provider's own sign-in", () => {
  it("reports signed-in when the subscription row's probe is ready", async () => {
    const { host } = ports([instance("claude", "subscription")], "ready");
    expect(await host.accountState("claude-subscription")).toBe("signed-in");
  });

  it("reports signed-out when the probe says unauthenticated", async () => {
    const { host } = ports([instance("codex")], "unauthenticated");
    expect(await host.accountState("codex-subscription")).toBe("signed-out");
  });

  it("never counts a Claude API-key row, and reports unavailable with no row", async () => {
    const { host, probe } = ports([instance("claude", "api-key")], "ready");
    expect(await host.accountState("claude-subscription")).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("reports unavailable when the provider cannot be reached", async () => {
    const { host } = ports([instance("codex")], "unavailable");
    expect(await host.accountState("codex-subscription")).toBe("unavailable");
  });
});
