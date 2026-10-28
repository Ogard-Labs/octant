import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeWindowId,
  type OutsideProviderDriverReference,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ExtensionCommand, ExtensionCommandResult } from "@octant/contracts/extension-rpc";
import { signOutsideDriverPackage } from "@octant/provider-sdk/outside-driver-sign";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexPluginPackageResolver } from "../extensions/codexPluginResolver";
import { ExtensionApiService } from "../extensions/extensionApiService";
import {
  ExtensionLifecycleService,
  NOOP_EXTENSION_SUPERVISOR,
} from "../extensions/extensionLifecycleService";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import type {
  ExtensionProcessExit,
  ExtensionRuntimeStartInput,
  ExtensionSupervisor,
} from "../extensions/extensionSupervisor";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { rebuildAll } from "../persistence/recovery";
import { journaledOutsideDriverHold, makeConfiguredProviderDriver } from "../wiring/providers";
import { OutsideDriverAdmission } from "./outsideDriverAdmission";
import {
  makeInMemoryOutsideDriverChannel,
  serveFixtureDriver,
  type FixtureDriver,
  type FixtureDriverHandler,
  type InMemoryDriverEnd,
} from "./outsideDriverFixture.test-support";
import {
  OutsideDriverProcesses,
  type OutsideDriverProcessStartInput,
} from "./outsideDriverProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { ProviderService } from "./providerService";

/**
 * Admission end to end on the server: a driver folder inspected, installed,
 * trusted, and switched on through the extension API; a provider added from
 * it, turned on, checked, and verified through the provider service and the
 * real driver factory; and the driver's process held to its instance. The
 * confined process itself is the macOS escape suite's; here each start is an
 * in-memory channel to the fixture driver, recorded so the test can see when
 * a process would start and stop, or, for the crash limit, the host's own
 * process owner over a supervisor whose every process exits as it starts.
 */

