import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  calculateExtensionPackageDigest,
  inspectExtensionPackage,
  type ExtensionArchiveEntry,
} from "./packageInspector";
import { ExtensionPackageStore } from "./extensionPackageStore";
import { ExtensionLifecycleService } from "./extensionLifecycleService";
import {
  ExtensionSupervisor,
  type ExtensionProcessHandle,
  type ExtensionProcessPort,
  type ExtensionRuntimeEvidence,
  type ExtensionRuntimeStartInput,
} from "./extensionSupervisor";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";

const extensionId = "15000000-0000-4000-8000-000000000001";
const packageId = "15000000-0000-4000-8000-000000000002";
const now = "2026-07-29T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

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

function inspection() {
  const entries: ReadonlyArray<ExtensionArchiveEntry> = [
    {
      path: "runtime/main.mjs",
      kind: "file",
      content: new TextEncoder().encode("1.0.0"),
      executable: true,
    },
  ];
  const manifest = {
    manifestVersion: 1,
    extensionId,
    packageId,
    slug: "combined-recovery-fixture",
    displayName: "Combined recovery fixture",
    version: "1.0.0",
    digest,
    source: { kind: "catalog", catalogId: "octant", entryId: "combined-recovery-fixture" },
    provenance: {
      canonicalUrl: "https://example.com/combined-recovery-fixture",
      publisher: "Example Publisher",
      reviewed: false,
    },
    license: { kind: "spdx", identifier: "MIT" },
    compatibility: { platforms: ["macos"], modes: ["code"], providerFamilies: [] },
    declaredCapabilities: ["mcp"],
    components: [
      {
        id: "server",
        kind: "mcp-server",
        displayName: "Server",
        declaredCapabilities: ["mcp"],
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

class FakeProcess extends EventEmitter implements ExtensionProcessHandle {
  readonly pid: number;
  ready = Promise.resolve();
  readonly wait = Promise.resolve({ code: 0, signal: null });
  readonly stop = vi.fn(async () => undefined);
  readonly cancel = vi.fn(async () => undefined);
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

function fakeProcessPort(processes: FakeProcess[]): ExtensionProcessPort {
  let pid = 1501;
  return {
    start: vi.fn(async () => {
      const process = new FakeProcess(pid++);
      processes.push(process);
      return process;
    }),
    receipts: vi.fn(async () => []),
  };
}

function startInput(inspectionResult: ReturnType<typeof inspection>): ExtensionRuntimeStartInput {
  const manifest = inspectionResult.manifest;
  const cwd = "/tmp/octant-combined-recovery";
  const entryPoint = join(cwd, "runtime", "main.mjs");
  return {
    extensionId: manifest.extensionId,
    packageId: manifest.packageId,
    componentId: "server",
    version: manifest.version,
    digest: manifest.digest,
    entryPoint,
    command: entryPoint,
    args: [entryPoint],
    cwd,
    env: { OCTANT_EXTENSION_ID: manifest.extensionId },
    effective: true,
    approved: true,
    authority: { kind: "trusted-extension", extensionId: manifest.extensionId },
  };
}

async function setup(options: { readonly dataDirectory?: string } = {}) {
  const dataDirectory =
    options.dataDirectory ?? (await mkdtemp(join(tmpdir(), "octant-combined-recovery-")));
  if (options.dataDirectory === undefined) directories.push(dataDirectory);
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
  const processes: FakeProcess[] = [];
  const evidence: ExtensionRuntimeEvidence[] = [];
  const supervisor = new ExtensionSupervisor({
    process: fakeProcessPort(processes),
    clock: () => now,
    authorizeLaunch: async () => true,
    evidence: (event) => evidence.push(event),
    limits: {
      maxComponents: 4,
      startupTimeoutMs: 25,
      drainTimeoutMs: 25,
      maxCrashRestarts: 2,
      crashWindowMs: 60_000,
    },
  });
  const lifecycle = new ExtensionLifecycleService({
    connection,
    journal,
    store,
    supervisor,
    uuid: randomUUID,
    clock: () => now,
  });
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus: () => "available",
    compatibility: () => true,
  });
  const scope = {
    hostId: LOCAL_HOST_ID,
    mode: "code" as const,
    projectId: null,
    threadId: null,
    providerFamily: "openai-compatible" as never,
  };
  return {
    dataDirectory,
    connection,
    journal,
    store,
    supervisor,
    lifecycle,
    activation,
    processes,
    evidence,
    scope,
  };
}

function componentEffectiveState(
  context: Awaited<ReturnType<typeof setup>>,
): { kind: "effective" } | { kind: "blocked"; reason: string } {
  const resolved = context.activation.resolve(context.lifecycle.snapshot(), {
    scope: context.scope,
  });
  const component = resolved.packages[0]?.components[0];
  if (component === undefined) throw new Error("Expected one component.");
  return component.effectiveState as never;
}

function currentStateVersion(context: Awaited<ReturnType<typeof setup>>): number {
  const pkg = context.lifecycle.snapshot().packages[0];
  if (pkg === undefined) throw new Error("Expected one installed package.");
  return pkg.stateVersion as never;
}

async function trustEnable(context: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await context.lifecycle.setSourceTrust({
    extensionId: extensionId as never,
    expectedStateVersion: currentStateVersion(context) as never,
    trusted: true,
  });
  await context.lifecycle.setPluginDesired({
    extensionId: extensionId as never,
    expectedStateVersion: currentStateVersion(context) as never,
    desired: true,
  });
  await context.lifecycle.setComponentDesired({
    extensionId: extensionId as never,
    componentId: "server" as never,
    expectedStateVersion: currentStateVersion(context) as never,
    desired: true,
  });
}

describe("extension combined recovery integration", () => {
  it("projects effective state after trust and enable, then drains, disables, and recovers through the supervisor", async () => {
    const context = await setup();
    const inspected = inspection();
    await context.lifecycle.install(inspected);

    expect(componentEffectiveState(context)).toMatchObject({
      kind: "blocked",
      reason: "untrusted",
    });

    await trustEnable(context);

    expect(componentEffectiveState(context)).toMatchObject({ kind: "effective" });

    await expect(context.supervisor.start(startInput(inspected))).resolves.toMatchObject({
      state: "ready",
    });
    expect(context.processes).toHaveLength(1);

    await context.lifecycle.disable(extensionId);
    expect(context.processes[0]?.stop).toHaveBeenCalled();
    expect(componentEffectiveState(context)).toMatchObject({
      kind: "blocked",
      reason: "plugin-disabled",
    });

    await context.lifecycle.setPluginDesired({
      extensionId: extensionId as never,
      expectedStateVersion: currentStateVersion(context) as never,
      desired: true,
    });
    expect(componentEffectiveState(context)).toMatchObject({ kind: "effective" });
  });

  it("records supervisor crash-loop quarantine into the activation projection and reconciles idempotently on restart", async () => {
    const context = await setup();
    const inspected = inspection();
    await context.lifecycle.install(inspected);
    await trustEnable(context);
    await context.supervisor.start(startInput(inspected));

    context.processes[0]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(context.processes).toHaveLength(2));
    await vi.waitFor(async () =>
      expect((await context.supervisor.receipts())[0]).toMatchObject({ state: "ready" }),
    );

    context.processes[1]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(context.processes).toHaveLength(3));
    await vi.waitFor(async () =>
      expect((await context.supervisor.receipts())[0]).toMatchObject({ state: "ready" }),
    );

    context.processes[2]!.emit("exit", { code: 1, signal: null });
    const quarantined = context.evidence.find((event) => event.state === "quarantined");
    expect(quarantined).toBeDefined();
    context.lifecycle.recordRuntimeEvidence(quarantined!);

    expect(componentEffectiveState(context)).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    const head = context.journal.headSequence();
    await context.supervisor.reconcile();
    await context.lifecycle.reconcileStartup();
    expect(context.journal.headSequence()).toBe(head);
    expect(componentEffectiveState(context)).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // Re-enabling cannot clear the persistent quarantine: recovery fails closed
    // until the package is explicitly restored through a trusted update.
    await context.lifecycle.setPluginDesired({
      extensionId: extensionId as never,
      expectedStateVersion: currentStateVersion(context) as never,
      desired: true,
    });
    expect(componentEffectiveState(context)).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });
  });

  it("keeps disable waiting and blocks reactivation when supervisor cleanup is uncertain", async () => {
    const context = await setup();
    const inspected = inspection();
    await context.lifecycle.install(inspected);
    await trustEnable(context);
    await context.supervisor.start(startInput(inspected));
    context.processes[0]!.stop.mockImplementation(() => new Promise(() => undefined));

    await context.lifecycle.disable(extensionId);
    const resolved = context.activation.resolve(context.lifecycle.snapshot(), {
      scope: context.scope,
    });
    const component = resolved.packages[0]?.components[0];
    expect(component?.activation.draining).toBe(true);
    expect(component?.activation.waiting).toBe(true);
    expect(component?.effectiveState).toMatchObject({ kind: "blocked" });
  });

  it("recovers quarantine, desired, and effective state after a true restart that closes and recreates connection/store/lifecycle/supervisor/projection", async () => {
    // Phase 1: install, trust, enable, start, crash into quarantine.
    const first = await setup();
    const inspected = inspection();
    await first.lifecycle.install(inspected);
    await trustEnable(first);
    await first.supervisor.start(startInput(inspected));
    expect(componentEffectiveState(first)).toMatchObject({ kind: "effective" });

    // Crash into quarantine.
    first.processes[0]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(first.processes).toHaveLength(2));
    first.processes[1]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(first.processes).toHaveLength(3));
    first.processes[2]!.emit("exit", { code: 1, signal: null });
    const quarantined = first.evidence.find((event) => event.state === "quarantined");
    expect(quarantined).toBeDefined();
    first.lifecycle.recordRuntimeEvidence(quarantined!);
    expect(componentEffectiveState(first)).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // Capture the desired state before restart.
    const beforeRestart = first.lifecycle.snapshot();
    const pkgBefore = beforeRestart.packages[0];
    expect(pkgBefore?.activation.trusted).toBe(true);
    expect(pkgBefore?.activation.pluginDesired).toBe(true);

    // Phase 2: true restart — close the SQLite connection, drop all in-memory
    // objects, and recreate every service from the persisted SQLite database
    // and on-disk extension store.
    const dataDirectory = first.dataDirectory;
    first.connection.close();

    const restarted = await setup({ dataDirectory });

    // The restarted lifecycle must reconcile startup from the persisted journal
    // and store, not from any in-memory state.
    await restarted.lifecycle.reconcileStartup();

    // Quarantine must survive restart — the package stays fail-closed.
    const restartedState = componentEffectiveState(restarted);
    expect(restartedState).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // Desired/trust state must survive restart.
    const pkgAfter = restarted.lifecycle.snapshot().packages[0];
    expect(pkgAfter?.activation.trusted).toBe(true);
    expect(pkgAfter?.activation.pluginDesired).toBe(true);

    // Re-enabling cannot clear the persistent quarantine: recovery fails closed
    // until the package is explicitly restored through a trusted update.
    await restarted.lifecycle.setPluginDesired({
      extensionId: extensionId as never,
      expectedStateVersion: currentStateVersion(restarted) as never,
      desired: true,
    });
    expect(componentEffectiveState(restarted)).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // Disabling must still be permitted even while quarantined. The desired
    // state changes to false; the effective state stays quarantined because
    // quarantine has higher precedence than plugin-disabled in the activation
    // policy — this is the correct fail-closed behavior.
    await restarted.lifecycle.setPluginDesired({
      extensionId: extensionId as never,
      expectedStateVersion: currentStateVersion(restarted) as never,
      desired: false,
    });
    const afterDisable = restarted.activation.resolve(restarted.lifecycle.snapshot(), {
      scope: restarted.scope,
    });
    const componentAfterDisable = afterDisable.packages[0]?.components[0];
    expect(componentAfterDisable?.activation.pluginDesired).toBe(false);
    expect(componentAfterDisable?.effectiveState).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });
  });
});
