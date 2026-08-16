import { describe, expect, it } from "vitest";
import {
  decodeExtensionActivationState,
  decodeExtensionComponentQualifiedId,
  decodeExtensionPackageManifest,
  decodeExtensionSelection,
} from "./extensions";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

function manifest() {
  return {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "build-tools",
    displayName: "Build Tools",
    version: "1.2.3",
    digest,
    source: { kind: "catalog", catalogId: "octant-curated", entryId: "build-tools" },
    provenance: {
      canonicalUrl: "https://example.com/build-tools",
      publisher: "Example Publisher",
      reviewed: true,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      app: { minimum: "0.1.0", maximumExclusive: "2.0.0" },
      platforms: ["macos"],
      modes: ["code", "work"],
      providerFamilies: ["openai-compatible", "ollama"],
    },
    declaredCapabilities: ["filesystem", "mcp", "network"],
    primaryComponentId: "instructions",
    components: [
      {
        id: "instructions",
        kind: "skill-instructions",
        skillName: "3d-modeling",
        displayName: "Build guidance",
        declaredCapabilities: [],
      },
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Build MCP",
        declaredCapabilities: ["mcp", "filesystem"],
        entryPoint: "entry-server",
      },
      {
        id: "remote-server",
        kind: "mcp-server",
        displayName: "Remote MCP",
        declaredCapabilities: ["mcp", "network"],
        configurationReference: "config-server",
      },
      {
        id: "build-project",
        kind: "mcp-tool",
        displayName: "Build project",
        declaredCapabilities: ["filesystem"],
        parentComponentId: "server",
      },
    ],
  };
}

describe("extension package contracts", () => {
  it("strictly decodes a provider-neutral manifest", () => {
    const decoded = decodeExtensionPackageManifest(manifest());
    expect(decoded.extensionId).toBe(extensionId);
    expect(decoded.components).toHaveLength(4);
    expect(decoded.components[0]?.skillName).toBe("3d-modeling");
  });

  it("allows a supervised stdio MCP server to bind executable and configuration receipts", () => {
    const value = structuredClone(manifest()) as unknown as {
      components: Array<Record<string, unknown>>;
      [key: string]: unknown;
    };
    value.components[1] = {
      ...value.components[1]!,
      configurationReference: "config-server",
    };

    expect(decodeExtensionPackageManifest(value).components[1]).toMatchObject({
      entryPoint: "entry-server",
      configurationReference: "config-server",
    });
  });

  it("qualifies components with the existing ToolExtensionId contract", () => {
    expect(decodeExtensionComponentQualifiedId(`${extensionId}/instructions`)).toBe(
      `${extensionId}/instructions`,
    );
    expect(
      decodeExtensionComponentQualifiedId("00000000-0000-0000-0000-000000000000/instructions"),
    ).toBe("00000000-0000-0000-0000-000000000000/instructions");
    expect(() =>
      decodeExtensionComponentQualifiedId("------------------------------------/instructions"),
    ).toThrow();
  });

  it("rejects SemVer prerelease numeric identifiers with leading zeroes", () => {
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        version: "1.0.0-01",
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "server",
            kind: "mcp-server",
            skillName: "not-a-skill",
            displayName: "Server",
            declaredCapabilities: ["mcp"],
            entryPoint: "entry-server",
          },
        ],
      }),
    ).toThrow();
  });

  it("compares large SemVer numeric identifiers exactly", () => {
    expect(
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: {
            minimum: "9007199254740992.0.0",
            maximumExclusive: "9007199254740993.0.0",
          },
        },
      }).compatibility.app,
    ).toEqual({
      minimum: "9007199254740992.0.0",
      maximumExclusive: "9007199254740993.0.0",
    });
    expect(
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: {
            minimum: "1.0.0-9007199254740992",
            maximumExclusive: "1.0.0-9007199254740993",
          },
        },
      }).compatibility.app,
    ).toEqual({
      minimum: "1.0.0-9007199254740992",
      maximumExclusive: "1.0.0-9007199254740993",
    });
  });

  it("rejects unknown fields, malformed identity/version/digest, and incompatible components", () => {
    expect(() => decodeExtensionPackageManifest({ ...manifest(), credential: "secret" })).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({ ...manifest(), extensionId: "not-a-uuid" }),
    ).toThrow();
    expect(() => decodeExtensionPackageManifest({ ...manifest(), version: "latest" })).toThrow();
    expect(() => decodeExtensionPackageManifest({ ...manifest(), digest: "sha256:abc" })).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        compatibility: {
          ...manifest().compatibility,
          app: { minimum: "2.0.0", maximumExclusive: "1.0.0" },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "instructions",
            kind: "skill-instructions",
            displayName: "Build guidance",
            declaredCapabilities: [],
            entryPoint: "must-not-execute",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "tool",
            kind: "mcp-tool",
            displayName: "Orphan tool",
            declaredCapabilities: ["mcp"],
            parentComponentId: "missing-server",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionPackageManifest({
        ...manifest(),
        components: [
          {
            id: "server",
            kind: "mcp-server",
            displayName: "Capability escalation",
            declaredCapabilities: ["shell"],
            entryPoint: "entry-server",
          },
        ],
      }),
    ).toThrow();
  });
});

describe("extension state and selection contracts", () => {
  it("keeps lifecycle dimensions independent", () => {
    const state = decodeExtensionActivationState({
      installed: true,
      trusted: false,
      pluginDesired: true,
      componentDesired: true,
      compatible: true,
      policyAllowed: true,
      quarantined: true,
      draining: false,
      broken: false,
      unavailable: false,
      interrupted: false,
      waiting: false,
    });
    expect(state).toMatchObject({ installed: true, trusted: false, quarantined: true });
  });

  it("treats structured references as data and rejects authority-shaped excess fields", () => {
    const selection = {
      kind: "plugin",
      extensionId,
      packageId,
      componentId: "instructions",
      packageVersion: "1.2.3",
      packageDigest: digest,
      catalogEpoch: `sha256:${"c".repeat(64)}`,
      origin: { kind: "draft", reference: "draft-opaque-1" },
    };
    expect(decodeExtensionSelection(selection)).toEqual(selection);
    expect(() =>
      decodeExtensionSelection({
        ...selection,
        authority: { kind: "trusted-extension", extensionId },
      }),
    ).toThrow();
    const { packageId: _packageId, ...withoutPackageId } = selection;
    expect(() => decodeExtensionSelection(withoutPackageId)).toThrow();
    expect(() => decodeExtensionSelection({ ...selection, catalogEpoch: "stale" })).toThrow();
  });
});