const now = "2026-10-27T12:00:00.000Z";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000501");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000502");
const localModel = decodeProviderModelId("local-model");
const directories: Array<string> = [];
const runtimes: Array<{ readonly dispose: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
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

function driverDocument(version = "0.1.0") {
  return {
    driverKind: "outside-harness-endpoint",
    protocolVersions: ["harness-endpoint/1"],
    manifest: {
      manifestVersion: 1,
      slug: "loopback-chat",
      displayName: "Loopback chat",
      version,
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
    },
  };
}

async function writeDriverFolder(root: string, version = "0.1.0"): Promise<void> {
  const files: Record<string, string> = {
    "octant-provider-driver.json": JSON.stringify(driverDocument(version)),
    "dist/driver.mjs": "export default {};\n",
    "package.json": JSON.stringify({ name: "loopback-chat", type: "module" }),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    await chmod(join(root, path), 0o644);
  }
}

/** A tool call the fixture driver reports, as a model that took the echo tool would. */
const echoToolCall = {
  toolCallId: "call-1",
  toolName: "octant_capability_echo",
  argumentsJson: '{"echo":"ready"}',
};

/**
 * A supervisor whose every process exits the moment it starts, as a driver
 * that throws on import does. Each launch is recorded.
 */
function crashingSupervisor(launches: Array<ExtensionRuntimeStartInput>) {
  const supervisor: Pick<ExtensionSupervisor, "startInteractive" | "stopInteractive"> = {
    startInteractive: async (input) => {
      launches.push(input);
      const exit: ExtensionProcessExit = { code: 1, signal: null };
      return {
        receipt: {
          extensionId: input.extensionId,
          packageId: input.packageId,
          componentId: input.componentId,
          state: "ready",
        },
        process: {
          pid: 5_000 + launches.length,
          ready: Promise.resolve(),
          wait: Promise.resolve(exit),
          stop: async () => undefined,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          once: (_event, listener) => queueMicrotask(() => listener(exit)),
        },
      };
    },
    stopInteractive: async () => undefined,
  };
  return supervisor;
}

async function host(
  options: {
    readonly platform?: string;
    readonly handlers?: Readonly<Record<string, FixtureDriverHandler>>;
    /** Start drivers through the host's process owner, each crashing as it starts. */
    readonly crashingDriver?: boolean;
  } = {},
) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-outside-admission-"));
  directories.push(dataDirectory);
  const driverRoot = await mkdtemp(join(tmpdir(), "octant-outside-admission-driver-"));
  directories.push(driverRoot);
  await writeDriverFolder(driverRoot);
  const runtime = ManagedRuntime.make(makePersistenceLive({ dataDirectory, clock: () => now }));
  runtimes.push(runtime);
  const persistence = await runtime.runPromise(Persistence);

  const store = new ExtensionPackageStore({ dataDirectory, uuid: randomUUID });
  await store.initialize();
  let stopPackage: ((extensionId: string) => Promise<void>) | undefined;
  let reconcile: (() => Promise<void>) | undefined;
  let forgetPublisherVerification: ((extensionId: string) => Promise<void>) | undefined;
  const lifecycle = new ExtensionLifecycleService({
    connection: persistence.connection,
    journal: persistence.journal,
    store,
    // As the server wires it: an uninstall stops the package's driver
    // processes before the supervisor drains it.
    supervisor: {
      ...NOOP_EXTENSION_SUPERVISOR,
      blockNewActivation: async (extensionId) => {
        await stopPackage?.(extensionId);
      },
    },
    uuid: randomUUID,
    clock: () => now,
  });
  const folders = new LocalPluginFolderRegistry({ platform: "darwin" });
  const extensions = new ExtensionApiService({
    lifecycle,
    resolver: new CodexPluginPackageResolver({ localFolderRegistry: folders, platform: "darwin" }),
    // As the server wires it: re-trusting a new publisher clears what its
    // instances verified, then the drivers reconcile.
    onStateChanged: async (_snapshot, command) => {
      if (command.kind === "trust-new-publisher") {
        await forgetPublisherVerification?.(String(command.extensionId));
      }
      await reconcile?.();
    },
  });

  const starts: Array<OutsideDriverProcessStartInput> = [];
  const stops: Array<string> = [];
  const drivers: Array<{ readonly end: InMemoryDriverEnd; readonly fixture: FixtureDriver }> = [];
  const registry = new ProviderRuntimeRegistry();
  // As the server wires it: the provider service journals a crash-limit
  // hold, and is built after the process owner, which reaches it late.
  let quarantineOutsideDriver:
    | ((
        instanceId: ProviderInstanceId,
        digest: OutsideProviderDriverReference["digest"],
      ) => Promise<void>)
    | undefined;
  const crashHold = journaledOutsideDriverHold({
    readProviderInstance: (id) => persistence.readProviderInstance(id),
    journalHold: () => quarantineOutsideDriver,
  });
  const launches: Array<ExtensionRuntimeStartInput> = [];
  const temporaryRoot = await mkdtemp(join(tmpdir(), "octant-outside-admission-tmp-"));
  directories.push(temporaryRoot);
  /** The host's process owner, as made at startup. */
  const processOwner = () =>
    new OutsideDriverProcesses({
      supervisor: crashingSupervisor(launches),
      platform: "darwin",
      runtime: { kind: "bun", path: process.execPath },
      temporaryRoot,
      quarantine: crashHold,
    });
  const admission = new OutsideDriverAdmission({
    platform: options.platform ?? "darwin",
    packages: () => lifecycle.snapshot().packages,
    isCompatible: () => true,
    entry: (driver) =>
      store.verifiedDriverEntry(
        {
          extensionId: String(driver.extensionId),
          packageId: String(driver.packageId),
          version: String(driver.version),
          digest: String(driver.digest),
        },
        String(driver.componentId),
      ),
    processes:
      options.crashingDriver === true
        ? processOwner()
        : {
            start: async (input) => {
              starts.push(input);
              const channel = makeInMemoryOutsideDriverChannel();
              drivers.push({
                end: channel.driver,
                fixture: serveFixtureDriver(channel.driver, options.handlers),
              });
              return { status: "started", channel: channel.host };
            },
            stop: async (stopped) => {
              stops.push(String(stopped));
            },
          },
    runtimeRegistry: registry,
    limits: { callTimeoutMs: 2_000, sendTimeoutMs: 2_000 },
    clock: () => now,
  });
  stopPackage = (extensionId) => admission.stopPackage(extensionId);
  const providers = new ProviderService({
    persistence,
    runtimeRegistry: registry,
    isOutsideDriverAdmitted: (instance) => admission.isAdmitted(instance),
    outsideDriverRebindTarget: (instance) => admission.rebindTarget(instance),
    outsideDriverListings: () => admission.listings(),
    driver: (instance) =>
      makeConfiguredProviderDriver(instance, {
        openCodeProcess: { start: () => Effect.die("must not start OpenCode") },
        codexProcess: { start: () => Effect.die("must not start Codex") },
        runtimeRegistry: registry,
        permissionPersistence: () => "current-session",
        outsideDrivers: admission,
      }),
    uuid: randomUUID,
    clock: () => now,
  });
  quarantineOutsideDriver = (id, digest) => providers.quarantineOutsideDriver(id, digest);
  forgetPublisherVerification = (extensionId) =>
    providers.forgetOutsideDriverVerification(extensionId);
  // As the server wires it: a newly trusted digest moves its instances
  // first, then processes that no longer match stop.
  reconcile = async () => {
    await providers.rebindOutsideDrivers();
    await admission.reconcile(persistence.readProviderInstances());
    providers.reconcileConfiguredProviders();
  };

  const extension = async (command: ExtensionCommand): Promise<ExtensionCommandResult> => {
    const result = await extensions.execute(command);
    if (result.kind === "extension-command-failed") {
      throw new Error(`Extension command ${command.kind} failed: ${result.failure.message}`);
    }
    return result;
  };
  const inspect = async () => {
    const registered = await folders.register(driverRoot);
    const inspected = await extension({ kind: "inspect-package", source: registered.source });
    if (inspected.kind !== "package-inspected") throw new Error("expected an inspected driver");
    return inspected.preview.entry;
  };
  const install = async () => {
    const entry = await inspect();
    await extension({
      kind: "install-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    return entry;
  };
  const packageVersion = () => {
    const [state] = lifecycle.snapshot().packages;
    if (state === undefined) throw new Error("expected the installed driver");
    return state.stateVersion;
  };
  const mutate = (extensionId: string, change: Record<string, unknown>) =>
    extension({
      ...change,
      commandVersion: 1,
      extensionId,
      expectedStateVersion: packageVersion(),
    } as ExtensionCommand);
  const admit = async (extensionId: string) => {
    await mutate(extensionId, { kind: "set-source-trust", trusted: true });
    await mutate(extensionId, { kind: "set-plugin-desired", desired: true });
    await mutate(extensionId, {
      kind: "set-component-desired",
      componentId: "driver",
      desired: true,
    });
  };
  const addProvider = (entry: {
    extensionId: string;
    packageId: string;
    version: string;
    digest: string;
  }) =>
    providers.execute(windowId, {
      kind: "create-outside-harness-endpoint-provider",
      instanceId,
      expectedVersion: 0,
      displayName: "Loopback chat",
      configuration: {
        kind: "outside-harness-endpoint",
        driver: {
          extensionId: entry.extensionId,
          packageId: entry.packageId,
          componentId: "driver",
          version: entry.version,
          digest: entry.digest,
        },
        baseUrl: "http://127.0.0.1:11434",
        modelIds: ["local-model", "unreported-model"],
      },
    });
  const instance = (): ProviderInstance => {
    const current = persistence.readProviderInstance(instanceId);
    if (current === undefined) throw new Error("expected the outside provider");
    return current;
  };
  const turnOn = (enabled = true) =>
    providers.execute(windowId, {
      kind: "set-provider-enabled",
      instanceId,
      expectedVersion: instance().version,
      enabled,
    });
  const observed = async () =>
    (await providers.bootstrap(windowId)).observedStates.find(
      (state) => String(state.instanceId) === String(instanceId),
    );
  return {
    persistence,
    lifecycle,
    registry,
    providers,
    admission,
    launches,
    temporaryRoot,
    processOwner,
    starts,
    stops,
    drivers,
    driverRoot,
    inspect,
    install,
    admit,
    mutate,
    extension,
    addProvider,
    instance,
    turnOn,
    observed,
  };
}

describe("outside driver admission end to end", () => {
  it("adds a provider only from a trusted, switched-on driver, off, and starts its process only on a check", async () => {
    const context = await host();
    const entry = await context.install();

    // Installed but not admitted: nothing to list, and no provider can be added.
    expect((await context.providers.bootstrap(windowId)).outsideDrivers).toBeUndefined();
    await expect(context.addProvider(entry)).rejects.toThrow(/not available/);

    await context.admit(entry.extensionId);
    expect((await context.providers.bootstrap(windowId)).outsideDrivers).toEqual([
      {
        driver: {
          extensionId: entry.extensionId,
          packageId: entry.packageId,
          componentId: "driver",
          version: entry.version,
          digest: entry.digest,
        },
        displayName: "Loopback chat",
        source: "local-folder",
        installed: true,
        trusted: true,
      },
    ]);

    const created = await context.addProvider(entry);
    expect(created).toMatchObject({
      kind: "provider-created",
      instance: {
        driverKind: "outside-harness-endpoint",
        enabled: false,
        configuration: { driver: { digest: entry.digest }, baseUrl: "http://127.0.0.1:11434/" },
      },
    });
    await context.turnOn();
    await context.providers.warmEnabledProviders();
    // Adding, turning on, and the host's warm pass start nothing.
    expect(context.starts).toEqual([]);

    const checked = await context.providers.probe(windowId, instanceId);
    expect(checked).toMatchObject({ readiness: "ready" });
    // Only the listed models the driver also reported, each named by its id.
    expect(checked.models.map((model) => [String(model.id), model.displayName])).toEqual([
      ["local-model", "local-model"],
    ]);
    expect(context.starts).toHaveLength(1);
    expect(context.starts[0]).toMatchObject({ instanceId, driver: { digest: entry.digest } });
    expect(context.starts[0]?.entryPoint).toBe(
      join(context.starts[0]?.packageRoot ?? "", "dist/driver.mjs"),
    );
    await context.providers.probe(windowId, instanceId);
    // A second check uses the same process.
    expect(context.starts).toHaveLength(1);
  });

  it("verifies tools on the host through the driver, for listed and reported models only", async () => {
    const context = await host({
      handlers: {
        "session/send": (params) => {
          const request = params.request as { readonly tools: ReadonlyArray<{ name: string }> };
          // A model that takes the echo tool answers with a call to it.
          return request.tools.some((tool) => tool.name === "octant_capability_echo")
            ? { text: "", toolCalls: [echoToolCall] }
            : { text: "Hello", toolCalls: [] };
        },
      },
    });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);

    await expect(
      context.providers.verifyModelTools(windowId, instanceId, localModel),
    ).resolves.toBe("supported");
    // The host made the request: one session, the echo tool offered, its prompt.
    const sent = context.drivers[0]?.fixture.received.filter(
      (message) => message.method === "session/send",
    );
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).toContain("octant_capability_echo");
    expect((await context.observed())?.verifiedToolModelIds).toEqual([localModel]);
    // The record outlives the observation: it is in the catalogue for this instance.
    expect(context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds).toEqual([
      localModel,
    ]);

    // A model the person listed that the driver never reported is not offered.
    await expect(
      context.providers.verifyModelTools(
        windowId,
        instanceId,
        decodeProviderModelId("unreported-model"),
      ),
    ).rejects.toThrow(/only available for models this provider lists/);
  });

  it("records a model unverified when the driver's answer carries no echo call, whatever it claims", async () => {
    const context = await host({
      handlers: {
        "session/send": () => ({ text: "I can call tools, trust me.", toolCalls: [] }),
      },
    });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);

    await expect(
      context.providers.verifyModelTools(windowId, instanceId, localModel),
    ).resolves.toBe("unsupported");
    expect((await context.observed())?.verifiedToolModelIds ?? []).toEqual([]);
  });

  it("holds an update until the person trusts it, then moves the provider to the new digest and clears its records", async () => {
    const context = await host({
      handlers: { "session/send": () => ({ text: "", toolCalls: [echoToolCall] }) },
    });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);
    await context.providers.verifyModelTools(windowId, instanceId, localModel);

    // An update selects another digest: the package is held again and the
    // instance, still bound to the old digest, is blocked and its process
    // stopped. Nothing moves it until the person trusts the new version.
    await writeDriverFolder(context.driverRoot, "0.2.0");
    const updated = await context.inspect();
    expect(updated.digest).not.toBe(entry.digest);
    await context.extension({
      kind: "update-package",
      extensionId: entry.extensionId,
      packageId: updated.packageId,
      version: updated.version,
      digest: updated.digest,
    });
    expect(context.stops).toEqual([String(instanceId)]);
    expect(context.drivers[0]?.end.stopped()).toBe(true);
    expect(context.admission.activation(outside(context.instance()))).toEqual({
      kind: "blocked",
      reason: "superseded",
    });
    expect(await context.observed()).toMatchObject({
      readiness: "unavailable",
      models: [],
      reason: "driver-not-admitted",
    });
    await expect(context.providers.probe(windowId, instanceId)).rejects.toThrow(/not available/);
    await expect(
      context.providers.verifyModelTools(windowId, instanceId, localModel),
    ).rejects.toThrow(/not available/);
    expect(context.starts).toHaveLength(1);
    // Held, the instance keeps its binding and its records.
    const held = context.instance();
    expect(held).toMatchObject({
      enabled: true,
      configuration: { driver: { digest: entry.digest } },
    });
    expect(context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds).toEqual([
      localModel,
    ]);

    // Trusting the new version moves the instance to it, as a journaled
    // change, and clears what was learned at the old digest.
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    expect(context.instance()).toMatchObject({
      enabled: true,
      version: held.version + 1,
      configuration: {
        driver: { version: updated.version, digest: updated.digest },
        baseUrl: "http://127.0.0.1:11434/",
        modelIds: ["local-model", "unreported-model"],
      },
    });
    expect(context.persistence.readProviderCatalog?.(instanceId)).toMatchObject({
      invalidated: true,
    });
    expect(
      context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds,
    ).toBeUndefined();
    // The switches decide whether the new digest runs; until they are on, it does not.
    expect(await context.observed()).toMatchObject({ reason: "driver-not-admitted", models: [] });
    expect(context.starts).toHaveLength(1);

    await context.mutate(entry.extensionId, { kind: "set-plugin-desired", desired: true });
    const checked = await context.providers.probe(windowId, instanceId);
    expect(checked).toMatchObject({ readiness: "ready" });
    expect(checked.verifiedToolModelIds ?? []).toEqual([]);
    expect(context.starts).toHaveLength(2);
    expect(context.starts[1]).toMatchObject({
      instanceId,
      driver: { version: updated.version, digest: updated.digest },
    });

    // The pass a host start runs finds nothing left to move and journals nothing.
    const head = context.persistence.journal.headSequence();
    expect(await context.providers.rebindOutsideDrivers()).toEqual([]);
    expect(context.persistence.journal.headSequence()).toBe(head);

    // The journal holds the move: a rebuild from it reads back the same
    // provider and the same cleared catalogue.
    const moved = context.instance();
    const catalog = context.persistence.readProviderCatalog?.(instanceId);
    rebuildAll({
      connection: context.persistence.connection,
      journal: context.persistence.journal,
      projections: context.persistence.projections,
      clock: () => now,
    });
    expect(context.instance()).toEqual(moved);
    expect(context.persistence.readProviderCatalog?.(instanceId)).toEqual(catalog);
    expect(context.admission.activation(outside(context.instance()))).toEqual({
      kind: "effective",
    });
  });

  it("moves the provider back on a trusted rollback, and never on withdrawn trust", async () => {
    const context = await host();
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await writeDriverFolder(context.driverRoot, "0.2.0");
    const updated = await context.inspect();
    await context.extension({
      kind: "update-package",
      extensionId: entry.extensionId,
      packageId: updated.packageId,
      version: updated.version,
      digest: updated.digest,
    });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    expect(context.instance()).toMatchObject({
      configuration: { driver: { digest: updated.digest } },
    });

    await context.extension({
      kind: "rollback-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
      version: entry.version,
      digest: entry.digest,
    });
    // A rollback is held like an update: the instance stays where it is.
    expect(context.instance()).toMatchObject({
      configuration: { driver: { digest: updated.digest } },
    });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    expect(context.instance()).toMatchObject({
      configuration: { driver: { digest: entry.digest } },
    });
    const version = context.instance().version;
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: false });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    // Trusting the digest it already binds changes nothing.
    expect(context.instance().version).toBe(version);
  });

  it("stops the process when the plugin or the provider is turned off, and on uninstall, keeping the provider", async () => {
    const context = await host();
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);

    await context.mutate(entry.extensionId, { kind: "set-plugin-desired", desired: false });
    expect(context.stops).toEqual([String(instanceId)]);
    expect(await context.observed()).toMatchObject({ reason: "driver-not-admitted", models: [] });

    await context.mutate(entry.extensionId, { kind: "set-plugin-desired", desired: true });
    await context.providers.probe(windowId, instanceId);
    expect(context.starts).toHaveLength(2);
    await context.turnOn(false);
    expect(context.stops).toEqual([String(instanceId), String(instanceId)]);
    expect(context.drivers[1]?.end.stopped()).toBe(true);

    await context.turnOn();
    await context.providers.probe(windowId, instanceId);
    expect(context.starts).toHaveLength(3);
    await context.extension({
      kind: "uninstall-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
    });
    expect(context.stops).toHaveLength(3);
    expect(context.drivers[2]?.end.stopped()).toBe(true);
    expect(await context.observed()).toMatchObject({ reason: "driver-not-admitted", models: [] });
    expect(context.instance()).toMatchObject({ enabled: true });
  });

  it("journals a crash-loop hold once, keeps it across a restart, and lifts it only when another version is trusted", async () => {
    const context = await host();
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);
    const before = context.instance();

    // The process owner reports the crash loop and the host journals the
    // hold on the instance, at the digest that crashed.
    const head = context.persistence.journal.headSequence();
    await context.providers.quarantineOutsideDriver(
      instanceId,
      outside(before).configuration.driver.digest,
    );
    const held = context.instance();
    expect(held).toEqual({
      ...before,
      driverQuarantine: { reason: "crash-limit", digest: entry.digest, quarantinedAt: now },
      version: before.version + 1,
      updatedAt: now,
    });
    expect(context.persistence.journal.headSequence()).toBe(head + 1);
    // Settings sees the hold, with no models, and a check refuses before
    // any process starts.
    expect(await context.observed()).toMatchObject({
      readiness: "unavailable",
      reason: "runtime-unavailable",
      models: [],
      message: expect.stringMatching(/stopped too often/),
    });
    await expect(context.providers.probe(windowId, instanceId)).rejects.toThrow(
      /stopped too often/,
    );
    expect(context.starts).toHaveLength(1);

    // The same crash loop reported again journals nothing.
    await context.providers.quarantineOutsideDriver(
      instanceId,
      outside(held).configuration.driver.digest,
    );
    expect(context.persistence.journal.headSequence()).toBe(head + 1);

    // A restart forgets every observation and rebuilds from the journal; the
    // hold is still there and still reported.
    rebuildAll({
      connection: context.persistence.connection,
      journal: context.persistence.journal,
      projections: context.persistence.projections,
      clock: () => now,
    });
    context.registry.clearObservedState(instanceId);
    expect(context.instance()).toEqual(held);
    expect(await context.observed()).toMatchObject({ reason: "runtime-unavailable", models: [] });

    // Trusting the digest it already binds lifts nothing.
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: false });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    await context.mutate(entry.extensionId, { kind: "set-plugin-desired", desired: true });
    expect(context.instance()).toEqual(held);
    await expect(context.providers.probe(windowId, instanceId)).rejects.toThrow(
      /stopped too often/,
    );

    // Trusting another version moves the provider, and the hold stays with
    // the digest that crashed.
    await writeDriverFolder(context.driverRoot, "0.2.0");
    const updated = await context.inspect();
    await context.extension({
      kind: "update-package",
      extensionId: entry.extensionId,
      packageId: updated.packageId,
      version: updated.version,
      digest: updated.digest,
    });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    await context.mutate(entry.extensionId, { kind: "set-plugin-desired", desired: true });
    const moved = context.instance();
    expect(moved).toMatchObject({ configuration: { driver: { digest: updated.digest } } });
    expect(moved).not.toHaveProperty("driverQuarantine");
    expect(await context.providers.probe(windowId, instanceId)).toMatchObject({
      readiness: "ready",
    });
    expect(context.starts).toHaveLength(2);
    // A late report for the digest it no longer binds holds nothing.
    await context.providers.quarantineOutsideDriver(instanceId, entry.digest as never);
    expect(context.instance()).toEqual(moved);
  });

  it("journals the hold on the instance when its driver crashes on every start, and starts it no more, after a restart too", async () => {
    const context = await host({ crashingDriver: true });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    const head = context.persistence.journal.headSequence();

    // Two restarts a minute are allowed; the third crash crosses the limit.
    for (let check = 1; check <= 3; check += 1) {
      await expect(context.providers.probe(windowId, instanceId)).rejects.toThrow();
      expect(context.launches).toHaveLength(check);
    }
    await vi.waitFor(() =>
      expect(context.instance()).toMatchObject({
        driverQuarantine: { reason: "crash-limit", digest: entry.digest, quarantinedAt: now },
      }),
    );
    expect(
      context.persistence.journal
        .replay({ afterSequence: head as never, limit: 1_000 })
        .map((event) => event.eventName),
    ).toEqual(["provider.instance-driver-quarantined@1"]);
    expect(await context.observed()).toMatchObject({
      readiness: "unavailable",
      reason: "runtime-unavailable",
      models: [],
      message: expect.stringMatching(/stopped too often/),
    });
    await expect(context.providers.probe(windowId, instanceId)).rejects.toThrow(
      /stopped too often/,
    );
    expect(context.launches).toHaveLength(3);
    await vi.waitFor(async () => expect(await readdir(context.temporaryRoot)).toEqual([]));

    // A restarted host's process owner has seen no crash, and still refuses.
    const restarted = context.processOwner();
    expect(
      await restarted.start({
        instanceId,
        driver: outside(context.instance()).configuration.driver,
        packageRoot: context.driverRoot,
        entryPoint: join(context.driverRoot, "dist/driver.mjs"),
      }),
    ).toEqual({ status: "refused", reason: "quarantined" });
    expect(context.launches).toHaveLength(3);
  });

  it("admits nothing on a host that cannot confine a driver", async () => {
    const context = await host({ platform: "linux" });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    expect((await context.providers.bootstrap(windowId)).outsideDrivers).toBeUndefined();
    await expect(context.addProvider(entry)).rejects.toThrow(/not available/);
    expect(context.starts).toEqual([]);
  });
});

