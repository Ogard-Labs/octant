import { describe, expect, it } from "vitest";
import {
  OutsideProviderDriverEntry,
  decodeOutsideProviderDriverEntry,
  decodeOutsideProviderDriverSignatureDocument,
  outsideProviderDriverSignedMessage,
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

  it("refuses an entry point outside the package or one that is not a plain ES module", () => {
    // Node reads a `.js` file as an ES module or CommonJS by the nearest
    // package.json, and Bun and Node run TypeScript differently; only `.mjs`
    // is plain JavaScript run as an ES module on both.
    for (const entryPoint of [
      "dist/../../escape.mjs",
      "file:driver.mjs",
      "dist/driver",
      "a.cjs",
      "dist/driver.js",
      "dist/driver.ts",
      "dist/driver.mts",
    ]) {
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

describe("outside provider driver signature format", () => {
  it("signs one exact message: sorted protocols and files by UTF-8 bytes, each line ended by LF", () => {
    const message = outsideProviderDriverSignedMessage({
      name: "loopback-chat",
      version: "0.1.0",
      protocolVersions: ["harness-endpoint/2", "harness-endpoint/1", "harness-endpoint/1"],
      files: [
        { path: "z.mjs", sha256: "c".repeat(64) },
        // U+FF5E sorts after U+1F600 by UTF-16 code units, before it by code point.
        { path: "lib/\u{1F600}.json", sha256: "b".repeat(64) },
        { path: "lib/\uFF5E.json", sha256: "a".repeat(64) },
        { path: "driver.mjs", sha256: "d".repeat(64) },
      ],
    });

    expect(new TextDecoder().decode(message)).toBe(
      [
        "octant-signature/1",
        "name loopback-chat",
        "version 0.1.0",
        "protocol harness-endpoint/1",
        "protocol harness-endpoint/2",
        `file ${"d".repeat(64)} driver.mjs`,
        `file ${"a".repeat(64)} lib/\uFF5E.json`,
        `file ${"b".repeat(64)} lib/\u{1F600}.json`,
        `file ${"c".repeat(64)} z.mjs`,
        "",
      ].join("\n"),
    );
  });

  it("refuses a signature file with a path that could break a line of the signed message", () => {
    const document = {
      format: "octant-signature/1",
      name: "loopback-chat",
      version: "0.1.0",
      protocolVersions: ["harness-endpoint/1"],
      files: [{ path: "driver.mjs", sha256: "a".repeat(64) }],
      publicKey: `${"A".repeat(43)}=`,
      signature: `${"A".repeat(86)}==`,
    };
    expect(decodeOutsideProviderDriverSignatureDocument(document)._tag).toBe("Right");
    for (const path of ["a\nfile x", "../driver.mjs", "/driver.mjs", "lib//x.mjs", "a\\b"]) {
      expect(
        decodeOutsideProviderDriverSignatureDocument({
          ...document,
          files: [{ path, sha256: "a".repeat(64) }],
        })._tag,
      ).toBe("Left");
    }
    expect(
      decodeOutsideProviderDriverSignatureDocument({ ...document, privateKey: "x" })._tag,
    ).toBe("Left");
  });
});
