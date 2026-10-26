import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionCommandResult, ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  resolveDraftExtensionReference,
  resolveStructuredPluginReference,
} from "@octant/plugin-host";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { buildCatalogs } from "./extensionChatResolver";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";

const now = "2026-10-26T12:00:00.000Z";
const directories: Array<string> = [];

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

function driverDocument(manifest: Record<string, unknown> = {}, document = {}) {
  return {
    driverKind: "outside-harness-endpoint",
    protocolVersions: ["harness-endpoint/1"],
    manifest: {
      manifestVersion: 1,
      slug: "loopback-chat",
      displayName: "Loopback chat",
      version: "0.1.0",
      provenance: {
        publisher: "Example Author",
        canonicalUrl: "https://example.test/loopback-chat",
      },
      license: { kind: "spdx", identifier: "MIT" },
      compatibility: {
        platforms: ["macos"],
        modes: ["chat", "work", "code"],
        providerFamilies: [],
      },
      declaredCapabilities: [],
      primaryComponentId: "driver",
      components: [
        {
          id: "driver",
          kind: "provider-driver",
          displayName: "Loopback chat",
          declaredCapabilities: [],
          entryPoint: "dist/driver.mjs",
        },
      ],
      ...manifest,
    },
    ...document,
  };
}

/** A driver folder on disk; `files` adds or replaces files, with a mode when given. */
async function writeDriverFolder(
  options: {
    readonly document?: unknown;
    readonly files?: Readonly<Record<string, { readonly content: string; readonly mode?: number }>>;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-outside-driver-"));
  directories.push(root);
  const files: Record<string, { readonly content: string; readonly mode?: number }> = {
    "octant-provider-driver.json": {
      content: JSON.stringify(options.document ?? driverDocument()),
    },
    "dist/driver.mjs": { content: "export default {};\n" },
    "package.json": { content: JSON.stringify({ name: "loopback-chat", type: "module" }) },
    ...options.files,
  };
  for (const [path, file] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), file.content);
    await chmod(join(root, path), file.mode ?? 0o644);
  }
  return root;
}

async function setup() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-outside-driver-host-"));
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
  const registry = new LocalPluginFolderRegistry({ platform: "darwin" });
  const api = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({ localFolderRegistry: registry, platform: "darwin" }),
  });
  const inspect = async (root: string) => {
    const registered = await registry.register(root);
    return api.execute({ kind: "inspect-package", source: registered.source });
  };
  return { connection, journal, runtime, store, lifecycle, registry, api, inspect };
}

function refusalMessage(result: ExtensionCommandResult): string | undefined {
  return result.kind === "extension-command-failed" ? result.failure.message : undefined;
}