/** A throwaway Ed25519 key made for one test; it is never written to disk. */
function throwawayKey(): string {
  return generateKeyPairSync("ed25519")
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
}

describe("outside driver publisher signatures", () => {
  /** Writes the driver folder at `version` and signs it with `key`. */
  async function signedFolder(root: string, version: string, key: string) {
    await writeDriverFolder(root, version);
    return (await signOutsideDriverPackage({ root, privateKeyPem: key })).fingerprint;
  }

  function publisher(context: Awaited<ReturnType<typeof host>>) {
    const [state] = context.lifecycle.snapshot().packages;
    if (state === undefined) throw new Error("expected the driver package");
    return state.publisher;
  }

  it("holds an update signed by another key until the person re-trusts the new publisher, which clears Verify tools", async () => {
    const context = await host({
      handlers: { "session/send": () => ({ text: "", toolCalls: [echoToolCall] }) },
    });
    const firstKey = await signedFolder(context.driverRoot, "0.1.0", throwawayKey());
    const entry = await context.install();
    // Nothing is pinned before the person trusts it.
    expect(publisher(context)).toEqual({ selected: firstKey });
    await context.admit(entry.extensionId);
    expect(publisher(context)).toEqual({ pinned: firstKey, selected: firstKey });
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);
    await context.providers.verifyModelTools(windowId, instanceId, localModel);
    expect(context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds).toEqual([
      localModel,
    ]);

    const secondKey = await signedFolder(context.driverRoot, "0.2.0", throwawayKey());
    const updated = await context.inspect();
    await context.extension({
      kind: "update-package",
      extensionId: entry.extensionId,
      packageId: updated.packageId,
      version: updated.version,
      digest: updated.digest,
    });
    expect(publisher(context)).toEqual({
      pinned: firstKey,
      selected: secondKey,
      held: "publisher-changed",
    });
    // Trust alone does not take a new publisher.
    await expect(
      context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true }),
    ).rejects.toThrow(/set-source-trust failed/);
    // Nor does confirming a key other than the one that signed it.
    await expect(
      context.mutate(entry.extensionId, { kind: "trust-new-publisher", publisherKey: firstKey }),
    ).rejects.toThrow(/trust-new-publisher failed/);
    expect(context.instance().configuration).toMatchObject({ driver: { digest: entry.digest } });

    await context.mutate(entry.extensionId, {
      kind: "trust-new-publisher",
      publisherKey: secondKey,
    });
    expect(publisher(context)).toEqual({ pinned: secondKey, selected: secondKey });
    expect(
      context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds,
    ).toBeUndefined();
    // The package is still held for its digest: trusting it is the review step.
    const [held] = context.lifecycle.snapshot().packages;
    expect(held?.activation).toMatchObject({ trusted: false, quarantined: true });
    expect(context.instance().configuration).toMatchObject({ driver: { digest: entry.digest } });

    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    expect(context.instance().configuration).toMatchObject({
      driver: { version: updated.version, digest: updated.digest },
    });

    // The journal holds the pin: a rebuild from it reads back the same publisher state.
    const before = publisher(context);
    rebuildAll({
      connection: context.persistence.connection,
      journal: context.persistence.journal,
      projections: context.persistence.projections,
      clock: () => now,
    });
    expect(publisher(context)).toEqual(before);
  });

  it("keeps the pin through an uninstall, holds a reinstall by another key, and forgets it only when asked", async () => {
    const context = await host();
    const firstKey = await signedFolder(context.driverRoot, "0.1.0", throwawayKey());
    const entry = await context.install();
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    await context.extension({
      kind: "uninstall-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
    });

    const secondKey = await signedFolder(context.driverRoot, "0.1.0", throwawayKey());
    const reinstalled = await context.install();
    expect(reinstalled.extensionId).toBe(entry.extensionId);
    expect(publisher(context)).toEqual({
      pinned: firstKey,
      selected: secondKey,
      held: "publisher-changed",
    });

    // The pin outlives a rebuild from the journal as well.
    rebuildAll({
      connection: context.persistence.connection,
      journal: context.persistence.journal,
      projections: context.persistence.projections,
      clock: () => now,
    });
    expect(publisher(context)).toMatchObject({ pinned: firstKey, held: "publisher-changed" });

    await context.mutate(entry.extensionId, { kind: "forget-publisher", publisherKey: firstKey });
    expect(publisher(context)).toEqual({ selected: secondKey });
    // Forgetting admits nothing; the next trust pins the key that signed this version.
    expect(context.lifecycle.snapshot().packages[0]?.activation).toMatchObject({
      trusted: false,
      quarantined: true,
    });
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    expect(publisher(context)).toEqual({ pinned: secondKey, selected: secondKey });
  });

  it("forgets the pin of an uninstalled package, so a reinstall by another key is not held", async () => {
    const context = await host();
    const firstKey = await signedFolder(context.driverRoot, "0.1.0", throwawayKey());
    const entry = await context.install();
    await context.mutate(entry.extensionId, { kind: "set-source-trust", trusted: true });
    await context.extension({
      kind: "uninstall-package",
      extensionId: entry.extensionId,
      packageId: entry.packageId,
    });
    await context.mutate(entry.extensionId, { kind: "forget-publisher", publisherKey: firstKey });

    const secondKey = await signedFolder(context.driverRoot, "0.1.0", throwawayKey());
    await context.install();
    expect(publisher(context)).toEqual({ selected: secondKey });
  });
});

function outside(instance: ProviderInstance) {
  if (instance.driverKind !== "outside-harness-endpoint") {
    throw new Error("expected an outside provider");
  }
  return instance;
}
