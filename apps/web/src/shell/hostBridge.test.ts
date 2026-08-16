import { describe, expect, it, vi } from "vitest";
import { getInjectedHostBridge, type OctantHostBridge } from "./hostBridge";

function bridge(): OctantHostBridge {
  return {
    clearProviderCredential: vi.fn(),
    close: vi.fn(),
    maximizeOrRestore: vi.fn(),
    minimize: vi.fn(),
    openCodeExternalEditor: vi.fn(),
    projectWindowCapability: "C".repeat(43),
    providerCredentialStatus: vi.fn(),
    resetBounds: vi.fn(),
    selectProjectRoot: vi.fn(),
    setProviderCredential: vi.fn(),
    setSidebarMaterialPreference: vi.fn(),
    subscribeResolvedMaterial: vi.fn(() => vi.fn()),
  };
}

describe("getInjectedHostBridge", () => {
  it("returns the context-isolated preload bridge when present", () => {
    const injected = bridge();

    expect(getInjectedHostBridge({ octantHost: injected })).toBe(injected);
  });

  it("keeps remote web rendering independent when no bridge is present", () => {
    expect(getInjectedHostBridge({})).toBeUndefined();
  });

  it("fails closed when an injected bridge omits a credential operation", () => {
    const incomplete = { ...bridge(), clearProviderCredential: undefined };

    expect(() => getInjectedHostBridge({ octantHost: incomplete })).toThrow(TypeError);
  });

  it("types only the scoped native root picker result without exposing generic native ports", async () => {
    const injected = bridge();
    vi.mocked(injected.selectProjectRoot).mockResolvedValue({
      kind: "selected",
      receiptId: "R".repeat(43),
      displayName: "repo",
    });

    await expect(injected.selectProjectRoot("code")).resolves.toEqual({
      kind: "selected",
      receiptId: "R".repeat(43),
      displayName: "repo",
    });
    expect(injected).not.toHaveProperty("invoke");
    expect(injected).not.toHaveProperty("path");
    expect(injected).not.toHaveProperty("desktopBridgeSecret");
  });

  it("types only fixed write-only credential operations", async () => {
    const injected = bridge();
    const providerInstanceId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
    vi.mocked(injected.providerCredentialStatus).mockResolvedValue("missing");

    await injected.setProviderCredential(providerInstanceId, "private-value");
    await expect(injected.providerCredentialStatus(providerInstanceId)).resolves.toBe("missing");
    await injected.clearProviderCredential(providerInstanceId);

    expect(injected).not.toHaveProperty("getProviderCredential");
    expect(injected).not.toHaveProperty("resolveProviderCredential");
    expect(JSON.stringify(injected)).not.toContain("private-value");
  });
});
