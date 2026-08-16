import { describe, expect, it } from "vitest";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import {
  calculateExtensionPackageDigest,
  inspectExtensionPackage,
  type ExtensionArchiveEntry,
  type ExtensionInspectionLimits,
  type ResolvedExtensionPackage,
} from "./packageInspector";

const extensionId = "41000000-0000-4000-8000-000000000001";
const packageId = "41000000-0000-4000-8000-000000000002";
const executable = new TextEncoder().encode("export default {};");
const readme = new TextEncoder().encode("safe package");

function packageFixture(
  overrides: Partial<Omit<ResolvedExtensionPackage, "manifest">> & {
    readonly manifest?: Partial<ExtensionPackageManifest> & Record<string, unknown>;
  } = {},
): ResolvedExtensionPackage {
  const entries =
    overrides.entries ??
    ([
      { path: "runtime/main.mjs", kind: "file", content: executable, executable: true },
      { path: "README.md", kind: "file", content: readme },
    ] satisfies ReadonlyArray<ExtensionArchiveEntry>);
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "safe-package",
    displayName: "Safe package",
    version: "1.2.3",
    digest: "sha256:" + "0".repeat(64),
    source: { kind: "catalog", catalogId: "octant", entryId: "safe-package" },
    provenance: {
      canonicalUrl: "https://example.com/safe-package",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: {
      app: { minimum: "0.1.0", maximumExclusive: "2.0.0" },
      platforms: ["macos"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    },
    declaredCapabilities: ["mcp"],
    primaryComponentId: "server",
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp"],
        entryPoint: "runtime/main.mjs",
      },
    ],
    ...overrides.manifest,
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return {
    format: overrides.format ?? "zip",
    archiveBytes: overrides.archiveBytes ?? 512,
    manifest,
    entries,
    expectedDigest: overrides.expectedDigest ?? manifest.digest,
    appVersion: overrides.appVersion ?? "1.0.0",
    platform: overrides.platform ?? "darwin",
  } as ResolvedExtensionPackage;
}

function expectRejected(
  input: ResolvedExtensionPackage,
  code: string,
  limits?: ExtensionInspectionLimits,
) {
  expect(() => inspectExtensionPackage(input, limits)).toThrowError(
    expect.objectContaining({ name: "ExtensionInspectionError", code }),
  );
}

describe("host-owned extension package inspector", () => {
  it("accepts a bounded compatible package and replaces raw entry points with opaque references", () => {
    const inspected = inspectExtensionPackage(packageFixture());

    expect(inspected.manifest.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(inspected.manifest.components[0]?.entryPoint).toBe("entry:server");
    expect(inspected.entryPoints).toEqual({ server: "runtime/main.mjs" });
    expect(inspected.files.map((file) => file.path)).toEqual(["README.md", "runtime/main.mjs"]);
  });

  it.each([
    ["absolute-posix", "/private/escape", "unsafe-path"],
    ["parent-traversal", "../escape", "unsafe-path"],
    ["nested-traversal", "safe/../../escape", "unsafe-path"],
    ["backslash-separator", "safe\\escape", "unsafe-path"],
    ["windows-drive", "C:/escape", "unsafe-path"],
    ["windows-unc", "//server/share", "unsafe-path"],
    ["nul", "safe\0escape", "unsafe-path"],
    ["empty-segment", "safe//escape", "unsafe-path"],
  ])("rejects the %s hostile path before visibility", (_case, path, code) => {
    expectRejected(packageFixture({ entries: [{ path, kind: "file", content: readme }] }), code);
  });

  it("rejects duplicate normalized names and Unicode normalization collisions", () => {
    expectRejected(
      packageFixture({
        entries: [
          { path: "docs/caf\u00e9.md", kind: "file", content: readme },
          { path: "docs/cafe\u0301.md", kind: "file", content: readme },
        ],
      }),
      "duplicate-path",
    );
  });

  it.each(["symlink", "hardlink"] as const)("rejects %s archive entries", (kind) => {
    expectRejected(
      packageFixture({
        entries: [{ path: "runtime/main.mjs", kind, linkTarget: "../escape" }],
      }),
      "link-entry",
    );
  });

  it("rejects missing and undeclared executable entry points", () => {
    expectRejected(
      packageFixture({ entries: [{ path: "README.md", kind: "file", content: readme }] }),
      "entry-point-missing",
    );
    expectRejected(
      packageFixture({
        entries: [
          { path: "runtime/main.mjs", kind: "file", content: executable, executable: true },
          { path: "runtime/hidden.mjs", kind: "file", content: executable, executable: true },
        ],
      }),
      "undeclared-executable",
    );
  });

  it("rejects unsupported formats, digest mismatches, and strict-manifest failures", () => {
    expectRejected(packageFixture({ format: "rar" }), "unsupported-format");
    expectRejected(
      packageFixture({ expectedDigest: `sha256:${"f".repeat(64)}` as never }),
      "digest-mismatch",
    );
    expectRejected(packageFixture({ manifest: { unknownField: true } }), "manifest-invalid");
  });

  it("rejects missing provenance/license metadata and incompatible hosts", () => {
    expectRejected(
      packageFixture({ manifest: { license: { kind: "unreported" } } }),
      "license-missing",
    );
    expectRejected(
      packageFixture({
        manifest: { provenance: { publisher: "Example Publisher", reviewed: false } },
      }),
      "provenance-missing",
    );
    expectRejected(packageFixture({ appVersion: "2.0.0" }), "incompatible");
    expectRejected(packageFixture({ platform: "linux" }), "incompatible");
  });

  it("enforces entry, path, file, manifest, and cumulative extracted-byte bounds", () => {
    const input = packageFixture();
    const baseline: ExtensionInspectionLimits = {
      maximumArchiveBytes: 1_024,
      maximumArchiveEntries: 4,
      maximumManifestBytes: 16_384,
      maximumPathBytes: 128,
      maximumFileBytes: 1_024,
      maximumExtractedBytes: 2_048,
    };
    expectRejected(input, "archive-oversize", { ...baseline, maximumArchiveBytes: 128 });
    expectRejected(input, "archive-oversize", { ...baseline, maximumArchiveEntries: 1 });
    expectRejected(input, "manifest-oversize", { ...baseline, maximumManifestBytes: 16 });
    expectRejected(input, "path-oversize", { ...baseline, maximumPathBytes: 4 });
    expectRejected(input, "file-oversize", { ...baseline, maximumFileBytes: 4 });
    expectRejected(input, "archive-oversize", { ...baseline, maximumExtractedBytes: 4 });
  });
});
