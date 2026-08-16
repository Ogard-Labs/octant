import { describe, expect, it, vi, afterEach } from "vitest";
import type { DiscoveryCandidate } from "@octant/contracts";
import { createProviderFromDiscoveryCandidate } from "./discoveryProviderCreate";

function makeCandidate(
  overrides: Partial<Pick<DiscoveryCandidate, "driverKind" | "displayName" | "binaryPath">> = {},
): Pick<DiscoveryCandidate, "driverKind" | "displayName" | "binaryPath"> {
  return {
    driverKind: "codex",
    displayName: "Codex CLI",
    binaryPath: "/opt/homebrew/bin/codex",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createProviderFromDiscoveryCandidate", () => {
  it("creates a disabled codex provider command for auto-register", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000901");

    const result = createProviderFromDiscoveryCandidate(makeCandidate(), { enabled: false });

    expect(result).toEqual({
      instanceId: "00000000-0000-4000-8000-000000000901",
      command: {
        kind: "create-codex-provider",
        instanceId: "00000000-0000-4000-8000-000000000901",
        expectedVersion: 0,
        displayName: "Codex CLI",
        binaryPath: "/opt/homebrew/bin/codex",
        enabled: false,
      },
    });
  });

  it("creates an enabled claude provider command for connect", () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000902");

    const result = createProviderFromDiscoveryCandidate(
      makeCandidate({
        driverKind: "claude",
        displayName: "Claude CLI",
        binaryPath: "/opt/homebrew/bin/claude",
      }),
      { enabled: true },
    );

    expect(result).toEqual({
      instanceId: "00000000-0000-4000-8000-000000000902",
      command: {
        kind: "create-claude-provider",
        instanceId: "00000000-0000-4000-8000-000000000902",
        expectedVersion: 0,
        displayName: "Claude CLI",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "subscription",
        },
        enabled: true,
      },
    });
  });
});