describe("outside provider driver inspection from a local folder", () => {
  it("accepts a driver folder and reviews it as one capability-free provider driver", async () => {
    const context = await setup();
    const result = await context.inspect(await writeDriverFolder());
    expect(result.kind).toBe("package-inspected");
    if (result.kind !== "package-inspected") return;
    expect(result.preview.entry.source.kind).toBe("local-folder");
    expect(result.preview.review.provenance.reviewed).toBe(false);
    expect(result.preview.review.declaredCapabilities).toEqual([]);
    expect(result.preview.review.components).toEqual([
      {
        id: "driver",
        kind: "provider-driver",
        displayName: "Loopback chat",
        declaredCapabilities: [],
      },
    ]);
  });

  it.each([
    [
      "declared capabilities",
      {
        document: driverDocument({
          declaredCapabilities: ["network"],
          components: [
            {
              id: "driver",
              kind: "provider-driver",
              displayName: "Loopback chat",
              declaredCapabilities: ["network"],
              entryPoint: "dist/driver.mjs",
            },
          ],
        }),
      },
      "A provider driver declares no capabilities; Octant makes every call on its behalf.",
    ],
    [
      "renderer contributions",
      {
        document: driverDocument({
          contributions: [
            {
              point: "settings.section",
              componentId: "driver",
              sectionId: "driver",
              label: "Driver",
              scope: "app",
              keywords: "driver",
            },
          ],
        }),
      },
      "A provider driver adds nothing to Octant's windows.",
    ],
    [
      "an executable file",
      { files: { "bin/helper": { content: "echo hi\n", mode: 0o755 } } },
      "This provider driver ships a program; a provider driver is JavaScript modules and data only.",
    ],
    [
      "an executable entry module",
      { files: { "dist/driver.mjs": { content: "export default {};\n", mode: 0o755 } } },
      "This provider driver ships a program; a provider driver is JavaScript modules and data only.",
    ],
    [
      "a native addon",
      { files: { "build/addon.node": { content: "not really native" } } },
      "This provider driver ships native code; a provider driver is JavaScript modules and data only.",
    ],
    [
      "a native binary under an innocent name",
      { files: { "dist/data.bin": { content: "\u007fELF\u0002\u0001\u0001" } } },
      "This provider driver ships native code; a provider driver is JavaScript modules and data only.",
    ],
    [
      "an install script",
      {
        files: {
          "package.json": {
            content: JSON.stringify({ name: "x", scripts: { postinstall: "node setup.js" } }),
          },
        },
      },
      "This provider driver has an install script; Octant runs no install step for a provider driver.",
    ],
    [
      "an install script in a nested dependency",
      {
        files: {
          "node_modules/dep/package.json": {
            content: JSON.stringify({ name: "dep", scripts: { install: "node-gyp rebuild" } }),
          },
        },
      },
      "This provider driver has an install script; Octant runs no install step for a provider driver.",
    ],
    [
      "a claim to a bundled driver's kind",
      { document: driverDocument({}, { driverKind: "ollama" }) },
      "This provider driver claims the name or entry of a driver bundled with Octant.",
    ],
    [
      "a claim to a bundled driver's name",
      { document: driverDocument({ slug: "claude" }) },
      "This provider driver claims the name or entry of a driver bundled with Octant.",
    ],
    [
      "a claim to a bundled driver's built-in entry",
      {
        document: driverDocument({
          components: [
            {
              id: "driver",
              kind: "provider-driver",
              displayName: "Loopback chat",
              declaredCapabilities: [],
              entryPoint: "builtin:provider-driver/ollama",
            },
          ],
        }),
      },
      "This provider driver claims the name or entry of a driver bundled with Octant.",
    ],
    [
      "a claim to be bundled",
      {
        document: driverDocument({
          source: { kind: "bundled", sourceRef: "app:provider-driver-ollama" },
        }),
      },
      "This provider driver states its own identity, source, digest or review; Octant sets those itself.",
    ],
    [
      "a review it gave itself",
      {
        document: driverDocument({
          provenance: { publisher: "Example Author", sourceCommit: "abcdef1", reviewed: true },
        }),
      },
      "This provider driver states its own identity, source, digest or review; Octant sets those itself.",
    ],
    [
      "a protocol this host does not speak",
      { document: driverDocument({}, { protocolVersions: ["harness-endpoint/2"] }) },
      "This provider driver speaks no protocol version this version of Octant speaks.",
    ],
    [
      "a missing entry module",
      {
        document: driverDocument({
          components: [
            {
              id: "driver",
              kind: "provider-driver",
              displayName: "Loopback chat",
              declaredCapabilities: [],
              entryPoint: "dist/missing.mjs",
            },
          ],
        }),
      },
      "This provider driver's entry module is not in its package.",
    ],
  ] as const)(
    "refuses a driver with %s, in Octant's own words",
    async (_label, options, message) => {
      const context = await setup();
      const result = await context.inspect(await writeDriverFolder(options));
      expect(refusalMessage(result)).toBe(message);
      // A refused inspection is not remembered, so nothing can install it.
      expect(context.lifecycle.snapshot().packages).toEqual([]);
    },
  );

  it("never reads a driver from another plugin layout", async () => {
    const context = await setup();
    const root = await writeDriverFolder({
      files: { ".mcp.json": { content: JSON.stringify({ mcpServers: {} }) } },
    });
    const result = await context.inspect(root);
    if (result.kind !== "package-inspected") throw new Error("expected an inspected driver");
    expect(result.preview.review.components.map((component) => component.kind)).toEqual([
      "provider-driver",
    ]);
  });
});

