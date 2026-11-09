import { describe, expect, it } from "vitest";
import { readCanvasExportPackageDocument } from "./canvasExportPackage";

function entry(origins: ReadonlyArray<string> = ["https://example.test"]) {
  return {
    manifest: {
      manifestVersion: 1,
      slug: "page-export",
      displayName: "Page export",
      version: "1.0.0",
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: {
        platforms: ["macos", "linux", "windows"],
        modes: ["chat", "work", "code"],
        providerFamilies: [],
      },
      declaredCapabilities: ["network"],
      components: [
        {
          id: "page-export",
          kind: "canvas-export-target",
          displayName: "Page export",
          declaredCapabilities: ["network"],
          entryPoint: "dist/export.mjs",
          canvasExport: {
            contribution: {
              schemaVersion: 1,
              kind: "canvas-export-contribution",
              targetId: "page-export",
              label: "Page export",
              formats: ["markdown"],
            },
            allowedOrigins: origins,
          },
        },
      ],
    },
  };
}

describe("Canvas export package documents", () => {
  it("accepts a portable author-owned module and explicit HTTPS destinations", () => {
    expect(readCanvasExportPackageDocument(entry()).status).toBe("accepted");
  });
  it.each([
    "http://example.test",
    "https://example.test/path",
    "https://person:secret@example.test",
    "https://example.test/",
    "file:///tmp/export",
  ])("refuses a destination that is not an exact HTTPS origin: %s", (origin) => {
    expect(readCanvasExportPackageDocument(entry([origin])).status).toBe("refused");
  });
  it("refuses a package that assigns its own host identity or requests file authority", () => {
    const value = entry();
    expect(
      readCanvasExportPackageDocument({
        manifest: { ...value.manifest, extensionId: "30000000-0000-4000-8000-000000000001" },
      }),
    ).toMatchObject({ status: "refused", reason: "host-assigned-field" });
    expect(
      readCanvasExportPackageDocument({
        manifest: { ...value.manifest, declaredCapabilities: ["filesystem"] },
      }),
    ).toMatchObject({ status: "refused", reason: "declares-capabilities" });
  });
});
