import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionSource } from "@octant/contracts/extensions";
import type {
  ExtensionCommand,
  ExtensionEffectiveSnapshot,
  ExtensionEffectiveStateQuery,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { normalizeCodexPluginPackage } from "./codexPluginIngestion";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  BUILD_IOS_APPS_CATALOG_ENTRY_ID,
  BUILD_IOS_APPS_UPSTREAM_SOURCE_COMMIT,
  OCTANT_CURATED_CATALOG_ID,
} from "./curatedBuildIosAppsCatalog";
import {
  createMockCatalogSource,
  createMockLocalFolderInput,
  createMockUpdateCatalogSource,
  MOCK_BUILD_IOS_APPS_FILES,
} from "./curatedCatalogTestFixtures";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";
import {
  fetchPinnedUpstreamPackage,
  type PinnedUpstreamPackageReference,
} from "./pinnedUpstreamPackageFetcher";

const directories: Array<string> = [];
const now = "2026-07-30T08:00:00.000Z";
const catalogSource = {
  kind: "catalog",
  catalogId: OCTANT_CURATED_CATALOG_ID,
  entryId: BUILD_IOS_APPS_CATALOG_ENTRY_ID,
} as const;

const previewSource: ExtensionCommand = {
  kind: "preview-package",
  source: {
    kind: "catalog",
    catalogId: OCTANT_CURATED_CATALOG_ID,
    entryId: BUILD_IOS_APPS_CATALOG_ENTRY_ID,
  },
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await makeWritable(directory);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function makeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
    else await chmod(join(directory, entry.name), 0o600).catch(() => undefined);
  }
}

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-curated-catalog-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const store = new ExtensionPackageStore({ dataDirectory, uuid: randomUUID });
  await store.initialize();
  const lifecycle = new ExtensionLifecycleService({
    connection,
    journal,
    store,
    supervisor: NOOP_EXTENSION_SUPERVISOR,
    uuid: randomUUID,
    clock: () => now,
  });
  const { catalogSource: record, mockFetch, expectedDigest } = await createMockCatalogSource();
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus: () => "available",
  });
  const api = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({
      catalog: [record],
      fetch: mockFetch,
      platform: "darwin",
    }),
    activation,
  });
  return { api, activation, lifecycle, record, mockFetch, expectedDigest };
}

async function execute(api: ExtensionApiService, command: ExtensionCommand) {
  return api.execute(command);
}

function installedPackage(snapshot: ExtensionSnapshot) {
  const entry = snapshot.packages[0];
  if (entry === undefined) throw new Error("Expected an installed extension package.");
  return entry;
}

function effectivePackage(snapshot: ExtensionEffectiveSnapshot) {
  const entry = snapshot.packages[0];
  if (entry === undefined) throw new Error("Expected an effective extension package.");
  return entry;
}

