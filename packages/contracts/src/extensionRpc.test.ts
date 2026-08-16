import { describe, expect, it } from "vitest";
import {
  MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH,
  decodeExtensionCommand,
  decodeExtensionCommandResult,
  decodeExtensionSnapshot,
} from "./extensionRpc";

const extensionId = "10000000-0000-4000-8000-000000000001";
const packageId = "20000000-0000-4000-8000-000000000001";
const digest = `sha256:${"a".repeat(64)}`;

describe("extension RPC contracts", () => {
  it.each([
    { kind: "search-catalog", query: "build", cursor: "next-1" },
    { kind: "search-skills", query: "review", cursor: "next-1" },
    {
      kind: "preview-skill",
      source: { kind: "catalog", catalogId: "curated", entryId: "review-skill" },
    },
    {
      kind: "preview-package",
      source: { kind: "catalog", catalogId: "curated", entryId: "build-tools" },
    },
    {
      kind: "inspect-package",
      source: { kind: "catalog", catalogId: "curated", entryId: "build-tools" },
      expectedDigest: digest,
    },
    { kind: "install-package", extensionId, packageId, version: "1.0.0", digest },
    { kind: "update-package", extensionId, packageId, version: "1.1.0", digest },
    { kind: "rollback-package", extensionId, packageId, version: "1.0.0", digest },
    { kind: "uninstall-package", extensionId, packageId },
    { kind: "install-skill", extensionId, packageId, version: "1.0.0", digest },
    { kind: "update-skill", extensionId, packageId, version: "1.1.0", digest },
    { kind: "remove-skill", extensionId, packageId },
    { kind: "reconcile-skills" },
    {
      kind: "set-source-trust",
      commandVersion: 1,
      extensionId,
      trusted: true,
      expectedStateVersion: 3,
    },
    {
      kind: "set-plugin-desired",
      commandVersion: 1,
      extensionId,
      desired: true,
      expectedStateVersion: 3,
    },
    {
      kind: "set-component-desired",
      commandVersion: 1,
      extensionId,
      componentId: "instructions",
      desired: true,
      expectedStateVersion: 3,
    },
    {
      kind: "query-effective-state",
      commandVersion: 1,
      scope: {
        hostId: "local",
        mode: "code",
        projectId: null,
        threadId: null,
        providerFamily: "ollama",
      },
      expectedCatalogEpoch: `sha256:${"b".repeat(64)}`,
    },
  ])("strictly decodes $kind commands", (command) => {
    expect(decodeExtensionCommand(command).kind).toBe(command.kind);
    expect(() => decodeExtensionCommand({ ...command, token: "secret" })).toThrow();
  });

  it("requires versioned optimistic desired-state mutations", () => {
    expect(() =>
      decodeExtensionCommand({ kind: "set-source-trust", extensionId, trusted: true }),
    ).toThrow();
    expect(() =>
      decodeExtensionCommand({
        kind: "set-component-desired",
        commandVersion: 1,
        extensionId,
        componentId: "instructions",
        desired: true,
      }),
    ).toThrow();
  });

  it("decodes replay-aware snapshots and closed results", () => {
    const snapshot = {
      sequence: 4,
      snapshotAt: "2026-07-28T12:00:00.000Z",
      packages: [],
      collisions: [],
    };
    expect(decodeExtensionSnapshot(snapshot)).toEqual(snapshot);
    expect(decodeExtensionCommandResult({ kind: "extension-state-updated", snapshot }).kind).toBe(
      "extension-state-updated",
    );
    expect(() =>
      decodeExtensionCommandResult({
        kind: "extension-command-failed",
        failure: { category: "invalid", message: "Invalid request.", rawPath: "/private" },
      }),
    ).toThrow();
  });

  it("keeps discovered skill state source-qualified and disabled until review", () => {
    const snapshot = decodeExtensionSnapshot({
      sequence: 4,
      snapshotAt: "2026-07-28T12:00:00.000Z",
      packages: [],
      skills: [
        {
          skill: {
            qualifiedId: `agents-skills-directory:project:review:${digest}`,
            name: "review",
            sourceKind: "agents-skills-directory",
            digest,
            available: true,
          },
          source: { kind: "agents-skills-directory", sourceRef: "project:fixture" },
          displayName: "review",
          provenance: { reviewed: false },
          contentBytes: 16,
          reviewed: false,
          desiredEnabled: false,
          effectiveState: { kind: "blocked", reason: "untrusted" },
        },
      ],
      collisions: [],
    });
    expect(snapshot.skills?.[0]?.desiredEnabled).toBe(false);
    expect(snapshot.skills?.[0]?.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });
  });

  it("decodes scoped effective state with drift, offline, collision, and zero-context facts", () => {
    const catalogEpoch = `sha256:${"b".repeat(64)}`;
    const snapshot = {
      sequence: 4,
      snapshotAt: "2026-07-28T12:00:00.000Z",
      scope: {
        hostId: "local",
        mode: "code",
        projectId: null,
        threadId: null,
        providerFamily: "ollama",
      },
      catalogEpoch,
      catalogStatus: "offline",
      stale: true,
      packages: [],
      collisions: [],
    };
    expect(decodeExtensionCommandResult({ kind: "extension-effective-state", snapshot })).toEqual({
      kind: "extension-effective-state",
      snapshot,
    });
  });

  it("carries bounded skill instructions into the pre-trust package preview", () => {
    const entry = {
      skill: {
        qualifiedId: `catalog:skills:review:${digest}`,
        name: "review",
        sourceKind: "catalog",
        digest,
        available: true,
      },
      source: { kind: "catalog", catalogId: "skills", entryId: "review" },
      version: "1.0.0",
      displayName: "Review",
      provenance: { publisher: "Example", reviewed: false },
    };
    const preview = {
      entry,
      extensionId,
      packageId,
      license: { kind: "spdx", identifier: "MIT" },
      instructions: "Review the complete change before trusting this skill.",
      diagnostics: [],
    };
    expect(decodeExtensionCommandResult({ kind: "skill-package-preview", preview })).toMatchObject({
      preview: { instructions: preview.instructions },
    });
    expect(() =>
      decodeExtensionCommandResult({
        kind: "skill-package-preview",
        preview: {
          ...preview,
          instructions: "x".repeat(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH + 1),
        },
      }),
    ).toThrow();
  });

  it("returns typed catalog and inspection data without package bytes or private paths", () => {
    const entry = {
      extensionId,
      packageId,
      slug: "build-tools",
      displayName: "Build Tools",
      version: "1.0.0",
      digest,
      source: { kind: "catalog", catalogId: "curated", entryId: "build-tools" },
    };
    expect(
      decodeExtensionCommandResult({
        kind: "catalog-search-results",
        entries: [entry],
        nextCursor: "next-2",
      }).kind,
    ).toBe("catalog-search-results");
    expect(
      decodeExtensionCommandResult({
        kind: "package-inspected",
        preview: { entry, review: reviewFixture, diagnostics: [] },
      }).kind,
    ).toBe("package-inspected");
    expect(() =>
      decodeExtensionCommandResult({
        kind: "package-inspected",
        preview: { entry, review: reviewFixture, diagnostics: [], packageBytes: "raw" },
      }),
    ).toThrow();
  });

  it("exposes source, license, compatibility, and capability review metadata before install", () => {
    const entry = {
      extensionId,
      packageId,
      slug: "build-ios-apps",
      displayName: "Build iOS Apps",
      version: "0.1.2",
      digest,
      source: { kind: "catalog", catalogId: "octant-curated", entryId: "build-ios-apps" },
    };
    const result = decodeExtensionCommandResult({
      kind: "package-preview",
      preview: { entry, review: reviewFixture, diagnostics: [] },
    });
    if (result.kind !== "package-preview") throw new Error("Expected a package preview.");
    expect(result.preview.review.provenance).toEqual({
      canonicalUrl: "https://github.com/openai/plugins",
      publisher: "OpenAI",
      sourceCommit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
      reviewed: true,
      reviewedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(result.preview.review.license).toEqual({ kind: "spdx", identifier: "MIT" });
    expect(result.preview.review.compatibility).toEqual({
      platforms: ["macos"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    });
    expect(result.preview.review.declaredCapabilities).toEqual([
      "credentials",
      "instructions",
      "mcp",
      "shell",
    ]);
    expect(result.preview.review.components).toHaveLength(2);
    expect(result.preview.review.components[0]?.instructions).toBe(
      "Review the complete bundled skill before trust.",
    );
    expect(result.preview.review.components[1]).toEqual({
      id: "mcp-xcodebuildmcp",
      kind: "mcp-server",
      displayName: "xcodebuildmcp",
      declaredCapabilities: ["mcp", "shell", "credentials"],
    });
    expect(() =>
      decodeExtensionCommandResult({
        kind: "package-preview",
        preview: { entry, diagnostics: [] },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionCommandResult({
        kind: "package-preview",
        preview: {
          entry,
          review: {
            ...reviewFixture,
            components: [
              {
                ...reviewFixture.components[0],
                instructions: "x".repeat(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH + 1),
              },
            ],
          },
          diagnostics: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionCommandResult({
        kind: "package-preview",
        preview: {
          entry,
          review: { ...reviewFixture, provenance: { reviewed: false, token: "secret" } },
          diagnostics: [],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeExtensionCommandResult({
        kind: "package-preview",
        preview: {
          entry,
          review: { ...reviewFixture, license: { kind: "unreported" }, rawContent: "prompt" },
          diagnostics: [],
        },
      }),
    ).toThrow();
  });
});

const reviewFixture = {
  description: "Build, refine, and debug iOS apps with App Intents, SwiftUI, and Xcode workflows.",
  provenance: {
    canonicalUrl: "https://github.com/openai/plugins",
    publisher: "OpenAI",
    sourceCommit: "cd0fccd4ed62dded584c16246685b232d7bfe7f6",
    reviewed: true,
    reviewedAt: "2026-07-30T00:00:00.000Z",
  },
  license: { kind: "spdx", identifier: "MIT" },
  compatibility: {
    platforms: ["macos"],
    modes: ["chat", "work", "code"],
    providerFamilies: [],
  },
  declaredCapabilities: ["credentials", "instructions", "mcp", "shell"],
  components: [
    {
      id: "skill-swiftui-ui-patterns",
      kind: "skill-instructions",
      displayName: "swiftui-ui-patterns",
      declaredCapabilities: ["instructions"],
      instructions: "Review the complete bundled skill before trust.",
    },
    {
      id: "mcp-xcodebuildmcp",
      kind: "mcp-server",
      displayName: "xcodebuildmcp",
      declaredCapabilities: ["mcp", "shell", "credentials"],
    },
  ],
};
