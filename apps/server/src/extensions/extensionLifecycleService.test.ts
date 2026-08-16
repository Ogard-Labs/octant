import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionPackageManifest } from "@octant/contracts/extensions";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { rebuildProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  EXTENSION_AGGREGATE_TYPE,
  EXTENSION_LIFECYCLE_EVENT,
  readExtensionRecord,
} from "../persistence/extensionProjection";
import {
  calculateExtensionPackageDigest,
  inspectExtensionPackage,
  type ExtensionArchiveEntry,
} from "./packageInspector";
import { ExtensionPackageStore, type ExtensionVersionReference } from "./extensionPackageStore";
import {
  ExtensionLifecycleService,
  NOOP_EXTENSION_SUPERVISOR,
  type ExtensionLifecycleFaultPoint,
  type ExtensionSupervisorPort,
} from "./extensionLifecycleService";
import type { ExtensionRuntimeEvidence } from "./extensionSupervisor";

const directories: Array<string> = [];
const extensionId = "43000000-0000-4000-8000-000000000001";
const packageId = "43000000-0000-4000-8000-000000000002";
const now = "2026-07-28T12:00:00.000Z";

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

function inspection(
  version = "1.0.0",
  body = version,
  capabilities: ReadonlyArray<"mcp" | "shell"> = ["mcp"],
) {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "runtime/main.mjs",
      kind: "file",
      content: new TextEncoder().encode(body),
      executable: true,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "lifecycle-fixture",
    displayName: "Lifecycle fixture",
    version,
    digest: `sha256:${"0".repeat(64)}`,
    source: { kind: "catalog", catalogId: "octant", entryId: "lifecycle-fixture" },
    provenance: {
      canonicalUrl: "https://example.com/lifecycle-fixture",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: capabilities,
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: capabilities,
        entryPoint: "runtime/main.mjs",
      },
    ],
  };
  manifest.digest = calculateExtensionPackageDigest(manifest, entries);
  return inspectExtensionPackage({
    format: "zip",
    archiveBytes: 512,
    manifest,
    entries,
    expectedDigest: manifest.digest as never,
    appVersion: "1.0.0",
    platform: "darwin",
  });
}

async function setup(
  options: {
    readonly fault?: ((point: ExtensionLifecycleFaultPoint) => void) | undefined;
    readonly supervisor?: ExtensionSupervisorPort;
    readonly isCompatible?: (manifest: ExtensionPackageManifest) => boolean;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-extension-lifecycle-"));
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
  const makeService = (overrides: Parameters<typeof setup>[0] = {}) => {
    const fault = "fault" in overrides ? overrides.fault : options.fault;
    return new ExtensionLifecycleService({
      connection,
      journal,
      store,
      supervisor: overrides.supervisor ?? options.supervisor ?? NOOP_EXTENSION_SUPERVISOR,
      uuid: randomUUID,
      clock: () => now,
      ...(fault === undefined ? {} : { fault }),
      ...((overrides.isCompatible ?? options.isCompatible) === undefined
        ? {}
        : { isCompatible: overrides.isCompatible ?? options.isCompatible }),
    });
  };
  return { dataDirectory, connection, journal, runtime, store, makeService };
}

function targetFor(value: ReturnType<typeof inspection>): ExtensionVersionReference {
  return {
    extensionId: value.manifest.extensionId,
    packageId: value.manifest.packageId,
    version: value.manifest.version,
    digest: value.manifest.digest,
  };
}

function appendLifecycle(
  context: Awaited<ReturnType<typeof setup>>,
  payload:
    | { readonly kind: "source-trust-changed"; readonly trusted: boolean }
    | { readonly kind: "plugin-desired-state-changed"; readonly desired: boolean }
    | {
        readonly kind: "component-desired-state-changed";
        readonly componentId: "server";
        readonly desired: boolean;
      },
): void {
  const current = readExtensionRecord(context.connection, extensionId);
  context.journal.append({
    aggregate: { aggregateType: EXTENSION_AGGREGATE_TYPE, aggregateId: extensionId },
    expectedVersion: current?.aggregateVersion ?? 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: EXTENSION_LIFECYCLE_EVENT,
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: now,
        payload: { eventVersion: 1, extensionId, payload },
      },
    ],
  });
}

