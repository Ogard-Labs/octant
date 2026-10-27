import { describe, expect, it } from "vitest";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
} from "@octant/contracts/extensions";
import { componentQualifiedId, normalizeExtensionManifest, sourceQualifiedSkillId } from "./model";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = decodeExtensionContentDigest(`sha256:${"a".repeat(64)}`);

function manifest(): ExtensionPackageManifest {
  return decodeExtensionPackageManifest({
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "portable-tools",
    displayName: "Portable Tools",
    version: "1.0.0",
    digest,
    source: { kind: "agents-skills-directory", sourceRef: "project-skill-root-1" },
    provenance: { publisher: "Local project", reviewed: true },
    license: { kind: "unreported" },
    compatibility: {
      platforms: ["macos"],
      modes: ["code", "chat"],
      providerFamilies: ["ollama", "anthropic", "ollama"],
    },
    declaredCapabilities: ["filesystem", "instructions", "filesystem"],
    primaryComponentId: "zeta",
    components: [
      {
        id: "zeta",
        kind: "skill-instructions",
        displayName: "Zeta",
        declaredCapabilities: ["instructions"],
      },
      { id: "alpha", kind: "skill-instructions", displayName: "Alpha", declaredCapabilities: [] },
    ],
  });
}

describe("extension manifest normalization", () => {
  it("normalizes order and duplicate declarations deterministically", () => {
    const normalized = normalizeExtensionManifest(manifest());
    expect(normalized.declaredCapabilities).toEqual(["filesystem", "instructions"]);
    expect(normalized.compatibility.modes).toEqual(["chat", "code"]);
    expect(normalized.compatibility.providerFamilies).toEqual(["anthropic", "ollama"]);
    expect(normalized.components.map((component) => component.id)).toEqual(["alpha", "zeta"]);
  });

  it("normalizes a language server's declared languages without changing its launch class", () => {
    const base = manifest();
    const normalized = normalizeExtensionManifest(
      decodeExtensionPackageManifest({
        ...base,
        compatibility: { ...base.compatibility, modes: ["code"] },
        declaredCapabilities: [],
        primaryComponentId: "tsserver",
        components: [
          {
            id: "tsserver",
            kind: "language-server",
            displayName: "TypeScript",
            declaredCapabilities: [],
            entryPoint: "entry-tsserver",
            languageServer: {
              languages: ["typescriptreact", "typescript", "javascript", "typescript"],
              launchClass: "static",
            },
          },
        ],
      }),
    );
    expect(normalized.components[0]?.languageServer).toEqual({
      languages: ["javascript", "typescript", "typescriptreact"],
      launchClass: "static",
    });
  });

  it("builds stable serialization-safe source-qualified identities", () => {
    expect(componentQualifiedId(extensionId, "alpha")).toBe(`${extensionId}/alpha`);
    expect(componentQualifiedId("00000000-0000-0000-0000-000000000000", "alpha")).toBe(
      "00000000-0000-0000-0000-000000000000/alpha",
    );
    expect(() => componentQualifiedId("------------------------------------", "alpha")).toThrow();
    expect(sourceQualifiedSkillId(manifest().source, "alpha", digest)).toBe(
      `agents-skills-directory:project-skill-root-1:alpha:${digest}`,
    );
  });
});
