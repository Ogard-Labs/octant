import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  createLocalExtensionActivationPolicy,
  ExtensionActivationService,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { buildCatalogs } from "./extensionChatResolver";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";
import { readOutsideProviderDriverPackage } from "./outsideProviderDriverPackage";
import { signOutsideDriverPackage } from "@octant/provider-sdk/outside-driver-sign";

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
    readonly files?: Readonly<
      Record<string, { readonly content: string | Uint8Array; readonly mode?: number }>
    >;
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-outside-driver-"));
  directories.push(root);
  const files: Record<string, { readonly content: string | Uint8Array; readonly mode?: number }> = {
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
      "a 64-bit universal binary under an innocent name",
      {
        files: { "dist/data.bin": { content: Uint8Array.of(0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 2) } },
      },
      "This provider driver ships native code; a provider driver is JavaScript modules and data only.",
    ],
    [
      "an install script npm still runs on a plain install",
      {
        files: {
          "package.json": {
            content: JSON.stringify({ name: "x", scripts: { prepublish: "node setup.js" } }),
          },
        },
      },
      "This provider driver has an install script; Octant runs no install step for a provider driver.",
    ],
    [
      "an install script in a package description named in another case",
      {
        files: {
          "lib/Package.json": {
            content: JSON.stringify({ name: "x", scripts: { postinstall: "node setup.js" } }),
          },
        },
      },
      "This provider driver has an install script; Octant runs no install step for a provider driver.",
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

/** A throwaway Ed25519 key made for one test; it is never written to disk. */
function throwawayKey(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
}

describe("outside provider driver publisher signatures", () => {
  it("verifies a signed folder and shows the key that signed it in the review", async () => {
    const context = await setup();
    const root = await writeDriverFolder();
    const signed = await signOutsideDriverPackage({ root, privateKeyPem: throwawayKey() });

    const result = await context.inspect(root);

    expect(result.kind).toBe("package-inspected");
    if (result.kind !== "package-inspected") return;
    expect(result.preview.review.provenance.publisherKey).toBe(signed.fingerprint);
  });

  it("keeps an unsigned folder as developer input with no publisher key", async () => {
    const context = await setup();
    const result = await context.inspect(await writeDriverFolder());
    if (result.kind !== "package-inspected") throw new Error("expected an inspected driver");
    expect(result.preview.review.provenance.publisherKey).toBeUndefined();
  });

  it.each([
    ["a file changed after signing", { "dist/driver.mjs": "export default { changed: true };\n" }],
    ["a file added after signing", { "dist/extra.mjs": "export const extra = 1;\n" }],
  ] as const)("refuses a signed folder with %s as signature-invalid", async (_label, files) => {
    const context = await setup();
    const root = await writeDriverFolder();
    await signOutsideDriverPackage({ root, privateKeyPem: throwawayKey() });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }

    const result = await context.inspect(root);

    expect(refusalMessage(result)).toBe(
      "This provider driver's signature does not match its files, name, or version, or does not verify.",
    );
    expect(context.lifecycle.snapshot().packages).toEqual([]);
  });

  it("refuses a signature that names another version, or that another key made", async () => {
    const context = await setup();
    const root = await writeDriverFolder();
    await signOutsideDriverPackage({ root, privateKeyPem: throwawayKey() });
    const path = join(root, "octant-signature.json");
    const signature = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    await writeFile(path, JSON.stringify({ ...signature, version: "0.2.0" }));
    expect(refusalMessage(await context.inspect(root))).toMatch(/signature does not match/);

    const other = await writeDriverFolder();
    await signOutsideDriverPackage({ root: other, privateKeyPem: throwawayKey() });
    const otherSignature = JSON.parse(
      await readFile(join(other, "octant-signature.json"), "utf8"),
    ) as Record<string, unknown>;
    // The other key's public half beside this key's signature does not verify.
    await writeFile(path, JSON.stringify({ ...signature, publicKey: otherSignature.publicKey }));
    expect(refusalMessage(await context.inspect(root))).toMatch(/signature does not match/);
  });

  it("refuses a driver document that states its own publisher key", async () => {
    const context = await setup();
    const result = await context.inspect(
      await writeDriverFolder({
        document: driverDocument({
          provenance: { publisher: "Example Author", publisherKey: `ed25519:${"a".repeat(64)}` },
        }),
      }),
    );
    expect(refusalMessage(result)).toBe(
      "This provider driver states its own identity, source, digest or review; Octant sets those itself.",
    );
  });

  it("refuses a marketplace package with no signature as signature-missing, and a signed one until its source exists", async () => {
    const registry = new LocalPluginFolderRegistry({ platform: "darwin" });
    const read = async (root: string) => {
      const input = (await registry.register(root)).packageInput;
      if (!("layout" in input) || input.layout !== "outside-provider-driver") {
        throw new Error("expected a driver folder");
      }
      // The same files, as a marketplace would hand them over.
      return readOutsideProviderDriverPackage({
        ...input,
        source: { kind: "plugin-package", sourceRef: "npm:loopback-chat" as never },
      });
    };

    expect(await read(await writeDriverFolder())).toEqual({
      status: "refused",
      reason: "signature-missing",
    });

    const tampered = await writeDriverFolder();
    await signOutsideDriverPackage({ root: tampered, privateKeyPem: throwawayKey() });
    await writeFile(join(tampered, "dist/driver.mjs"), "export default { changed: true };\n");
    expect(await read(tampered)).toEqual({ status: "refused", reason: "signature-invalid" });

    const signed = await writeDriverFolder();
    await signOutsideDriverPackage({ root: signed, privateKeyPem: throwawayKey() });
    expect(await read(signed)).toEqual({ status: "refused", reason: "source-unsupported" });
  });
});

