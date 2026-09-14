import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExtensionCommand,
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { pluginTarball, catalogEntryIdOf, registryFetch } from "./agentPluginCatalogTestFixtures";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { NpmAgentPluginMarketplace } from "./npmAgentPluginMarketplace";
import { ExtensionPackageStore } from "./extensionPackageStore";

const directories: Array<string> = [];
const now = "2026-09-14T08:00:00.000Z";

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

async function execute(api: ExtensionApiService, command: ExtensionCommand) {
  return api.execute(command);
}

function scopeFor() {
  return {
    hostId: "local",
    mode: "code",
    projectId: null,
    threadId: null,
    providerFamily: "openai-compatible",
  } as const;
}

function onlyPackage(snapshot: ExtensionSnapshot) {
  const entry = snapshot.packages[0];
  if (entry === undefined) throw new Error("Expected an installed extension package.");
  return entry;
}

function effectiveSnapshot(snapshot: ExtensionSnapshot): ExtensionEffectiveSnapshot {
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus: () => "available",
  });
  return activation.resolve(snapshot, { scope: scopeFor() as never });
}

function componentState(snapshot: ExtensionEffectiveSnapshot, componentId: string) {
  const component = snapshot.packages[0]?.components.find(
    (candidate) => candidate.component.id === componentId,
  );
  if (component === undefined) throw new Error("Expected an effective component.");
  return component;
}

async function setup(options: { readonly tarball?: Uint8Array } = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-npm-agent-plugins-"));
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
  const registry = registryFetch([
    {
      name: "demo-plugin",
      version: "1.2.3",
      keywords: ["agent-plugin", "agent-plugins"],
      tarball: options.tarball ?? pluginTarball(),
    },
  ]);
  const api = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({
      catalog: [],
      agentPluginCatalog: new NpmAgentPluginMarketplace({
        fetch: registry.fetch,
        platform: "darwin",
      }),
    }),
    activation: new ExtensionActivationService({
      policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
      catalogStatus: () => "available",
    }),
  });
  return { api, registry };
}

describe("npm Agent Plugins through the extension catalog pipeline", () => {
  it("searches, inspects, and installs only the exact inspected bytes", async () => {
    const { api } = await setup();

    const search = await execute(api, { kind: "search-catalog", query: "demo" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const entry = search.entries[0]!;
    expect(entry.displayName).toBe("demo-plugin");
    expect(entry.version).toBe("1.2.3");
    expect(entry.source).toMatchObject({ catalogId: "npm-agent-plugins" });

    const inspected = await execute(api, {
      kind: "inspect-package",
      source: entry.source,
      expectedDigest: entry.digest,
    });
    if (inspected.kind !== "package-inspected") throw new Error("Expected an inspection.");
    expect(inspected.preview.entry.digest).toBe(entry.digest);
    expect(inspected.preview.entry.source).toEqual({
      kind: "plugin-package",
      sourceRef: `catalog:npm-agent-plugins:${catalogEntryIdOf(entry.source)}`,
    });
    expect(inspected.preview.review.components.map((component) => component.kind).sort()).toEqual([
      "mcp-server",
      "skill-instructions",
    ]);

    // An install whose digest is not the inspected digest is refused, not
    // silently re-fetched: the catalog entry remains the only install path.
    const tampered = await execute(api, {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: `sha256:${"0".repeat(64)}` as never,
    });
    expect(tampered).toMatchObject({
      kind: "extension-command-failed",
      failure: { category: "stale" },
    });

    const installed = await execute(api, {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    if (installed.kind !== "extension-state-updated") throw new Error("Expected an install.");
    const pkg = onlyPackage(installed.snapshot);
    expect(pkg.activation.installed).toBe(true);
    expect(pkg.activation.trusted).toBe(false);
    expect(pkg.activation.pluginDesired).toBe(false);
    expect(pkg.activation.componentDesired).toBe(false);

    const effective = effectiveSnapshot(installed.snapshot);
    for (const component of effective.packages[0]!.components) {
      expect(component.effectiveState).toEqual({ kind: "blocked", reason: "untrusted" });
      expect(component.contextContribution).toMatchObject({ kind: "zero" });
    }
  });

  it("keeps the MCP server quarantined until its own component switch is enabled", async () => {
    const { api } = await setup();
    const search = await execute(api, { kind: "search-catalog", query: "demo" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const entry = search.entries[0]!;
    await execute(api, {
      kind: "inspect-package",
      source: entry.source,
      expectedDigest: entry.digest,
    });
    const installed = await execute(api, {
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    if (installed.kind !== "extension-state-updated") throw new Error("Expected an install.");

    const trusted = await execute(api, {
      kind: "set-source-trust",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      trusted: true,
      expectedStateVersion: onlyPackage(installed.snapshot).stateVersion,
    });
    if (trusted.kind !== "extension-state-updated") throw new Error("Expected trust.");
    const enabled = await execute(api, {
      kind: "set-plugin-desired",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      desired: true,
      expectedStateVersion: onlyPackage(trusted.snapshot).stateVersion,
    });
    if (enabled.kind !== "extension-state-updated") throw new Error("Expected enablement.");

    // Trust and the plugin switch alone leave both components blocked.
    const beforeComponents = effectiveSnapshot(enabled.snapshot);
    expect(componentState(beforeComponents, "skill-demo").effectiveState).toEqual({
      kind: "blocked",
      reason: "component-disabled",
    });
    expect(componentState(beforeComponents, "mcp-demo").effectiveState).toEqual({
      kind: "blocked",
      reason: "component-disabled",
    });

    const skillEnabled = await execute(api, {
      kind: "set-component-desired",
      commandVersion: 1 as never,
      extensionId: entry.extensionId,
      componentId: "skill-demo" as never,
      desired: true,
      expectedStateVersion: onlyPackage(enabled.snapshot).stateVersion,
    });
    if (skillEnabled.kind !== "extension-state-updated") {
      throw new Error("Expected component enablement.");
    }
    const after = effectiveSnapshot(skillEnabled.snapshot);
    expect(componentState(after, "skill-demo").effectiveState).toEqual({ kind: "effective" });
    // The executable MCP server stays quarantined behind its own switch.
    expect(componentState(after, "mcp-demo").effectiveState).toEqual({
      kind: "blocked",
      reason: "component-disabled",
    });
  });

  it("fails closed when npm serves different bytes for a listed name@version", async () => {
    const { api: firstApi } = await setup();
    const search = await execute(firstApi, { kind: "search-catalog", query: "demo" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const entry = search.entries[0]!;

    // A second host with a fresh cache sees republished bytes for the same
    // name@version; the catalog digest no longer binds them.
    const republished = pluginTarball({ overrides: { description: "Republished bytes." } });
    const { api: secondApi } = await setup({ tarball: republished });
    const inspected = await execute(secondApi, {
      kind: "inspect-package",
      source: entry.source,
      expectedDigest: entry.digest,
    });

    expect(inspected).toMatchObject({
      kind: "extension-command-failed",
      failure: { category: "unavailable" },
    });
  });
});
