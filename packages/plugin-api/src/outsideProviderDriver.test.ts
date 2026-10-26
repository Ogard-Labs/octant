import { describe, expect, it } from "vitest";
import {
  OutsideProviderDriverEntry,
  decodeOutsideProviderDriverEntry,
  readOutsideProviderDriverEntry,
} from "./outsideProviderDriver";

const driverComponent = {
  id: "driver",
  kind: "provider-driver",
  displayName: "Loopback chat",
  declaredCapabilities: [],
  entryPoint: "dist/driver.mjs",
};

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    extensionId: "30000000-0000-4000-8000-000000000001",
    packageId: "30000000-0000-4000-8000-000000000002",
    slug: "loopback-chat",
    displayName: "Loopback chat",
    version: "0.1.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: { kind: "local-folder", sourceRef: "local-loopback-chat" },
    provenance: {
      publisher: "Example Author",
      canonicalUrl: "https://example.test/loopback-chat",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["chat", "work", "code"], providerFamilies: [] },
    declaredCapabilities: [],
    primaryComponentId: "driver",
    components: [driverComponent],
    ...overrides,
  };
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    driverKind: "outside-harness-endpoint",
    protocolVersions: ["harness-endpoint/1"],
    manifest: manifest(),
    ...overrides,
  };
}

function refusal(value: unknown) {
  const reading = readOutsideProviderDriverEntry(value);
  return reading.status === "refused" ? reading.reason : undefined;
}

describe("outside provider driver entry", () => {
  it("accepts one capability-free driver with a package-relative module entry and its protocol versions", () => {
    const reading = readOutsideProviderDriverEntry(entry());
    expect(reading.status).toBe("accepted");
    expect(decodeOutsideProviderDriverEntry(entry()).protocolVersions).toEqual([
      "harness-endpoint/1",
    ]);
  });

  it("is a schema of its own and leaves the bundled catalog entry unchanged", async () => {
    const bundled = await import("./providerDriverCatalog");
    expect(OutsideProviderDriverEntry).not.toBe(bundled.ProviderDriverCatalogEntry);
    expect(() =>
      bundled.decodeProviderDriverCatalogEntry({
        driverKind: "outside-harness-endpoint",
        manifest: manifest(),
      }),
    ).toThrow();
  });

  it("refuses any field the schema does not name, including authority the entry claims for itself", () => {
    for (const claim of [{ trusted: true }, { enabled: true }, { installed: true }]) {
      expect(refusal({ ...entry(), ...claim })).toBe("entry-invalid");
    }
    expect(refusal(entry({ manifest: manifest({ trusted: true }) }))).toBe("entry-invalid");
  });

  it("refuses declared capabilities on the package or its driver", () => {
    expect(
      refusal(
        entry({
          manifest: manifest({
            declaredCapabilities: ["network"],
            components: [{ ...driverComponent, declaredCapabilities: ["network"] }],
          }),
        }),
      ),
    ).toBe("declares-capabilities");
    expect(refusal(entry({ manifest: manifest({ declaredCapabilities: ["credentials"] }) }))).toBe(
      "declares-capabilities",
    );
  });

  it("refuses renderer contributions", () => {
    expect(
      refusal(
        entry({
          manifest: manifest({
            contributions: [
              {
                point: "settings.section",
                componentId: "driver",
                sectionId: "driver",
                label: "Driver",
                scope: "app",
                keywords: "driver",
              },
            ],
          }),
        }),
      ),
    ).toBe("declares-contributions");
  });

  it("refuses anything but exactly one provider-driver component", () => {
    expect(
      refusal(
        entry({
          manifest: manifest({
            primaryComponentId: undefined,
            components: [driverComponent, { ...driverComponent, id: "second" }],
          }),
        }),
      ),
    ).toBe("not-one-provider-driver");
    expect(
      refusal(
        entry({
          manifest: manifest({
            components: [{ ...driverComponent, kind: "integration" }],
          }),
        }),
      ),
    ).toBe("not-one-provider-driver");
  });

  it("refuses a package that says it is bundled with Octant", () => {
    expect(
      refusal(
        entry({
          manifest: manifest({ source: { kind: "bundled", sourceRef: "app:provider-driver-x" } }),
        }),
      ),
    ).toBe("bundled-source");
  });

  it("refuses a claim to a bundled driver's kind, name, or built-in entry", () => {
    expect(refusal(entry({ driverKind: "ollama" }))).toBe("bundled-kind-claim");
    expect(refusal(entry({ manifest: manifest({ slug: "claude" }) }))).toBe("bundled-kind-claim");
    expect(
      refusal(
        entry({
          manifest: manifest({
            components: [{ ...driverComponent, entryPoint: "builtin:provider-driver/ollama" }],
          }),
        }),
      ),
    ).toBe("bundled-kind-claim");
  });

  it("refuses an entry point outside the package or one that is not a module", () => {
    for (const entryPoint of ["dist/../../escape.mjs", "file:driver.mjs", "dist/driver", "a.cjs"]) {
      expect(
        refusal(
          entry({ manifest: manifest({ components: [{ ...driverComponent, entryPoint }] }) }),
        ),
      ).toBe("entry-point-not-package-relative");
    }
  });

  it("refuses an entry without a well-formed harness endpoint protocol version", () => {
    expect(refusal(entry({ protocolVersions: [] }))).toBe("entry-invalid");
    expect(refusal(entry({ protocolVersions: ["acp/1"] }))).toBe("entry-invalid");
    expect(refusal(entry({ protocolVersions: ["harness-endpoint/0"] }))).toBe("entry-invalid");
  });
});