describe("an installed outside provider driver", () => {
  async function installed() {
    const context = await setup();
    const root = await writeDriverFolder();
    const inspected = await context.inspect(root);
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
    return { ...context, root, entry };
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

  it("stays quarantined while its switches are turned on, until its source is trusted", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    const version = () => driverState(context.lifecycle.snapshot()).stateVersion;
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
      trusted: false,
      pluginDesired: true,
      quarantined: true,
    });
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual([{ kind: "blocked", reason: "quarantined" }]);
  });

  it("is admitted at the selected digest when its source is trusted, and after replay", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    const version = () => driverState(context.lifecycle.snapshot()).stateVersion;
    const trust = (trusted: boolean) =>
      context.api.execute({
        kind: "set-source-trust",
        commandVersion: 1 as never,
        extensionId,
        expectedStateVersion: version(),
        trusted,
      });
    await trust(true);
    // Trust lifts the quarantine; the switches are still the person's to turn on.
    expect(driverState(context.lifecycle.snapshot()).activation).toMatchObject({
      trusted: true,
      quarantined: false,
    });
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual([{ kind: "blocked", reason: "plugin-disabled" }]);
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
    const admitted = [{ kind: "effective" }];
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual(admitted);
    expect(driverState(context.lifecycle.snapshot()).digest).toBe(context.entry.digest);
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
    ).toEqual(admitted);

    // Withdrawn trust quarantines it again, so trusting is again the review step.
    await trust(false);
    expect(driverState(context.lifecycle.snapshot()).activation).toMatchObject({
      trusted: false,
      quarantined: true,
    });
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual([{ kind: "blocked", reason: "quarantined" }]);
  });

  it("keeps a package whose stored version failed verification quarantined through trust", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    context.lifecycle.recordRuntimeEvidence({
      kind: "extension-runtime",
      extensionId,
      packageId: context.entry.packageId,
      componentId: "driver",
      version: context.entry.version,
      digest: context.entry.digest,
      state: "quarantined",
      observedAt: now,
      reason: "restart-reconciled",
    });
    await context.api.execute({
      kind: "set-source-trust",
      commandVersion: 1 as never,
      extensionId,
      expectedStateVersion: driverState(context.lifecycle.snapshot()).stateVersion,
      trusted: true,
    });
    expect(driverState(context.lifecycle.snapshot()).activation).toMatchObject({
      trusted: true,
      quarantined: true,
    });
  });

  it("is not broken for every instance by one driver process that crashed", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    const version = () => driverState(context.lifecycle.snapshot()).stateVersion;
    for (const command of [
      { kind: "set-source-trust", trusted: true },
      { kind: "set-plugin-desired", desired: true },
      { kind: "set-component-desired", componentId: "driver", desired: true },
    ] as const) {
      await context.api.execute({
        ...command,
        commandVersion: 1 as never,
        extensionId,
        expectedStateVersion: version(),
      } as never);
    }
    context.lifecycle.recordRuntimeEvidence({
      kind: "extension-runtime",
      extensionId,
      packageId: context.entry.packageId,
      componentId: "driver",
      version: context.entry.version,
      digest: context.entry.digest,
      state: "crashed",
      observedAt: now,
      reason: "process-crashed",
    });
    // The host's per-instance crash limit decides what a crash costs; the
    // package stays admitted for the other instances.
    expect(
      driverState(context.lifecycle.snapshot()).components.map((c) => c.effectiveState),
    ).toEqual([{ kind: "effective" }]);
  });

  it("is quarantined again and loses its trust when an update or a rollback selects another version", async () => {
    const context = await installed();
    const extensionId = context.entry.extensionId;
    const version = () => driverState(context.lifecycle.snapshot()).stateVersion;
    const trust = () =>
      context.api.execute({
        kind: "set-source-trust",
        commandVersion: 1 as never,
        extensionId,
        expectedStateVersion: version(),
        trusted: true,
      });
    await trust();
    await writeFile(
      join(context.root, "octant-provider-driver.json"),
      JSON.stringify(driverDocument({ version: "0.2.0" })),
    );
    const updated = await context.inspect(context.root);
    if (updated.kind !== "package-inspected") throw new Error("expected an inspected update");
    expect(updated.preview.entry.extensionId).toBe(extensionId);
    const update = await context.api.execute({
      kind: "update-package",
      extensionId,
      packageId: updated.preview.entry.packageId,
      version: updated.preview.entry.version,
      digest: updated.preview.entry.digest,
    });
    expect(update.kind).toBe("extension-state-updated");
    expect(driverState(context.lifecycle.snapshot()).activation).toMatchObject({
      quarantined: true,
      trusted: false,
    });
    await trust();
    const rollback = await context.api.execute({
      kind: "rollback-package",
      extensionId,
      packageId: context.entry.packageId,
      version: context.entry.version,
      digest: context.entry.digest,
    });
    expect(rollback.kind).toBe("extension-state-updated");
    const state = driverState(context.lifecycle.snapshot());
    expect(state.version).toBe("0.1.0");
    expect(state.activation).toMatchObject({ quarantined: true, trusted: false });
    expect(state.components.map((component) => component.effectiveState)).toEqual([
      { kind: "blocked", reason: "quarantined" },
    ]);
  });

  it("is never selected by a structured reference or a mention, which change nothing", async () => {
    const context = await installed();
    const snapshot = context.lifecycle.snapshot();
    const head = context.journal.headSequence();
    const effective = effectiveOn("darwin", snapshot);
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

  it("is host-prohibited on a Linux host, which has no confinement to start it in", async () => {
    const context = await installed();
    const snapshot = context.lifecycle.snapshot();
    for (const [platform, reason] of [
      ["linux", "host-prohibited"],
      ["darwin", "quarantined"],
    ] as const) {
      const driver = effectiveOn(platform, snapshot).packages.find(
        (candidate) => String(candidate.extensionId) === String(context.entry.extensionId),
      );
      expect(driver?.components.map((component) => component.effectiveState)).toEqual([
        { kind: "blocked", reason },
      ]);
    }
  });
});

function effectiveOn(platform: string, snapshot: ExtensionSnapshot) {
  return new ExtensionActivationService({
    policy: createLocalExtensionActivationPolicy(
      {
        project: (scope) => ({ allowed: scope.projectId === null, revision: 0 }),
        thread: (scope) => ({ allowed: scope.threadId === null, revision: 0 }),
      },
      platform,
    ),
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
}
