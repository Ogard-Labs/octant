import { describe, expect, it } from "vitest";
import { decodeProviderDriverCatalogEntry } from "./providerDriverCatalog";

const driverComponent = {
  id: "provider-driver",
  kind: "provider-driver",
  displayName: "Gemini CLI",
  declaredCapabilities: [],
  entryPoint: "builtin:provider-driver/gemini",
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    extensionId: "10000000-0000-4000-8000-000000000211",
    packageId: "20000000-0000-4000-8000-000000000211",
    slug: "gemini",
    displayName: "Gemini CLI",
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: { kind: "bundled", sourceRef: "app:provider-driver-gemini" },
    provenance: { publisher: "Octant", reviewed: true },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    declaredCapabilities: [],
    primaryComponentId: "provider-driver",
    components: [driverComponent],
    ...overrides,
  };
}

describe("provider catalog entry", () => {
  it("accepts a bundled driver whose one component is the built-in driver for its kind", () => {
    const entry = decodeProviderDriverCatalogEntry({ driverKind: "gemini", manifest: manifest() });
    expect(entry.driverKind).toBe("gemini");
  });

  it("refuses an entry that claims trust, enablement, or installation for itself", () => {
    for (const claim of [{ trusted: true }, { enabled: true }, { installed: true }]) {
      expect(() =>
        decodeProviderDriverCatalogEntry({ driverKind: "gemini", manifest: manifest(), ...claim }),
      ).toThrow();
    }
  });

  it("refuses an entry that declares capabilities, because a listing cannot grant authority", () => {
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({ declaredCapabilities: ["shell"] }),
      }),
    ).toThrow(/declares no capabilities/);
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({
          declaredCapabilities: ["credentials"],
          components: [{ ...driverComponent, declaredCapabilities: ["credentials"] }],
        }),
      }),
    ).toThrow(/declares no capabilities/);
  });

  it("refuses a driver from outside Octant until outside drivers have their own design", () => {
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({ source: { kind: "plugin-package", sourceRef: "npm:gemini-driver" } }),
      }),
    ).toThrow(/bundled with Octant/);
  });

  it("refuses an entry whose driver runs some other entry point or kind", () => {
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "codex",
        manifest: manifest(),
      }),
    ).toThrow(/built-in driver for its kind/);
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({ components: [{ ...driverComponent, entryPoint: "npx:gemini" }] }),
      }),
    ).toThrow();
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({ components: [{ ...driverComponent, kind: "mcp-server" }] }),
      }),
    ).toThrow(/must be a provider driver/);
  });

  it("refuses an entry that carries a second component beside its driver", () => {
    expect(() =>
      decodeProviderDriverCatalogEntry({
        driverKind: "gemini",
        manifest: manifest({
          components: [
            driverComponent,
            {
              id: "helper",
              kind: "hook",
              displayName: "Helper",
              declaredCapabilities: [],
              entryPoint: "builtin:hook/helper",
            },
          ],
        }),
      }),
    ).toThrow(/exactly one provider-driver component/);
  });
});