describe("journaled extension lifecycle and startup reconciliation", () => {
  it.each(["after-prepared", "after-promotion"] as const)(
    "keeps interrupted install at %s invisible and quarantines it idempotently on restart",
    async (faultPoint) => {
      const context = await setup({
        fault: (point) => {
          if (point === faultPoint) throw new Error("simulated crash");
        },
      });
      await expect(context.makeService().install(inspection())).rejects.toThrow("simulated crash");
      expect(context.makeService().snapshot().packages).toEqual([]);

      const restarted = context.makeService({ fault: undefined });
      await restarted.reconcileStartup();
      expect(restarted.snapshot().packages).toEqual([]);
      const inventory = await context.store.inventory();
      expect(inventory.filter((item) => item.kind === "staging")).toHaveLength(0);
      expect(inventory.filter((item) => item.kind === "version")).toHaveLength(0);
      expect(inventory.filter((item) => item.kind === "quarantine")).toHaveLength(1);
      const head = context.journal.headSequence();
      await restarted.reconcileStartup();
      expect(context.journal.headSequence()).toBe(head);
    },
  );

  it("treats crash-after-commit as committed and replay-safe", async () => {
    const context = await setup({
      fault: (point) => {
        if (point === "after-commit") throw new Error("simulated crash");
      },
    });
    await expect(context.makeService().install(inspection())).rejects.toThrow("simulated crash");
    expect(context.makeService().snapshot().packages[0]?.activation.installed).toBe(true);

    const restarted = context.makeService({ fault: undefined });
    await restarted.reconcileStartup();
    expect(restarted.snapshot().packages).toHaveLength(1);
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(1);
  });

  it("retains the last-known-good version when an update is interrupted", async () => {
    const context = await setup();
    await context.makeService().install(inspection("1.0.0", "known good"));
    const interrupted = context.makeService({
      fault: (point) => {
        if (point === "after-promotion") throw new Error("simulated update crash");
      },
    });
    await expect(interrupted.update(inspection("2.0.0", "candidate"))).rejects.toThrow(
      "simulated update crash",
    );
    expect(interrupted.snapshot().packages[0]?.version).toBe("1.0.0");

    await context.makeService().reconcileStartup();
    expect(context.makeService().snapshot().packages[0]?.version).toBe("1.0.0");
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(1);
  });

  it("preserves desired state only for unchanged components across updates", async () => {
    const context = await setup();
    await context.makeService().install(inspection());
    appendLifecycle(context, { kind: "source-trust-changed", trusted: true });
    appendLifecycle(context, { kind: "plugin-desired-state-changed", desired: true });
    appendLifecycle(context, {
      kind: "component-desired-state-changed",
      componentId: "server",
      desired: true,
    });

    const unchanged = await context.makeService().update(inspection("1.1.0", "unchanged"));
    expect(unchanged.packages[0]?.components[0]?.activation.componentDesired).toBe(true);

    const expanded = await context
      .makeService()
      .update(inspection("2.0.0", "expanded", ["mcp", "shell"]));
    expect(expanded.packages[0]).toMatchObject({
      activation: { trusted: false, pluginDesired: false, quarantined: true },
      components: [{ activation: { componentDesired: false } }],
    });
  });

  it("journals independent trust and desired state with optimistic replay-safe updates", async () => {
    const context = await setup();
    const service = context.makeService();
    const installed = await service.install(inspection());
    expect(installed.packages[0]).toMatchObject({
      slug: "lifecycle-fixture",
      displayName: "Lifecycle fixture",
    });
    const initialVersion = installed.packages[0]!.stateVersion;

    const trusted = await service.setSourceTrust({
      extensionId: extensionId as never,
      trusted: true,
      expectedStateVersion: initialVersion,
    });
    expect(trusted.packages[0]).toMatchObject({
      stateVersion: Number(initialVersion) + 1,
      activation: { trusted: true, pluginDesired: false },
      components: [{ effectiveState: { kind: "blocked", reason: "plugin-disabled" } }],
    });
    await expect(
      service.setPluginDesired({
        extensionId: extensionId as never,
        desired: true,
        expectedStateVersion: initialVersion,
      }),
    ).rejects.toMatchObject({ category: "conflict" });

    const pluginEnabled = await service.setPluginDesired({
      extensionId: extensionId as never,
      desired: true,
      expectedStateVersion: trusted.packages[0]!.stateVersion,
    });
    const componentEnabled = await service.setComponentDesired({
      extensionId: extensionId as never,
      componentId: "server" as never,
      desired: true,
      expectedStateVersion: pluginEnabled.packages[0]!.stateVersion,
    });
    expect(componentEnabled.packages[0]).toMatchObject({
      activation: { trusted: true, pluginDesired: true },
      components: [
        {
          activation: { componentDesired: true },
          effectiveState: { kind: "effective" },
        },
      ],
    });

    const head = context.journal.headSequence();
    const unchanged = await service.setComponentDesired({
      extensionId: extensionId as never,
      componentId: "server" as never,
      desired: true,
      expectedStateVersion: componentEnabled.packages[0]!.stateVersion,
    });
    expect(context.journal.headSequence()).toBe(head);
    expect(unchanged).toEqual(componentEnabled);

    const projection = context.runtime.projections.get("extensions")!;
    rebuildProjection({
      connection: context.connection,
      journal: context.journal,
      projection,
      clock: () => now,
    });
    expect(context.makeService().snapshot()).toEqual(componentEnabled);
  });

  it("rejects desired state for unknown components without writing an event", async () => {
    const context = await setup();
    const service = context.makeService();
    const installed = await service.install(inspection());
    const head = context.journal.headSequence();

    await expect(
      service.setComponentDesired({
        extensionId: extensionId as never,
        componentId: "unknown" as never,
        desired: true,
        expectedStateVersion: installed.packages[0]!.stateVersion,
      }),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(context.journal.headSequence()).toBe(head);
  });

  it("rolls back only to retained integrity-verified versions without restoring trust or enablement", async () => {
    const context = await setup();
    const first = inspection("1.0.0", "known good");
    await context.makeService().install(first);
    await context.makeService().update(inspection("2.0.0", "new version"));

    const rolledBack = await context.makeService().rollback(targetFor(first));
    expect(rolledBack.packages[0]).toMatchObject({
      version: "1.0.0",
      activation: { installed: true, trusted: false, pluginDesired: false },
    });

    const contentPath = join(
      context.dataDirectory,
      "extensions",
      "versions",
      extensionId,
      packageId,
      `${first.manifest.version}--${first.manifest.digest.slice("sha256:".length)}`,
      "content",
      "runtime",
      "main.mjs",
    );
    await chmod(contentPath, 0o600);
    await writeFile(contentPath, "tampered");
    await context.makeService().update(inspection("3.0.0", "latest"));
    await expect(context.makeService().rollback(targetFor(first))).rejects.toMatchObject({
      category: "invalid",
    });
    expect(context.makeService().snapshot().packages[0]?.version).toBe("3.0.0");
  });

  it("rejects a retained rollback version that is no longer compatible", async () => {
    const context = await setup();
    const first = inspection("1.0.0", "known good");
    await context.makeService().install(first);
    await context.makeService().update(inspection("2.0.0", "new version"));

    await expect(
      context.makeService({ isCompatible: () => false }).rollback(targetFor(first)),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(context.makeService().snapshot().packages[0]?.version).toBe("2.0.0");
  });

  it("blocks, drains, and preserves waiting state without unregistering or deleting uncertain residue", async () => {
    const order: Array<string> = [];
    const supervisor: ExtensionSupervisorPort = {
      blockNewActivation: async () => void order.push("block"),
      drain: async () => {
        order.push("drain");
        return { state: "waiting" };
      },
      unregister: async () => void order.push("unregister"),
      receipts: async () => [],
    };
    const context = await setup({ supervisor });
    await context.makeService().install(inspection());

    const disabled = await context.makeService().disable(extensionId);
    expect(order).toEqual(["block", "drain"]);
    expect(disabled.packages[0]?.activation).toMatchObject({
      pluginDesired: false,
      draining: true,
      waiting: true,
    });
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(1);

    order.length = 0;
    await context.makeService().uninstall(extensionId);
    expect(order).toEqual(["block", "drain"]);
    expect(context.makeService().snapshot().packages[0]?.activation.installed).toBe(true);
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(1);
  });

  it("unregisters before deleting files and preserves an uninstalled provenance tombstone", async () => {
    const order: Array<string> = [];
    const supervisor: ExtensionSupervisorPort = {
      blockNewActivation: async () => void order.push("block"),
      drain: async () => {
        order.push("drain");
        return { state: "drained" };
      },
      unregister: async () => void order.push("unregister"),
      receipts: async () => [],
    };
    const context = await setup({ supervisor });
    await context.makeService().install(inspection());
    const snapshot = await context.makeService().uninstall(extensionId);

    expect(order).toEqual(["block", "drain", "unregister"]);
    expect(snapshot.packages[0]).toMatchObject({
      extensionId,
      packageId,
      activation: { installed: false, trusted: false, pluginDesired: false },
    });
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(0);
  });

  it("records waiting instead of throwing when supervisor cleanup is inconclusive", async () => {
    const context = await setup({
      supervisor: {
        blockNewActivation: async () => {
          throw new Error("private supervisor detail");
        },
        drain: async () => ({ state: "drained" }),
        unregister: async () => undefined,
        receipts: async () => [],
      },
    });
    await context.makeService().install(inspection());

    const snapshot = await context.makeService().disable(extensionId);
    expect(snapshot.packages[0]?.activation).toMatchObject({
      pluginDesired: false,
      draining: true,
      waiting: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain("private supervisor");
  });

  it("persists only redacted runtime lifecycle evidence", async () => {
    const context = await setup();
    await context.makeService().install(inspection());
    const installed = inspection();
    const evidence: ExtensionRuntimeEvidence = {
      kind: "extension-runtime",
      extensionId,
      packageId,
      componentId: "server",
      version: "1.0.0",
      digest: installed.manifest.digest,
      state: "crashed",
      observedAt: now,
      reason: "process-crashed",
    };

    context.makeService().recordRuntimeEvidence(evidence);
    const record = readExtensionRecord(context.connection, extensionId);
    expect(record).toMatchObject({ lifecycleState: "broken", broken: true });
    expect(JSON.stringify(record)).not.toContain("/private");
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  it("quarantines unreadable staging residue without creating a visible package", async () => {
    const context = await setup();
    const residue = join(context.dataDirectory, "extensions", "staging", "ambiguous-residue");
    await mkdir(residue, { recursive: true });
    await writeFile(join(residue, "receipt.json"), "not-json");

    await context.makeService().reconcileStartup();
    expect(context.makeService().snapshot().packages).toEqual([]);
    const inventory = await context.store.inventory();
    expect(inventory.filter((item) => item.kind === "staging")).toHaveLength(0);
    expect(inventory.filter((item) => item.kind === "quarantine")).toHaveLength(1);
  });

  it("interrupts a prepared transaction whose staging residue is already absent", async () => {
    const context = await setup({
      fault: (point) => {
        if (point === "after-prepared") throw new Error("simulated crash");
      },
    });
    await expect(context.makeService().install(inspection())).rejects.toThrow("simulated crash");
    const staged = (await context.store.inventory()).find((item) => item.kind === "staging");
    expect(staged).toBeDefined();
    await context.store.quarantineStage(staged!.opaqueId, "external-recovery");

    const restarted = context.makeService({ fault: undefined });
    await restarted.reconcileStartup();
    expect(readExtensionRecord(context.connection, extensionId)).toMatchObject({
      lifecycleState: "interrupted",
      interrupted: true,
      diagnostics: [{ code: "startup-reconciled" }],
    });
    const head = context.journal.headSequence();
    await restarted.reconcileStartup();
    expect(context.journal.headSequence()).toBe(head);
  });

  it("records unknown supervisor residue as waiting and retries without duplicate events", async () => {
    const residueExtensionId = "43000000-0000-4000-8000-000000000011";
    const residuePackageId = "43000000-0000-4000-8000-000000000012";
    const context = await setup({
      supervisor: {
        blockNewActivation: async () => undefined,
        drain: async () => {
          throw new Error("private supervisor failure");
        },
        unregister: async () => undefined,
        receipts: async () => [
          {
            extensionId: residueExtensionId,
            packageId: residuePackageId,
            componentId: "orphan",
            state: "uncertain",
          },
        ],
      },
    });

    await context.makeService().reconcileStartup();
    expect(readExtensionRecord(context.connection, residueExtensionId)).toMatchObject({
      packageId: residuePackageId,
      lifecycleState: "waiting",
      waiting: true,
      diagnostics: [{ code: "runtime-broken" }],
    });
    const head = context.journal.headSequence();
    await context.makeService().reconcileStartup();
    expect(context.journal.headSequence()).toBe(head);
  });

  it("quarantines an immutable version whose private receipt is unreadable", async () => {
    const context = await setup();
    const installed = inspection();
    await context.makeService().install(installed);
    const versionDirectory = join(
      context.dataDirectory,
      "extensions",
      "versions",
      extensionId,
      packageId,
      `${installed.manifest.version}--${installed.manifest.digest.slice("sha256:".length)}`,
    );
    const receipt = join(versionDirectory, "receipt.json");
    await chmod(receipt, 0o600);
    await writeFile(receipt, "not-json");

    await context.makeService().reconcileStartup();
    const inventory = await context.store.inventory();
    expect(inventory.filter((item) => item.kind === "version")).toHaveLength(0);
    expect(inventory.filter((item) => item.kind === "quarantine")).toHaveLength(1);
    expect(context.makeService().snapshot().packages[0]?.activation).toMatchObject({
      quarantined: true,
      broken: true,
    });
  });

  it("quarantines corrupt selected bytes and rebuilds the projection deterministically", async () => {
    const context = await setup();
    const installed = inspection();
    await context.makeService().install(installed);
    const contentPath = join(
      context.dataDirectory,
      "extensions",
      "versions",
      extensionId,
      packageId,
      `${installed.manifest.version}--${installed.manifest.digest.slice("sha256:".length)}`,
      "content",
      "runtime",
      "main.mjs",
    );
    await chmod(contentPath, 0o600);
    await writeFile(contentPath, "tampered");

    await context.makeService().reconcileStartup();
    const quarantined = context.makeService().snapshot();
    expect(quarantined.packages[0]?.activation).toMatchObject({
      quarantined: true,
      broken: true,
    });
    const projection = context.runtime.projections.get("extensions");
    expect(projection).toBeDefined();
    rebuildProjection({
      connection: context.connection,
      journal: context.journal,
      projection: projection!,
      clock: () => now,
    });
    expect(context.makeService().snapshot()).toEqual(quarantined);
  });
});
