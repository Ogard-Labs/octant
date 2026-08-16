import { describe, expect, it } from "vitest";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  agentPluginExtensionId,
  agentPluginPackageId,
  type AgentPluginPackageInput,
} from "./agentPluginIngestion";
import { createMockCatalogSource, createMockLocalFolderInput } from "./curatedCatalogTestFixtures";

const catalogSource = {
  kind: "catalog",
  catalogId: "octant-curated",
  entryId: "build-ios-apps",
} as never;

describe("Codex plugin package resolver", () => {
  it("resolves catalog entries and local-folder sources through the same normalizer", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const localInput = await createMockLocalFolderInput();
    const resolver = new CodexPluginPackageResolver({
      catalog: [record],
      localFolders: new Map([["local-build-ios-apps", localInput]]),
      fetch: mockFetch,
      platform: "darwin",
    });

    const catalog = await resolver.resolve({ kind: "inspect-package", source: catalogSource });
    const local = await resolver.resolve({
      kind: "inspect-package",
      source: { kind: "local-folder", sourceRef: "local-build-ios-apps" } as never,
    });
    const catalogManifest = catalog.manifest as {
      slug: string;
      source: { kind: string };
      provenance: { reviewed: boolean };
    };
    const localManifest = local.manifest as {
      slug: string;
      source: { kind: string };
      provenance: { reviewed: boolean };
    };
    expect(catalogManifest).toMatchObject({
      slug: "build-ios-apps",
      source: { kind: "plugin-package" },
    });
    expect(localManifest).toMatchObject({
      slug: "build-ios-apps",
      source: { kind: "plugin-package" },
    });
    // Catalog source is reviewed; local-folder source is not.
    expect(catalogManifest.provenance.reviewed).toBe(true);
    expect(localManifest.provenance.reviewed).toBe(false);
  });

  it("searches only valid catalog metadata and never returns local paths", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const resolver = new CodexPluginPackageResolver({
      catalog: [record],
      fetch: mockFetch,
      platform: "darwin",
    });
    const result = resolver.searchCatalog({ kind: "search-catalog", query: "build" });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ slug: "build-ios-apps" });
    expect(JSON.stringify(result)).not.toContain("SKILL.md");
    expect(JSON.stringify(result)).not.toContain("local-build-ios-apps");
  });

  it("uses Agent Plugin identities for catalog records declared as Agent Plugins", async () => {
    const { catalogSource: record } = await createMockCatalogSource();
    const agentRecord = { ...record, packageFormat: "agent-plugin" as const };
    const resolver = new CodexPluginPackageResolver({ catalog: [agentRecord] });

    const result = resolver.searchCatalog({ kind: "search-catalog", query: "build" });
    expect(result.entries[0]).toMatchObject({
      extensionId: agentPluginExtensionId(record.source, record.displayMetadata.name),
      packageId: agentPluginPackageId(record.source, record.displayMetadata.name),
    });
  });

  it("rejects a caller-supplied digest that differs from the catalog-bound digest", async () => {
    const { catalogSource: record, mockFetch, expectedDigest } = await createMockCatalogSource();
    // Deliberately wrong catalog digest.
    const wrongDigest = `sha256:${"0".repeat(64)}` as never;
    const wrongRecord = { ...record, expectedDigest: wrongDigest };
    const resolver = new CodexPluginPackageResolver({
      catalog: [wrongRecord],
      fetch: mockFetch,
      platform: "darwin",
    });
    // Caller supplies the actual correct digest to try to bypass the wrong catalog digest.
    await expect(
      resolver.resolve({
        kind: "inspect-package",
        source: catalogSource,
        expectedDigest,
      } as never),
    ).rejects.toThrow();
  });

  it("rejects a curation binding whose sourceCommit differs from the upstream reference commit", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const wrongCommitRecord = {
      ...record,
      curationBinding: {
        ...record.curationBinding,
        sourceCommit: "deadbeef" + "0".repeat(32),
      },
    };
    const resolver = new CodexPluginPackageResolver({
      catalog: [wrongCommitRecord],
      fetch: mockFetch,
      platform: "darwin",
    });
    await expect(
      resolver.resolve({ kind: "inspect-package", source: catalogSource } as never),
    ).rejects.toThrow();
  });

  it("preserves local-folder caller-supplied digest behavior", async () => {
    const { mockFetch, expectedDigest } = await createMockCatalogSource();
    const localInput = await createMockLocalFolderInput();
    const resolver = new CodexPluginPackageResolver({
      localFolders: new Map([["local-build-ios-apps", localInput]]),
      fetch: mockFetch,
      platform: "darwin",
    });
    // Local-folder sources can still accept a caller-supplied digest.
    const result = await resolver.resolve({
      kind: "inspect-package",
      source: { kind: "local-folder", sourceRef: "local-build-ios-apps" } as never,
      expectedDigest,
    } as never);
    expect(result.expectedDigest).toBe(expectedDigest);
  });

  it("detects and normalizes Agent Plugins 1.0.0 local-folder packages", async () => {
    const encoder = new TextEncoder();
    const input: AgentPluginPackageInput = {
      source: {
        kind: "local-folder",
        sourceRef: "agent-plugins-hello",
      } as AgentPluginPackageInput["source"],
      format: "directory",
      archiveBytes: 256,
      entries: [
        {
          path: "plugin.json",
          kind: "file",
          content: encoder.encode(
            JSON.stringify({
              $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
              name: "hello-plugin",
              version: "1.0.0",
            }),
          ),
        },
        {
          path: "skills/greet/SKILL.md",
          kind: "file",
          content: encoder.encode(`---
name: greet
description: Greet the user and offer help.
---
Hello
`),
        },
      ],
      appVersion: "1.0.0",
      platform: "darwin",
    };
    const resolver = new CodexPluginPackageResolver({
      localFolders: new Map([["agent-plugins-hello", input]]),
      platform: "darwin",
    });
    const resolved = await resolver.resolve({
      kind: "inspect-package",
      source: { kind: "local-folder", sourceRef: "agent-plugins-hello" } as never,
    });
    expect(resolved.manifest).toMatchObject({
      slug: "hello-plugin",
      version: "1.0.0",
      source: { kind: "plugin-package", sourceRef: "agent-plugins-hello" },
      components: [
        expect.objectContaining({
          id: "skill-greet",
          kind: "skill-instructions",
          contentReference: "skills/greet/SKILL.md",
        }),
      ],
    });
  });
});
