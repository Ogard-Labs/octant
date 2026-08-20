import { describe, expect, it } from "vitest";
import { decodeExtensionPackageManifest } from "./manifest";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "board",
    displayName: "Thread board",
    version: "1.0.0",
    digest,
    source: { kind: "bundled", sourceRef: "app:board" },
    provenance: { reviewed: true },
    license: { kind: "unreported" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: [],
    components: [
      {
        id: "board",
        kind: "board",
        displayName: "Thread board",
        declaredCapabilities: [],
        entryPoint: "builtin:board",
      },
    ],
    ...overrides,
  };
}

describe("plugin-api manifest re-exports", () => {
  it("accepts the board component kind through the public package", () => {
    const decoded = decodeExtensionPackageManifest(manifest());
    expect(decoded.components[0]?.kind).toBe("board");
  });

  it("accepts the integration component kind and requires an entry point", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        slug: "github",
        declaredCapabilities: ["network", "credentials"],
        components: [
          {
            id: "integration",
            kind: "integration",
            displayName: "GitHub",
            declaredCapabilities: ["network", "credentials"],
            entryPoint: "builtin:github",
          },
        ],
      }),
    );
    expect(decoded.components[0]?.kind).toBe("integration");

    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          slug: "github",
          components: [
            {
              id: "integration",
              kind: "integration",
              displayName: "GitHub",
              declaredCapabilities: [],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts a sidebar.destination contribution referencing a real component", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        contributions: [
          {
            point: "sidebar.destination",
            componentId: "board",
            destinationId: "thread-board",
            label: "Thread board",
            modes: ["code"],
          },
        ],
      }),
    );
    expect(decoded.contributions).toHaveLength(1);
  });

  it("rejects a contribution referencing a component that doesn't exist", () => {
    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          contributions: [
            {
              point: "sidebar.destination",
              componentId: "missing",
              destinationId: "thread-board",
              label: "Thread board",
              modes: ["code"],
            },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts appearance-pack and preview-viewer kinds without an entry point", () => {
    const decoded = decodeExtensionPackageManifest(
      manifest({
        slug: "appearance",
        components: [
          {
            id: "appearance-pack",
            kind: "appearance-pack",
            displayName: "Octant appearance",
            declaredCapabilities: [],
          },
          {
            id: "preview-viewers",
            kind: "preview-viewer",
            displayName: "Structured preview",
            declaredCapabilities: [],
          },
        ],
        contributions: [
          {
            point: "appearance.preset",
            componentId: "appearance-pack",
            presetId: "octant",
            label: "Octant",
          },
          {
            point: "preview.viewer",
            componentId: "preview-viewers",
            viewerId: "structured-documents",
            label: "Structured documents",
            kinds: ["pdf", "table", "workbook", "document", "slides"],
          },
        ],
      }),
    );
    expect(decoded.components.map((component) => component.kind)).toEqual([
      "appearance-pack",
      "preview-viewer",
    ]);
    expect(decoded.contributions?.map((contribution) => contribution.point)).toEqual([
      "appearance.preset",
      "preview.viewer",
    ]);
  });

  it("rejects an unknown contribution point through the public package", () => {
    expect(() =>
      decodeExtensionPackageManifest(
        manifest({
          contributions: [
            {
              point: "marketplace.slot",
              componentId: "board",
            },
          ],
        }),
      ),
    ).toThrow();
  });
});