describe("an installed outside provider driver", () => {
  async function installed() {
    const context = await setup();
    const inspected = await context.inspect(await writeDriverFolder());
    if (inspected.kind !== "package-inspected") throw new Error("expected an inspected driver");
    const entry = inspected.preview.entry;
    const result = await context.api.execute({
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    if (result.kind !== "extension-state-updated") throw new Error("expected an install");
    return { ...context, entry };
  }

  function driverState(snapshot: ExtensionSnapshot) {
    const [state] = snapshot.packages;
    if (state === undefined) throw new Error("expected the installed driver");
    return state;
  }

  it("stays quarantined and untrusted, and contributes nothing", async () => {
    const context = await installed();
    const state = driverState(context.lifecycle.snapshot());
    expect(state.activation).toMatchObject({
      installed: true,
      quarantined: true,
      trusted: false,
      pluginDesired: false,
    });
    expect(state.components.map((component) => component.effectiveState)).toEqual([
      { kind: "blocked", reason: "quarantined" },
    ]);
  });

  it("stays quarantined when its source is trusted and its switches are turned on, and after replay", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    const version = () => driverState(context.lifecycle.snapshot()).stateVersion;
    await context.api.execute({
      kind: "set-source-trust",
      commandVersion: 1 as never,
      extensionId,
      expectedStateVersion: version(),
      trusted: true,
    });
    await context.api.execute({
      kind: "set-plugin-desired",
      commandVersion: 1 as never,
      extensionId,
      expectedStateVersion: version(),
      desired: true,
    });
    await context.api.execute({
      kind: "set-component-desired",
      commandVersion: 1 as never,
      extensionId,
      expectedStateVersion: version(),
      componentId: "driver" as never,
      desired: true,
    });
    expect(driverState(context.lifecycle.snapshot()).activation).toMatchObject({
      trusted: true,
      pluginDesired: true,
      quarantined: true,
    });
    const blocked = [{ kind: "blocked", reason: "quarantined" }];
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual(blocked);
    const projection = context.runtime.projections.get("extensions");
    if (projection === undefined) throw new Error("expected the extension projection");
    rebuildProjection({
      connection: context.connection,
      journal: context.journal,
      projection,
      clock: () => now,
    });
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual(blocked);
  });

  it("is never selected by a structured reference or a mention, which change nothing", async () => {
    const context = await installed();
    const snapshot = context.lifecycle.snapshot();
    const head = context.journal.headSequence();
    const effective = new ExtensionActivationService({
      policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
      catalogStatus: () => "available",
    }).resolve(snapshot, {
      scope: {
        hostId: LOCAL_HOST_ID,
        mode: "chat",
        projectId: null,
        threadId: null,
        providerFamily: "outside-harness-endpoint" as never,
      },
    });
    const { addressing } = buildCatalogs(snapshot, effective, {
      mode: "chat",
      threadId: null,
      projectId: null,
      threadVersion: 1,
      providerInstanceId: "outside" as never,
      modelId: "model" as never,
    });
    expect(
      resolveStructuredPluginReference(
        { extensionId: context.entry.extensionId, componentId: "driver" as never },
        addressing,
        "draft-1",
      ),
    ).toEqual({ kind: "blocked", reason: "quarantined" });
    expect(resolveDraftExtensionReference("@loopback-chat", addressing, "draft-1")).toEqual({
      kind: "blocked",
      reason: "quarantined",
    });
    expect(context.journal.headSequence()).toBe(head);
    expect(driverState(context.lifecycle.snapshot())).toEqual(driverState(snapshot));
  });
});