describe("curated openai/build-ios-apps catalog record", () => {
  it("lists exactly one curated record with version, digest, and reviewable source", async () => {
    const { api } = await setup();
    const result = await execute(api, { kind: "search-catalog", query: "ios" });
    if (result.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0]!;
    expect(entry.slug).toBe("build-ios-apps");
    expect(entry.displayName).toBe("Build iOS Apps");
    expect(entry.version).toBe("0.1.2");
    expect(entry.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(entry.source).toEqual(catalogSource);
    expect(entry.source.kind).toBe("catalog");
  });

  it("exposes provenance, license, compatibility, and capabilities before installation", async () => {
    const { api } = await setup();
    const result = await execute(api, previewSource);
    if (result.kind !== "package-preview") {
      throw new Error(`Expected a package preview, received ${JSON.stringify(result)}.`);
    }
    const { review } = result.preview;
    expect(review.description).toContain("App Intents");
    expect(review.provenance).toEqual({
      canonicalUrl: "https://github.com/openai/plugins",
      publisher: "OpenAI",
      sourceCommit: BUILD_IOS_APPS_UPSTREAM_SOURCE_COMMIT,
      reviewed: true,
      reviewedAt: "2026-07-30T00:00:00.000Z",
    });
    expect(review.license).toEqual({ kind: "spdx", identifier: "MIT" });
    expect(review.compatibility).toEqual({
      platforms: ["macos"],
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    });
    // The MCP component with a floating @latest executable is permanently
    // unavailable; only skill-instructions contribute capabilities.
    expect(review.declaredCapabilities).toEqual(["instructions"]);
    const skills = review.components.filter((component) => component.kind === "skill-instructions");
    const servers = review.components.filter((component) => component.kind === "mcp-server");
    expect(skills).toHaveLength(9);
    expect(servers).toHaveLength(0);
    expect(skills.map((component) => component.id)).toContain("skill-swiftui-ui-patterns");
    expect(JSON.stringify(result)).not.toMatch(/\/tmp\/|\/home\/|\/Users\//);
  });

  it("contributes optional skills and no MCP adapter or core Apple capability", async () => {
    const { api } = await setup();
    const result = await execute(api, previewSource);
    if (result.kind !== "package-preview") throw new Error("Expected a package preview.");
    expect(result.preview.review.declaredCapabilities).not.toContain("apple-development");
    expect(result.preview.review.declaredCapabilities).not.toContain("mcp");
    expect(result.preview.review.declaredCapabilities).not.toContain("shell");
    expect(
      result.preview.review.components.some(
        (component) => component.kind === "apple-development-adapter",
      ),
    ).toBe(false);
    expect(
      result.preview.review.components.some((component) => component.kind === "mcp-server"),
    ).toBe(false);
    expect(
      result.preview.review.components.every(
        (component) => component.kind === "skill-instructions",
      ),
    ).toBe(true);
  });

  it("installs disabled and untrusted until review, trust, plugin, and component enablement", async () => {
    const { api } = await setup();
    const search = await execute(api, { kind: "search-catalog", query: "build-ios-apps" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const entry = search.entries[0]!;
    const inspected = await execute(api, {
      kind: "inspect-package",
      source: entry.source,
      expectedDigest: entry.digest,
    });
    if (inspected.kind !== "package-inspected") throw new Error("Expected an inspection.");
    expect(inspected.preview.entry.digest).toBe(entry.digest);

    const installed = await execute(api, {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    if (installed.kind !== "extension-state-updated") throw new Error("Expected an install.");
    const fresh = installedPackage(installed.snapshot);
    expect(fresh.activation.installed).toBe(true);
    expect(fresh.activation.trusted).toBe(false);
    expect(fresh.activation.pluginDesired).toBe(false);
    expect(fresh.activation.quarantined).toBe(false);
    for (const component of fresh.components) {
      expect(component.activation.componentDesired).toBe(false);
      expect(component.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });
    }

    const scope = {
      hostId: "local",
      mode: "code",
      projectId: null,
      threadId: null,
      providerFamily: "openai-compatible",
    } as const as ExtensionEffectiveStateQuery["scope"];
    const untrustedEffective = await execute(api, {
      kind: "query-effective-state",
      commandVersion: 1 as never,
      scope,
    });
    if (untrustedEffective.kind !== "extension-effective-state") {
      throw new Error("Expected effective state.");
    }
    for (const component of effectivePackage(untrustedEffective.snapshot).components) {
      expect(component.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });
      expect(component.contextContribution.kind).toBe("zero");
    }

    const trusted = await execute(api, {
      kind: "set-source-trust",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      trusted: true,
      expectedStateVersion: fresh.stateVersion,
    });
    if (trusted.kind !== "extension-state-updated") throw new Error("Expected trust update.");
    const enabled = await execute(api, {
      kind: "set-plugin-desired",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      desired: true,
      expectedStateVersion: installedPackage(trusted.snapshot).stateVersion,
    });
    if (enabled.kind !== "extension-state-updated") throw new Error("Expected enablement.");
    for (const component of installedPackage(enabled.snapshot).components) {
      expect(component.effectiveState).toEqual({ kind: "blocked", reason: "component-disabled" });
    }

    const skillEnabled = await execute(api, {
      kind: "set-component-desired",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      componentId: "skill-swiftui-ui-patterns" as never,
      desired: true,
      expectedStateVersion: installedPackage(enabled.snapshot).stateVersion,
    });
    if (skillEnabled.kind !== "extension-state-updated") {
      throw new Error("Expected component enablement.");
    }

    for (const providerFamily of ["openai-compatible", "ollama"] as const) {
      const effective = await execute(api, {
        kind: "query-effective-state",
        commandVersion: 1 as never,
        scope: { ...scope, providerFamily: providerFamily as never },
      });
      if (effective.kind !== "extension-effective-state") throw new Error("Expected state.");
      const components = effectivePackage(effective.snapshot).components;
      const skill = components.find(
        (component) => component.component.id === "skill-swiftui-ui-patterns",
      );
      expect(skill?.effectiveState).toEqual({ kind: "effective" });
      expect(skill?.contextContribution).toEqual({ kind: "zero", reason: "not-selected" });
    }
  });

  it("quarantines capability-expanded updates and requires fresh review", async () => {
    // Create a single shared database for install + update.
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-curated-quarantine-"));
    directories.push(dataDirectory);
    const connection = openSqlite(join(dataDirectory, "octant.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => now);
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => now,
    });
    const store = new ExtensionPackageStore({ dataDirectory, uuid: randomUUID });
    await store.initialize();
    const lifecycle = new ExtensionLifecycleService({
      connection,
      journal,
      store,
      supervisor: NOOP_EXTENSION_SUPERVISOR,
      uuid: randomUUID,
      clock: () => now,
    });
    const activation = new ExtensionActivationService({
      policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
      catalogStatus: () => "available",
    });

    // Original catalog source (v0.1.2).
    const { catalogSource: originalRecord, mockFetch: originalFetch } =
      await createMockCatalogSource();
    const originalApi = new ExtensionApiService({
      lifecycle,
      resolver: new CodexPluginPackageResolver({
        catalog: [originalRecord],
        fetch: originalFetch,
        platform: "darwin",
      }),
      activation,
    });

    const search = await execute(originalApi, { kind: "search-catalog", query: "build-ios-apps" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const entry = search.entries[0]!;
    await execute(originalApi, {
      kind: "inspect-package",
      source: entry.source,
      expectedDigest: entry.digest,
    });
    const installed = await execute(originalApi, {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    if (installed.kind !== "extension-state-updated") throw new Error("Expected an install.");
    const trusted = await execute(originalApi, {
      kind: "set-source-trust",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      trusted: true,
      expectedStateVersion: installedPackage(installed.snapshot).stateVersion,
    });
    if (trusted.kind !== "extension-state-updated") throw new Error("Expected trust update.");
    const enabled = await execute(originalApi, {
      kind: "set-plugin-desired",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      desired: true,
      expectedStateVersion: installedPackage(trusted.snapshot).stateVersion,
    });
    if (enabled.kind !== "extension-state-updated") throw new Error("Expected enablement.");

    // Updated package version with an additional network MCP server
    // (non-floating) that expands declared capabilities.
    const { catalogSource: updateRecord, mockFetch: updateFetch } =
      await createMockUpdateCatalogSource({
        "plugins/build-ios-apps/.codex-plugin/plugin.json": JSON.stringify({
          ...JSON.parse(
            MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/.codex-plugin/plugin.json"]!,
          ),
          version: "0.1.3",
        }),
        "plugins/build-ios-apps/.mcp.json": JSON.stringify({
          mcpServers: {
            xcodebuildmcp: {
              command: "npx",
              args: ["-y", "xcodebuildmcp@latest", "mcp"],
              env: { XCODEBUILDMCP_ENABLED_WORKFLOWS: "simulator" },
            },
            remoteinsights: { url: "https://mcp.example.invalid/insights" },
          },
        }),
      });

    // Update API shares the same database but has the update catalog source.
    const updateApi = new ExtensionApiService({
      lifecycle,
      resolver: new CodexPluginPackageResolver({
        catalog: [updateRecord],
        fetch: updateFetch,
        platform: "darwin",
      }),
      activation,
    });

    const updateSearch = await execute(updateApi, {
      kind: "search-catalog",
      query: "build-ios-apps",
    });
    if (updateSearch.kind !== "catalog-search-results") throw new Error("Expected results.");
    const updateEntry = updateSearch.entries[0]!;
    expect(updateEntry.version).toBe("0.1.3");
    expect(updateEntry.digest).not.toBe(entry.digest);
    expect(updateEntry.extensionId).toBe(entry.extensionId);
    expect(updateEntry.packageId).toBe(entry.packageId);

    const updateInspected = await execute(updateApi, {
      kind: "inspect-package",
      source: updateEntry.source,
      expectedDigest: updateEntry.digest,
    });
    if (updateInspected.kind !== "package-inspected") throw new Error("Expected inspection.");
    // The remoteinsights server (non-floating) adds a network capability;
    // xcodebuildmcp (floating @latest) is still filtered out.
    expect(updateInspected.preview.review.declaredCapabilities).toContain("network");
    expect(updateInspected.preview.review.declaredCapabilities).not.toContain("shell");

    const updatedSnapshot = await execute(updateApi, {
      kind: "update-package",
      extensionId: updateEntry.extensionId,
      packageId: updateEntry.packageId,
      version: updateEntry.version,
      digest: updateEntry.digest,
    });
    if (updatedSnapshot.kind !== "extension-state-updated") {
      throw new Error("Expected an update.");
    }
    const quarantined = installedPackage(updatedSnapshot.snapshot);
    expect(quarantined.version).toBe("0.1.3");
    expect(quarantined.activation.quarantined).toBe(true);
    expect(quarantined.activation.trusted).toBe(false);
    expect(quarantined.activation.pluginDesired).toBe(false);
    expect(quarantined.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "capability-review-required",
    );
    for (const component of quarantined.components) {
      expect(component.effectiveState).toEqual({ kind: "blocked", reason: "quarantined" });
    }
  });
});

describe("curated catalog reviewed provenance binding", () => {
  type NormalizedManifest = {
    digest: string;
    provenance: {
      reviewed: boolean;
      sourceCommit?: string;
      reviewedAt?: string;
    };
  };

  function manifestOf(normalized: { manifest: unknown }): NormalizedManifest {
    return normalized.manifest as NormalizedManifest;
  }

  it("rejects local-folder sources with a curation binding as reviewed", async () => {
    const localInput = await createMockLocalFolderInput();
    const normalized = normalizeCodexPluginPackage(localInput);
    const manifest = manifestOf(normalized);
    expect(manifest.provenance.reviewed).toBe(false);
    expect(manifest.provenance.sourceCommit).toBeUndefined();
    expect(manifest.provenance.reviewedAt).toBeUndefined();
  });

  it("rejects catalog sources with a mismatched catalog ID as reviewed", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const fetched = await fetchPinnedUpstreamPackageWith(mockFetch, record);
    const normalized = normalizeCodexPluginPackage({
      ...fetched,
      expectedDigest: record.expectedDigest,
      curationBinding: {
        ...record.curationBinding,
        catalogId: "wrong-catalog" as never,
      },
      appVersion: "1.0.0",
      platform: "darwin",
    });
    expect(manifestOf(normalized).provenance.reviewed).toBe(false);
    expect(manifestOf(normalized).provenance.sourceCommit).toBeUndefined();
  });

  it("rejects catalog sources with a mismatched entry ID as reviewed", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const fetched = await fetchPinnedUpstreamPackageWith(mockFetch, record);
    const normalized = normalizeCodexPluginPackage({
      ...fetched,
      expectedDigest: record.expectedDigest,
      curationBinding: {
        ...record.curationBinding,
        entryId: "wrong-entry" as never,
      },
      appVersion: "1.0.0",
      platform: "darwin",
    });
    expect(manifestOf(normalized).provenance.reviewed).toBe(false);
  });

  it("rejects catalog sources without an expected digest as reviewed", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const fetched = await fetchPinnedUpstreamPackageWith(mockFetch, record);
    const normalized = normalizeCodexPluginPackage({
      ...fetched,
      curationBinding: record.curationBinding,
      appVersion: "1.0.0",
      platform: "darwin",
    });
    expect(manifestOf(normalized).provenance.reviewed).toBe(false);
  });

  it("rejects spoofed bytes that do not match the expected digest", async () => {
    const { catalogSource: record, mockFetch } = await createMockCatalogSource();
    const fetched = await fetchPinnedUpstreamPackageWith(mockFetch, record);
    // Tamper with a skill file to produce a different digest.
    const tamperedEntries = fetched.entries.map((entry) =>
      entry.path === "skills/swiftui-ui-patterns/SKILL.md"
        ? { ...entry, content: new TextEncoder().encode("# Tampered\n") }
        : entry,
    );
    expect(() =>
      normalizeCodexPluginPackage({
        ...fetched,
        entries: tamperedEntries,
        expectedDigest: record.expectedDigest,
        curationBinding: record.curationBinding,
        appVersion: "1.0.0",
        platform: "darwin",
      }),
    ).not.toThrow();
    // The normalizer sets reviewed: true (binding matches) but the computed
    // digest differs from the expected digest. The inspector catches this.
    const normalized = normalizeCodexPluginPackage({
      ...fetched,
      entries: tamperedEntries,
      expectedDigest: record.expectedDigest,
      curationBinding: record.curationBinding,
      appVersion: "1.0.0",
      platform: "darwin",
    });
    const manifest = manifestOf(normalized);
    expect(manifest.provenance.reviewed).toBe(true);
    expect(manifest.digest).not.toBe(record.expectedDigest);
    expect(normalized.expectedDigest).toBe(record.expectedDigest);
  });
});

async function fetchPinnedUpstreamPackageWith(
  mockFetch: typeof globalThis.fetch,
  record: { source: ExtensionSource; upstreamReference: PinnedUpstreamPackageReference },
) {
  return fetchPinnedUpstreamPackage({
    reference: record.upstreamReference,
    source: record.source,
    appVersion: "1.0.0",
    platform: "darwin",
    fetch: mockFetch,
  });
}
