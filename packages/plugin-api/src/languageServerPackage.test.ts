import { describe, expect, it } from "vitest";
import { readLanguageServerPackageDocument } from "./languageServerPackage";

function manifest(
  overrides: Record<string, unknown> = {},
  component: Record<string, unknown> = {},
) {
  return {
    manifestVersion: 1,
    slug: "lua-language",
    displayName: "Lua",
    version: "1.0.0",
    provenance: { publisher: "Example Lua", canonicalUrl: "https://example.com/lua" },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos", "linux"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["filesystem"],
    components: [
      {
        id: "language-server",
        kind: "language-server",
        displayName: "Lua",
        declaredCapabilities: ["filesystem"],
        entryPoint: "bin/lua-language-server",
        languageServer: { languages: ["lua"], launchClass: "static" },
        ...component,
      },
    ],
    ...overrides,
  };
}

function refusal(value: unknown) {
  const reading = readLanguageServerPackageDocument(value);
  return reading.status === "refused" ? reading.reason : undefined;
}

describe("language server package schema", () => {
  it("accepts the document an author writes: one static language server whose binary is inside the package", () => {
    const reading = readLanguageServerPackageDocument({ manifest: manifest() });
    expect(reading.status).toBe("accepted");
  });

  it("refuses a document that states the identity, source, digest, or review Octant sets", () => {
    for (const overrides of [
      { extensionId: "10000000-0000-4000-8000-000000000001" },
      { packageId: "20000000-0000-4000-8000-000000000001" },
      { digest: `sha256:${"a".repeat(64)}` },
      { source: { kind: "bundled", sourceRef: "app:lua" } },
      { provenance: { publisher: "Example", reviewed: true } },
      { provenance: { reviewedAt: "2026-10-26T12:00:00.000Z" } },
    ]) {
      expect(refusal({ manifest: manifest(overrides) })).toBe("host-assigned-field");
    }
  });

  it("refuses a server that would need more than the static class grants", () => {
    expect(
      refusal({
        manifest: manifest(
          {},
          { languageServer: { languages: ["lua"], launchClass: "repo-tooling" } },
        ),
      }),
    ).toBe("launch-class-unsupported");
    expect(
      refusal({
        manifest: manifest(
          { declaredCapabilities: ["filesystem", "network"] },
          { declaredCapabilities: ["network"] },
        ),
      }),
    ).toBe("declares-capabilities");
    expect(
      refusal({
        manifest: manifest({
          compatibility: { platforms: ["linux"], modes: ["code", "work"], providerFamilies: [] },
        }),
      }),
    ).toBe("not-for-code");
    expect(
      refusal({
        manifest: manifest({
          compatibility: { platforms: ["linux"], modes: ["code"], providerFamilies: ["codex"] },
        }),
      }),
    ).toBe("provider-specific");
  });

  it("refuses a package that claims the bundled server or reaches outside itself", () => {
    expect(refusal({ manifest: manifest({ slug: "typescript-language-server" }) })).toBe(
      "bundled-claim",
    );
    expect(
      refusal({ manifest: manifest({}, { entryPoint: "builtin:language-server/typescript" }) }),
    ).toBe("bundled-claim");
    for (const entryPoint of ["bin/../../clangd", "bin//server", "bin/./server"]) {
      expect(refusal({ manifest: manifest({}, { entryPoint }) })).toBe(
        "entry-point-not-package-relative",
      );
    }
    // The manifest's own entry-point grammar already has no room for a host path.
    expect(refusal({ manifest: manifest({}, { entryPoint: "/usr/bin/clangd" }) })).toBe(
      "entry-invalid",
    );
  });

  it("refuses anything but exactly one language server, and fields it does not name", () => {
    const base = manifest();
    const server = base.components[0];
    expect(
      refusal({
        manifest: {
          ...base,
          components: [server, { ...server, id: "second", displayName: "Second" }],
        },
      }),
    ).toBe("not-one-language-server");
    expect(
      refusal({
        manifest: manifest(
          { declaredCapabilities: ["filesystem", "shell"] },
          { kind: "hook", declaredCapabilities: ["shell"], languageServer: undefined },
        ),
      }),
    ).toBe("not-one-language-server");
    expect(refusal({ manifest: base, arguments: ["--stdio"] })).toBe("entry-invalid");
    expect(refusal({ manifest: manifest({ trusted: true }) })).toBe("entry-invalid");
  });
});
