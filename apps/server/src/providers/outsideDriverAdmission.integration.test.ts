import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeWindowId,
  type ProviderInstance,
} from "@octant/contracts";
import type { ExtensionCommand, ExtensionCommandResult } from "@octant/contracts/extension-rpc";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CodexPluginPackageResolver } from "../extensions/codexPluginResolver";
import { ExtensionApiService } from "../extensions/extensionApiService";
import {
  ExtensionLifecycleService,
  NOOP_EXTENSION_SUPERVISOR,
} from "../extensions/extensionLifecycleService";
import { ExtensionPackageStore } from "../extensions/extensionPackageStore";
import { LocalPluginFolderRegistry } from "../extensions/localPluginFolderRegistry";
import { Persistence, makePersistenceLive } from "../persistence/persistenceService";
import { makeConfiguredProviderDriver } from "../wiring/providers";
import { OutsideDriverAdmission } from "./outsideDriverAdmission";
import {
  makeInMemoryOutsideDriverChannel,
  serveFixtureDriver,
  type FixtureDriver,
  type FixtureDriverHandler,
  type InMemoryDriverEnd,
} from "./outsideDriverFixture.test-support";
import type { OutsideDriverProcessStartInput } from "./outsideDriverProcess";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { ProviderService } from "./providerService";

/**
 * Admission end to end on the server: a driver folder inspected, installed,
 * trusted, and switched on through the extension API; a provider added from
 * it, turned on, checked, and verified through the provider service and the
 * real driver factory; and the driver's process held to its instance. The
 * confined process itself is the macOS escape suite's; here each start is an
 * in-memory channel to the fixture driver, recorded so the test can see when
 * a process would start and stop.
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

async function host(
  options: {
    readonly platform?: string;
    readonly handlers?: Readonly<Record<string, FixtureDriverHandler>>;
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
    onStateChanged: async () => {
      await reconcile?.();
    },
  });

  const starts: Array<OutsideDriverProcessStartInput> = [];
  const stops: Array<string> = [];
  const drivers: Array<{ readonly end: InMemoryDriverEnd; readonly fixture: FixtureDriver }> = [];
  const registry = new ProviderRuntimeRegistry();
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
    processes: {
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
  reconcile = async () => {
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
    registry,
    providers,
    admission,
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

  it("blocks the instance at another digest, keeps it and its records, and stops its process", async () => {
    const context = await host({
      handlers: { "session/send": () => ({ text: "", toolCalls: [echoToolCall] }) },
    });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    await context.addProvider(entry);
    await context.turnOn();
    await context.providers.probe(windowId, instanceId);
    await context.providers.verifyModelTools(windowId, instanceId, localModel);

    // An update selects another digest: the package is held again, and even
    // once the person trusts and switches on the new version, the instance
    // bound to the old digest stays blocked.
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
    await context.admit(entry.extensionId);
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
    // The instance, its binding, and its catalogue stay until the person removes them.
    expect(context.instance()).toMatchObject({
      enabled: true,
      configuration: { driver: { digest: entry.digest } },
    });
    expect(context.persistence.readProviderCatalog?.(instanceId)?.verifiedToolModelIds).toEqual([
      localModel,
    ]);
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

  it("admits nothing on a host that cannot confine a driver", async () => {
    const context = await host({ platform: "linux" });
    const entry = await context.install();
    await context.admit(entry.extensionId);
    expect((await context.providers.bootstrap(windowId)).outsideDrivers).toBeUndefined();
    await expect(context.addProvider(entry)).rejects.toThrow(/not available/);
    expect(context.starts).toEqual([]);
  });
});

function outside(instance: ProviderInstance) {
  if (instance.driverKind !== "outside-harness-endpoint") {
    throw new Error("expected an outside provider");
  }
  return instance;
}
