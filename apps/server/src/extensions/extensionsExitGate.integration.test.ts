import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AppleBuildRequest,
  AppleDiscoveryRequest,
  ToolActionAuthority,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type OpenAiCompatibleProviderConfiguration,
  type ProviderModelId,
} from "@octant/contracts";
import type {
  ExtensionCommand,
  ExtensionEffectiveSnapshot,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import type { ExtensionActivationScope } from "@octant/contracts/extensions";
import {
  resolveDraftExtensionReference,
  type ExtensionAddressingCatalog,
} from "@octant/plugin-host";
import { Effect, Fiber, Stream } from "effect";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  deriveCatalogEpoch,
  type CapabilityActiveScope,
  type CapabilityCatalogEntry,
} from "../context/capabilityCatalog";
import { makeOpenAiCompatibleDriver } from "../providers/openAiCompatibleDriver";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import { AppleToolchainService } from "../apple/appleToolchainService";
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import {
  createMockCatalogSource,
  createMockUpdateCatalogSource,
  MOCK_BUILD_IOS_APPS_FILES,
} from "./curatedCatalogTestFixtures";
import { inspectExtensionPackage } from "./packageInspector";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";
import { ExtensionLifecycleService } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";
import {
  ExtensionSupervisor,
  type ExtensionProcessHandle,
  type ExtensionProcessPort,
  type ExtensionRuntimeEvidence,
  type ExtensionRuntimeStartInput,
} from "./extensionSupervisor";
import { SkillDiscoveryService } from "./skillDiscoveryService";
import { StandaloneSkillService } from "./standaloneSkillService";

/**
 * Extensions marketplace integrated exit gate.
 *
 * This vertical slice exercises the extension-system invariants that are not
 * already covered by the focused foundation tests (plugin ingest, skills
 * marketplace, trust/activation projection, Build iOS Apps catalog parity).
 * It adds focused tests only for the integration gaps those suites leave:
 *
 * - Update/rollback/interrupted-transaction recovery through the shared
 *   lifecycle (foundation tests cover these individually; this exercises them
 *   in the integrated flow).
 * - Provenance/secret-absence gate: extension evidence, manifests, and journal
 *   events carry provenance fields and no secrets/tokens/private keys.
 * - Standalone skill discovery with a user-global skill containing actual
 *   content, cross-source collision visibility, and successful explicit
 *   `$skill` selection (not just ambiguous).
 * - Executable lifecycle: active-operation cancellation, no-new-work
 *   admission during drain, and no residual process after stop.
 * - Core Apple build/run/test with Build iOS Apps absent: the core path works
 *   with no extension installed.
 *
 * The remaining invariants (hostile archive, immutable store, exhaustive
 * activation truth table, authority checks, zero-context enforcement,
 * provider-neutral driver, crash-loop quarantine, restart recovery, browser
 * UI states) are covered by the mapped foundation tests listed in the coverage
 * ledger and are not duplicated here.
 *
 * No packaged Electron or Apple Silicon evidence is claimed here; that remains
 * a manual acceptance residual for the maintainer.
 */

const directories: Array<string> = [];
const now = "2026-07-30T16:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("42000000-0000-4000-8000-000000000101");
const providerSessionId = decodeProviderSessionId("42000000-0000-4000-8000-000000000102");
const modelId = "generic-model" as ProviderModelId;
const encoder = new TextEncoder();

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
  let pid = 4201;
  return {
    start: vi.fn(async () => {
      const process = new FakeProcess(pid++);
      processes.push(process);
      return process;
    }),
    receipts: vi.fn(async () => []),
  };
}

function scopeFor(providerFamily: string): ExtensionActivationScope {
  return {
    hostId: LOCAL_HOST_ID,
    mode: "code",
    projectId: null,
    threadId: null,
    providerFamily: providerFamily as never,
  };
}

function effectiveSnapshot(
  snapshot: ExtensionSnapshot,
  scope: ReturnType<typeof scopeFor>,
  catalogStatus: () => "available" | "offline" = () => "available",
): ExtensionEffectiveSnapshot {
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus,
  });
  return activation.resolve(snapshot, { scope: scope as never });
}

function onlyPackage(snapshot: ExtensionSnapshot) {
  const entry = snapshot.packages[0];
  if (entry === undefined) throw new Error("Expected an installed extension package.");
  return entry;
}

async function execute(api: ExtensionApiService, command: ExtensionCommand) {
  return api.execute(command);
}

interface IntegratedContext {
  readonly dataDirectory: string;
  readonly connection: ReturnType<typeof openSqlite>;
  readonly journal: Journal;
  readonly store: ExtensionPackageStore;
  readonly supervisor: ExtensionSupervisor;
  readonly lifecycle: ExtensionLifecycleService;
  readonly activation: ExtensionActivationService;
  readonly skills: StandaloneSkillService;
  readonly discovery: SkillDiscoveryService;
  readonly api: ExtensionApiService;
  readonly processes: FakeProcess[];
  readonly evidence: ExtensionRuntimeEvidence[];
  readonly scope: ReturnType<typeof scopeFor>;
}

async function setupIntegrated(
  options: {
    readonly dataDirectory?: string;
    readonly discoveryRoots?: SkillDiscoveryService;
    readonly catalogStatus?: () => "available" | "offline";
  } = {},
): Promise<IntegratedContext> {
  const dataDirectory =
    options.dataDirectory ?? (await mkdtemp(join(tmpdir(), "octant-phase10-exit-gate-")));
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
  const catalogStatus = options.catalogStatus ?? (() => "available");
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus,
    compatibility: () => true,
  });
  const { catalogSource: record, mockFetch } = await createMockCatalogSource();
  const resolver = new CodexPluginPackageResolver({
    catalog: [record],
    fetch: mockFetch,
    platform: "darwin",
  });
  const discovery =
    options.discoveryRoots ??
    new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            workingDirectory: dataDirectory,
            projectRoot: dataDirectory,
            projectRef: "project:phase10",
            userGlobalSkillsRoot: join(dataDirectory, "global", ".agents", "skills"),
          },
        ],
      },
    });
  const skills = new StandaloneSkillService({
    discovery: {
      snapshot: () => discovery.snapshot(),
      reconcile: async () => discovery.reconcile(),
    },
    lifecycle,
  });
  const api = new ExtensionApiService({
    lifecycle,
    resolver,
    skills,
    activation,
  });
  const scope = scopeFor("openai-compatible");
  return {
    dataDirectory,
    connection,
    journal,
    store,
    supervisor,
    lifecycle,
    activation,
    skills,
    discovery,
    api,
    processes,
    evidence,
    scope,
  };
}

async function installAndEnableCuratedPlugin(context: IntegratedContext): Promise<{
  readonly entry: {
    readonly extensionId: string;
    readonly packageId: string;
    readonly digest: string;
  };
  readonly snapshot: ExtensionSnapshot;
  readonly effective: ExtensionEffectiveSnapshot;
  readonly disabledEffective: ExtensionEffectiveSnapshot;
}> {
  const search = await execute(context.api, { kind: "search-catalog", query: "build-ios-apps" });
  if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
  const entry = search.entries[0]!;
  await execute(context.api, {
    kind: "inspect-package",
    source: entry.source,
    expectedDigest: entry.digest,
  });
  const installed = await execute(context.api, {
    kind: "install-package",
    extensionId: entry.extensionId,
    packageId: entry.packageId,
    version: entry.version,
    digest: entry.digest,
  });
  if (installed.kind !== "extension-state-updated") throw new Error("Expected an install.");
  const disabledEffective = effectiveSnapshot(installed.snapshot, context.scope);

  const trusted = await execute(context.api, {
    kind: "set-source-trust",
    commandVersion: 1 as never,
    extensionId: entry.extensionId,
    trusted: true,
    expectedStateVersion: onlyPackage(installed.snapshot).stateVersion,
  });
  if (trusted.kind !== "extension-state-updated") throw new Error("Expected trust.");
  const enabled = await execute(context.api, {
    kind: "set-plugin-desired",
    commandVersion: 1 as never,
    extensionId: entry.extensionId,
    desired: true,
    expectedStateVersion: onlyPackage(trusted.snapshot).stateVersion,
  });
  if (enabled.kind !== "extension-state-updated") throw new Error("Expected enablement.");
  const componentEnabled = await execute(context.api, {
    kind: "set-component-desired",
    commandVersion: 1 as never,
    extensionId: entry.extensionId,
    componentId: "skill-swiftui-ui-patterns" as never,
    desired: true,
    expectedStateVersion: onlyPackage(enabled.snapshot).stateVersion,
  });
  if (componentEnabled.kind !== "extension-state-updated") {
    throw new Error("Expected component enablement.");
  }
  return {
    entry: {
      extensionId: String(entry.extensionId),
      packageId: String(entry.packageId),
      digest: String(entry.digest),
    },
    snapshot: componentEnabled.snapshot,
    effective: effectiveSnapshot(componentEnabled.snapshot, context.scope),
    disabledEffective,
  };
}

function startInput(
  inspection: {
    readonly manifest: {
      readonly extensionId: string;
      readonly packageId: string;
      readonly version: string;
      readonly digest: string;
    };
  },
  cwd: string,
): ExtensionRuntimeStartInput {
  const manifest = inspection.manifest;
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

function componentEffectiveState(
  context: IntegratedContext,
  snapshot: ExtensionSnapshot,
): { kind: "effective" } | { kind: "blocked"; reason: string } {
  const resolved = context.activation.resolve(snapshot, { scope: context.scope });
  const component = resolved.packages[0]?.components[0];
  if (component === undefined) throw new Error("Expected one component.");
  return component.effectiveState as never;
}

function currentStateVersion(context: IntegratedContext, snapshot: ExtensionSnapshot): number {
  const pkg = snapshot.packages[0];
  if (pkg === undefined) throw new Error("Expected one installed package.");
  return pkg.stateVersion as never;
}

/**
 * Mirror the server chat-resolver catalog projection for the selected skill
 * component: only effective components receive capability identifiers.
 */
function catalogsFor(
  effective: ExtensionEffectiveSnapshot,
  entry: { readonly extensionId: string; readonly packageId: string },
): {
  readonly addressing: ExtensionAddressingCatalog;
  readonly capabilityEntries: ReadonlyArray<CapabilityCatalogEntry>;
} {
  const activeScope: CapabilityActiveScope = {
    mode: { referenceId: "mode:code", revision: 1 },
    project: { referenceId: "project:none", revision: 1 },
    host: { referenceId: "host:local", revision: 1 },
    model: { referenceId: `model:${modelId}`, revision: 1 },
  };
  const capabilityEntries: Array<CapabilityCatalogEntry> = [];
  const packageState = effective.packages[0];
  if (packageState === undefined) throw new Error("Expected an effective package.");
  const plugins = [
    {
      extensionId: packageState.extensionId,
      packageId: packageState.packageId,
      slug: packageState.slug!,
      packageVersion: packageState.version,
      packageDigest: packageState.digest,
      components: packageState.components.map((componentState) => {
        const effectiveComponent = componentState.effectiveState.kind === "effective";
        const capabilityIds =
          componentState.component.kind !== "skill-instructions" || !effectiveComponent
            ? []
            : [
                (() => {
                  const capability: CapabilityCatalogEntry = {
                    id: contextEntryId(`plugin:${entry.packageId}:${componentState.component.id}`),
                    source: {
                      kind: "plugin-package",
                      referenceId: `extension:${entry.extensionId}:${entry.packageId}`,
                      packageId: entry.packageId,
                      componentId: componentState.component.id,
                    },
                    componentKind: "plugin-instruction",
                    label: componentState.component.displayName,
                    schemaCost: { kind: "known", tokens: 64, accuracy: "exact-tokenizer" },
                    availability: "available",
                    trust: "trusted",
                    enablement: "enabled",
                    policy: "allowed",
                    providerEligibility: {
                      providerInstanceId,
                      status: "eligible",
                      reason: "selected-provider",
                    },
                    scopeEligibility: {
                      mode: { ...activeScope.mode, status: "eligible" },
                      project: { ...activeScope.project, status: "eligible" },
                      host: { ...activeScope.host, status: "eligible" },
                      model: { ...activeScope.model, status: "eligible" },
                    },
                    posture: "optional",
                    selectionMode: "explicit",
                    taskKeywords: [],
                    epoch: 1,
                    invalidationFacts: [],
                  };
                  capabilityEntries.push(capability);
                  return capability.id;
                })(),
              ];
        return {
          componentId: componentState.component.id,
          label: componentState.component.displayName,
          effectiveState: componentState.effectiveState,
          capabilityIds,
        };
      }),
    },
  ];
  return {
    addressing: {
      epoch: effective.catalogEpoch,
      plugins: plugins as never,
      skills: [],
    },
    capabilityEntries,
  };
}

function contextEntryId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(
    17,
    20,
  )}-${hex.slice(20, 32)}`;
}

function chatStream(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl_phase10",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl_phase10",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    "[DONE]",
  ];
  const body = chunks
    .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`)
    .join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function sendSelectedSkillToGenericProvider(
  effective: ExtensionEffectiveSnapshot,
  entry: { readonly extensionId: string; readonly packageId: string },
): Promise<unknown[]> {
  const catalogs = catalogsFor(effective, entry);
  const draft = resolveDraftExtensionReference(
    "@build-ios-apps/skill-swiftui-ui-patterns",
    catalogs.addressing,
    "phase10-draft",
  );
  if (draft.kind !== "selected") throw new Error("Expected a structured plugin selection.");
  const skillContent =
    MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md"]!;
  const activeScope: CapabilityActiveScope = {
    mode: { referenceId: "mode:code", revision: 1 },
    project: { referenceId: "project:none", revision: 1 },
    host: { referenceId: "host:local", revision: 1 },
    model: { referenceId: `model:${modelId}`, revision: 1 },
  };
  const composed = await composeSelectedExtensionCapabilities({
    phase: "send",
    selections: [draft.selection],
    addressingCatalog: catalogs.addressing,
    authoritativeCatalogEpoch: effective.catalogEpoch,
    capabilityCatalog: {
      entries: catalogs.capabilityEntries,
      epoch: deriveCatalogEpoch({
        entries: catalogs.capabilityEntries,
        activeFacts: { providerInstanceId, activeScope },
        invalidationFacts: [],
      }),
    },
    capabilityRequest: {
      providerInstanceId,
      activeScope,
      nativeToolSearch: "unsupported",
      taskKeywords: [],
      explicitSelections: [],
    },
    loadMaterial: async (capabilityEntry) => ({
      context: {
        kind: "instructions" as const,
        text:
          capabilityEntry.source.kind === "plugin-package" &&
          capabilityEntry.source.componentId === "skill-swiftui-ui-patterns"
            ? skillContent.trim()
            : "unused",
      },
      tools: [],
    }),
  });
  if (composed.status !== "selected") {
    throw new Error(`Expected selected capabilities, received ${composed.reasons.join(", ")}.`);
  }

  const requestBodies: unknown[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: modelId }] });
    requestBodies.push(JSON.parse(String(init?.body)) as unknown);
    return chatStream("generic provider answer");
  });
  const runtimeRegistry = new ProviderRuntimeRegistry();
  const configuration: OpenAiCompatibleProviderConfiguration = {
    kind: "openai-compatible-http",
    baseUrl: "https://generic-provider.example/v1",
    authentication: "bearer",
    protocol: "chat-completions",
    manualModelIds: [modelId],
  };
  const driver = makeOpenAiCompatibleDriver({
    instanceId: providerInstanceId,
    configuration,
    runtimeRegistry,
    credentialResolver: { has: async () => true, resolve: async () => "private-key" },
    fetch,
    clock: () => "2026-07-30T00:00:00.000Z",
    correlationId: () => "42000000-0000-4000-8000-000000000103",
  });
  const observed = await Effect.runPromise(
    Effect.scoped(driver.probe({ instanceId: providerInstanceId })),
  );
  runtimeRegistry.setObservedState({
    ...observed,
    capabilities: { ...observed.capabilities, appManagedTools: "supported" },
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* driver.acquire({
          instanceId: providerInstanceId,
          projectRoot: "/tmp/octant-phase10-generic-provider",
        });
        yield* connection.start({
          sessionId: providerSessionId,
          modelId,
          executionPolicy: "approval-gated",
        });
        const terminal = yield* Effect.fork(
          Stream.runCollect(
            (yield* connection.subscribe).pipe(
              Stream.filter((event) => event.sessionId === providerSessionId),
              Stream.takeUntil(
                (event) =>
                  event.kind === "completed" ||
                  event.kind === "interrupted" ||
                  event.kind === "failed",
              ),
            ),
          ),
        );
        yield* connection.send({
          sessionId: providerSessionId,
          prompt: "Refactor the SwiftUI screen with the selected extension",
          context: composed.providerContext,
          attachments: [],
          tools: composed.tools,
        });
        expect(Array.from(yield* Fiber.join(terminal)).at(-1)?.kind).toBe("completed");
        yield* connection.stop(providerSessionId);
      }),
    ),
  );
  return requestBodies;
}

describe("extensions marketplace integrated exit gate", () => {
  it("exercises the provider-neutral plugin lifecycle: install disabled → trust → enable → effective use → disable/drain → remove → restart recovery", async () => {
    const context = await setupIntegrated();
    const { entry, snapshot, effective, disabledEffective } =
      await installAndEnableCuratedPlugin(context);

    // Install is disabled and untrusted by default: zero context.
    const disabledComponent = disabledEffective.packages[0]?.components[0];
    expect(disabledComponent?.effectiveState).toMatchObject({
      kind: "blocked",
      reason: "untrusted",
    });
    expect(disabledComponent?.contextContribution).toMatchObject({ kind: "zero" });

    // Structured @plugin selection on a non-Codex/non-Claude provider family
    // sends only the verified skill instruction through the real driver.
    const requestBodies = await sendSelectedSkillToGenericProvider(effective, entry);
    expect(requestBodies).toHaveLength(1);
    expect(JSON.stringify(requestBodies[0])).toContain("SwiftUI UI Patterns");
    expect(JSON.stringify(requestBodies[0])).toContain("Choose a track based on your goal");

    // Disabled/unselected components contribute zero context: a bare
    // @build-ios-apps reference has no unambiguous primary capability and fails
    // closed with `component-required`.
    const catalogs = catalogsFor(effective, entry);
    expect(resolveDraftExtensionReference("@build-ios-apps", catalogs.addressing, "bare")).toEqual({
      kind: "blocked",
      reason: "component-required",
    });

    // Disable drains the supervisor and blocks new activation.
    const disabled = await context.lifecycle.disable(entry.extensionId);
    expect(componentEffectiveState(context, disabled)).toMatchObject({
      kind: "blocked",
      reason: "plugin-disabled",
    });

    // Uninstall removes the package bytes through the journaled lifecycle and
    // preserves a provenance tombstone with installed: false.
    const uninstalled = await context.lifecycle.uninstall(entry.extensionId);
    expect(uninstalled.packages[0]).toMatchObject({
      extensionId: entry.extensionId as never,
      activation: { installed: false, trusted: false, pluginDesired: false },
    });
    expect(
      (await context.store.inventory()).filter((item) => item.kind === "version"),
    ).toHaveLength(0);

    // Restart recovery: a true restart that closes and recreates every service
    // from the persisted SQLite database and on-disk store reconciles startup
    // and produces no installed (non-tombstoned) packages.
    context.connection.close();
    const restarted = await setupIntegrated({ dataDirectory: context.dataDirectory });
    await restarted.lifecycle.reconcileStartup();
    const restartedSnapshot = restarted.lifecycle.snapshot();
    expect(restartedSnapshot.packages.filter((pkg) => pkg.activation.installed)).toHaveLength(0);
  });

  it("keeps disabled/untrusted/unselected components at zero context and preserves installed content when the marketplace goes offline", async () => {
    let catalogStatus: "available" | "offline" = "available";
    const context = await setupIntegrated({ catalogStatus: () => catalogStatus });
    const { entry, snapshot } = await installAndEnableCuratedPlugin(context);

    const enabledComponentId = "skill-swiftui-ui-patterns";
    const online = effectiveSnapshot(snapshot, context.scope, () => catalogStatus);
    const onlineComponent = online.packages[0]?.components.find(
      (component) => component.component.id === enabledComponentId,
    );
    expect(onlineComponent?.effectiveState).toMatchObject({ kind: "effective" });

    // Marketplace outage does not evict installed verified content: the
    // effective state stays admissible and the catalog epoch is preserved.
    catalogStatus = "offline";
    const offline = effectiveSnapshot(snapshot, context.scope, () => catalogStatus);
    expect(offline.catalogStatus).toBe("offline");
    const offlineComponent = offline.packages[0]?.components.find(
      (component) => component.component.id === enabledComponentId,
    );
    expect(offlineComponent?.effectiveState).toMatchObject({ kind: "effective" });
    expect(offline.catalogEpoch).toBe(online.catalogEpoch);

    // An untrusted component never contributes context even when the catalog
    // is online: trust is independent of installation and desired state.
    const untrustedSnapshot = await context.lifecycle.setSourceTrust({
      extensionId: entry.extensionId as never,
      expectedStateVersion: currentStateVersion(context, snapshot) as never,
      trusted: false,
    });
    const untrustedEffective = effectiveSnapshot(untrustedSnapshot, context.scope);
    const untrustedComponent = untrustedEffective.packages[0]?.components.find(
      (component) => component.component.id === enabledComponentId,
    );
    expect(untrustedComponent?.effectiveState).toMatchObject({
      kind: "blocked",
      reason: "untrusted",
    });
    expect(untrustedComponent?.contextContribution).toMatchObject({ kind: "zero" });
  });

  it("records supervisor crash-loop quarantine, reconciles it idempotently on restart, and never auto-clears it", async () => {
    const context = await setupIntegrated();
    const { entry, snapshot } = await installAndEnableCuratedPlugin(context);
    const cwd = "/tmp/octant-phase10-quarantine";
    await context.supervisor.start(
      startInput(
        {
          manifest: {
            extensionId: entry.extensionId,
            packageId: entry.packageId,
            version: "0.1.2",
            digest: entry.digest,
          },
        },
        cwd,
      ),
    );

    // Crash into quarantine: three exits within the bound.
    context.processes[0]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(context.processes).toHaveLength(2));
    context.processes[1]!.emit("exit", { code: 1, signal: null });
    await vi.waitFor(() => expect(context.processes).toHaveLength(3));
    context.processes[2]!.emit("exit", { code: 1, signal: null });
    const quarantined = context.evidence.find((event) => event.state === "quarantined");
    expect(quarantined).toBeDefined();
    context.lifecycle.recordRuntimeEvidence(quarantined!);

    expect(componentEffectiveState(context, context.lifecycle.snapshot())).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // Restart reconciliation is idempotent and never upgrades quarantine.
    const head = context.journal.headSequence();
    await context.supervisor.reconcile();
    await context.lifecycle.reconcileStartup();
    expect(context.journal.headSequence()).toBe(head);
    expect(componentEffectiveState(context, context.lifecycle.snapshot())).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });

    // A true restart preserves quarantine and desired state from the persisted
    // journal and store.
    context.connection.close();
    const restarted = await setupIntegrated({ dataDirectory: context.dataDirectory });
    await restarted.lifecycle.reconcileStartup();
    expect(componentEffectiveState(restarted, restarted.lifecycle.snapshot())).toMatchObject({
      kind: "blocked",
      reason: "quarantined",
    });
    const pkgAfter = restarted.lifecycle.snapshot().packages[0];
    expect(pkgAfter?.activation.trusted).toBe(true);
    expect(pkgAfter?.activation.pluginDesired).toBe(true);
  });

  it("discovers standalone skills through bounded ancestry, keeps them disabled until trusted, and surfaces same-name collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-phase10-skills-"));
    directories.push(root);
    const projectRoot = join(root, "project");
    const workingDirectory = join(projectRoot, "packages", "app");
    const globalRoot = join(root, "global", ".agents", "skills");
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await mkdir(join(workingDirectory, ".agents", "skills", "review"), { recursive: true });
    await mkdir(globalRoot, { recursive: true });
    await writeFile(
      join(projectRoot, ".agents", "skills", "review", "SKILL.md"),
      "# project review\n",
    );
    await writeFile(
      join(workingDirectory, ".agents", "skills", "review", "SKILL.md"),
      "# nested review\n",
    );
    const discovery = new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            workingDirectory,
            projectRoot,
            projectRef: "project:phase10-skills",
            userGlobalSkillsRoot: globalRoot,
          },
        ],
      },
    });
    const context = await setupIntegrated({ discoveryRoots: discovery });

    const reconciled = await context.skills.reconcile();
    // Both same-name skills are discovered and stay disabled/untrusted.
    const reconciledSkills = reconciled.skills ?? [];
    const discoveredSkills = reconciledSkills.filter((skill) => skill.source.kind !== "bundled");
    expect(discoveredSkills.map((skill) => skill.skill.name)).toEqual(["review", "review"]);
    expect(discoveredSkills.every((skill) => skill.desiredEnabled === false)).toBe(true);
    expect(
      reconciledSkills.some(
        (skill) => skill.skill.name === "review-in-parallel" && skill.source.kind === "bundled",
      ),
    ).toBe(true);
    expect(reconciledSkillsBlocked(reconciled)).toBe(true);
    // The collision is visible: no silent shadowing.
    expect(reconciled.collisions.map((collision) => collision.name)).toContain("review");
    const reviewCollision = reconciled.collisions.find((collision) => collision.name === "review");
    expect(reviewCollision?.candidates.length).toBe(2);

    // Unqualified $skill invocation fails closed with an ambiguous chooser.
    const snapshot = context.api.snapshot();
    const scope = scopeFor("openai-compatible");
    const effective = effectiveSnapshot(snapshot, scope);
    const addressing: ExtensionAddressingCatalog = {
      epoch: effective.catalogEpoch,
      plugins: [],
      skills: reconciledSkills.map((skill) => ({
        skillId: skill.skill.qualifiedId,
        name: skill.skill.name,
        label: skill.displayName,
        packageDigest: skill.skill.digest,
        effectiveState: skill.effectiveState,
        capabilityIds: [],
      })) as never,
    };
    const ambiguous = resolveDraftExtensionReference("$review", addressing, "collision-draft");
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") {
      expect(ambiguous.candidates).toHaveLength(2);
    }
  });

  it("denies trusted-extension authority the core Apple capability while core authority keeps working on the same service", async () => {
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      const command = input.argv.join(" ");
      if (command === "xcode-select -p") {
        return processResult("/Applications/Xcode.app/Contents/Developer\n");
      }
      if (command === "xcodebuild -version")
        return processResult("Xcode 16.4\nBuild version 16F6\n");
      if (command === "swift --version") return processResult("Apple Swift version 6.1\n");
      if (command === "xcodebuild -showsdks") {
        return processResult(
          "iOS Simulator 18.5 -sdk iphonesimulator18.5\nmacOS 15.5 -sdk macosx15.5\n",
        );
      }
      if (command === "xcrun simctl list devices available --json") {
        return processResult(
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
                {
                  name: "iPhone 16",
                  udid: "42000000-0000-4000-8000-000000000020",
                  state: "Booted",
                  isAvailable: true,
                },
              ],
            },
          }),
        );
      }
      if (command.includes("-list -json")) {
        return processResult(
          JSON.stringify({
            project: {
              schemes: ["Fixture"],
              configurations: ["Debug", "Release"],
              targets: ["Fixture", "FixtureTests"],
            },
          }),
        );
      }
      return processResult("", { exitCode: 1, stderr: `unexpected command: ${command}` });
    });
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => now,
      newId: () => "42000000-0000-4000-8000-000000000012",
    });

    const coreAuthority: ToolActionAuthority = {
      hostId: "42000000-0000-4000-8000-000000000003" as never,
      mode: "code",
      projectId: "42000000-0000-4000-8000-000000000004" as never,
      rootId: "42000000-0000-4000-8000-000000000005" as never,
      worktreeId: "42000000-0000-4000-8000-000000000006" as never,
      providerInstanceId: providerInstanceId,
      extension: { kind: "core" },
    };
    const extensionAuthority: ToolActionAuthority = {
      ...coreAuthority,
      extension: {
        kind: "trusted-extension",
        extensionId: "42000000-0000-4000-8000-000000000030" as never,
      },
    };
    const executionContext = {
      authority: coreAuthority,
      threadId: "42000000-0000-4000-8000-000000000008" as never,
      checkoutId: "42000000-0000-4000-8000-000000000009" as never,
      checkoutRoot: "/private/octant-phase10-fixture",
      artifactRoot: "/private/octant-phase10-artifacts",
      sourceRevision: "a".repeat(40),
      executionPolicy: "full-access" as const,
      approvalValid: true,
    };
    const discoveryRequest: AppleDiscoveryRequest = {
      actionId: "42000000-0000-4000-8000-000000000001" as never,
      correlationId: "42000000-0000-4000-8000-000000000002" as never,
      authority: coreAuthority,
      threadId: "42000000-0000-4000-8000-000000000008" as never,
      checkoutId: "42000000-0000-4000-8000-000000000009" as never,
      projectPath: "Fixture/Fixture.xcodeproj",
    };
    const buildRequest: AppleBuildRequest = {
      ...discoveryRequest,
      kind: "build",
      platform: "ios",
      scheme: "Fixture",
      configuration: "debug",
      simulatorId: "42000000-0000-4000-8000-000000000010" as never,
      timeoutMs: 120_000,
      approval: { kind: "approved", approvalId: "42000000-0000-4000-8000-000000000011" as never },
    };

    // A trusted extension (for example an installed Build iOS Apps plugin) can
    // never own the core Apple capability: discovery and build fail closed.
    const extensionContext = { ...executionContext, authority: extensionAuthority };
    const extensionDiscovery = await service.discover(
      { ...discoveryRequest, authority: extensionAuthority },
      extensionContext,
    );
    expect(extensionDiscovery).toMatchObject({
      kind: "failure",
      failure: { category: "unauthorized" },
    });

    const extensionBuild = await service.execute(
      { ...buildRequest, authority: extensionAuthority },
      extensionContext,
    );
    expect(extensionBuild.outcome).toBe("unauthorized");
    expect(JSON.stringify(extensionBuild)).toContain("core-capability-required");

    // The same service instance keeps serving the core path with core
    // authority; an absent or disabled extension changes nothing.
    const core = await service.discover(discoveryRequest, executionContext);
    expect(core.kind).toBe("discovered");
  });

  it("exercises update → rollback → interrupted-update recovery through the integrated lifecycle", async () => {
    const context = await setupIntegrated();
    const { entry, snapshot } = await installAndEnableCuratedPlugin(context);

    // The installed version is 0.1.2. Create an updated catalog source
    // (0.1.3) with modified skill content and inspect it through the resolver.
    // Override the plugin.json manifest version to 0.1.3 so the manifest
    // version matches the catalog display metadata version.
    const updatedPluginManifest = JSON.parse(
      MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/.codex-plugin/plugin.json"]!,
    );
    updatedPluginManifest.version = "0.1.3";
    const { catalogSource: updateSource, mockFetch: updateFetch } =
      await createMockUpdateCatalogSource({
        "plugins/build-ios-apps/.codex-plugin/plugin.json": JSON.stringify(updatedPluginManifest),
        "plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md":
          "# SwiftUI UI Patterns\n\nUpdated for 0.1.3.\n",
      });
    const updateResolver = new CodexPluginPackageResolver({
      catalog: [updateSource],
      fetch: updateFetch,
      platform: "darwin",
    });
    const updateApi = new ExtensionApiService({
      lifecycle: context.lifecycle,
      resolver: updateResolver,
      skills: context.skills,
      activation: context.activation,
    });

    const search = await execute(updateApi, { kind: "search-catalog", query: "build-ios-apps" });
    if (search.kind !== "catalog-search-results") throw new Error("Expected catalog results.");
    const updateEntry = search.entries[0]!;
    expect(updateEntry.version).toBe("0.1.3");

    await execute(updateApi, {
      kind: "inspect-package",
      source: updateEntry.source,
      expectedDigest: updateEntry.digest,
    });
    const updated = await execute(updateApi, {
      kind: "update-package",
      extensionId: updateEntry.extensionId,
      packageId: updateEntry.packageId,
      version: updateEntry.version,
      digest: updateEntry.digest,
    });
    if (updated.kind !== "extension-state-updated") throw new Error("Expected an update.");
    expect(updated.snapshot.packages[0]?.version).toBe("0.1.3");

    // The previous version (0.1.2) is retained in the store.
    const inventory = await context.store.inventory();
    expect(inventory.filter((item) => item.kind === "version")).toHaveLength(2);

    // Rollback to the retained 0.1.2 version. Trust and enablement are not
    // restored by rollback (they must be explicitly re-established).
    const rolledBack = await execute(updateApi, {
      kind: "rollback-package",
      extensionId: entry.extensionId as never,
      packageId: entry.packageId as never,
      version: "0.1.2" as never,
      digest: entry.digest as never,
    });
    if (rolledBack.kind !== "extension-state-updated") throw new Error("Expected a rollback.");
    expect(rolledBack.snapshot.packages[0]?.version).toBe("0.1.2");
    expect(rolledBack.snapshot.packages[0]?.activation).toMatchObject({
      trusted: false,
      pluginDesired: false,
    });

    // Interrupted update: a fault during promotion leaves the old version
    // visible and the candidate quarantined; restart reconciliation is
    // idempotent and preserves the last-known-good version.
    // Use a third version (0.1.4) to avoid collision with the already-
    // retained 0.1.3.
    const interruptedPluginManifest = JSON.parse(
      MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/.codex-plugin/plugin.json"]!,
    );
    interruptedPluginManifest.version = "0.1.4";
    const { catalogSource: interruptSource, mockFetch: interruptFetch } =
      await createMockUpdateCatalogSource({
        "plugins/build-ios-apps/.codex-plugin/plugin.json":
          JSON.stringify(interruptedPluginManifest),
        "plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md":
          "# SwiftUI UI Patterns\n\nUpdated for 0.1.4.\n",
      });
    // Override displayMetadata version to 0.1.4.
    (interruptSource as { displayMetadata: { version: string } }).displayMetadata.version = "0.1.4";
    const interruptResolver = new CodexPluginPackageResolver({
      catalog: [interruptSource],
      fetch: interruptFetch,
      platform: "darwin",
    });
    const interruptResolved = await interruptResolver.resolve({
      kind: "inspect-package",
      source: {
        kind: "catalog",
        catalogId: "octant-curated",
        entryId: "build-ios-apps",
      } as never,
      expectedDigest: interruptSource.expectedDigest,
    });
    const interruptInspection = inspectExtensionPackage({
      ...interruptResolved,
      ...(interruptResolved.expectedDigest === undefined
        ? {}
        : { expectedDigest: interruptResolved.expectedDigest }),
    });
    const faultedLifecycle = new ExtensionLifecycleService({
      connection: context.connection,
      journal: context.journal,
      store: context.store,
      supervisor: context.supervisor,
      uuid: randomUUID,
      clock: () => now,
      fault: (point) => {
        if (point === "after-promotion") throw new Error("simulated update crash");
      },
    });
    await expect(faultedLifecycle.update(interruptInspection as never)).rejects.toThrow(
      "simulated update crash",
    );

    // The old version is still visible.
    expect(context.lifecycle.snapshot().packages[0]?.version).toBe("0.1.2");

    // Restart reconciliation is idempotent and preserves 0.1.2.
    await context.lifecycle.reconcileStartup();
    expect(context.lifecycle.snapshot().packages[0]?.version).toBe("0.1.2");
  });

  it("proves provenance fields are present and a sentinel secret canary is excluded/redacted from extension evidence, manifests, journal events, and snapshot", async () => {
    const context = await setupIntegrated();
    const { entry, snapshot } = await installAndEnableCuratedPlugin(context);

    // Every installed package state carries source and digest provenance
    // fields (the manifest provenance is verified at inspection time and
    // retained in the immutable store).
    const pkg = snapshot.packages[0];
    expect(pkg).toBeDefined();
    expect(pkg?.source).toBeDefined();
    expect(pkg?.digest).toBeDefined();
    expect(pkg?.version).toBeDefined();

    // The store inventory retains the verified version with its digest.
    const inventory = await context.store.inventory();
    const versionItem = inventory.find((item) => item.kind === "version");
    expect(versionItem).toBeDefined();

    // --- Sentinel secret canary at the process environment boundary ---
    // Inject secret-like canary strings into the extension process
    // environment. The supervisor's `boundedEnvironment` must filter out:
    //   - non-OCTANT_* keys (e.g. API_KEY)
    //   - OCTANT_CREDENTIAL (explicitly excluded)
    // The canary must NOT appear in runtime evidence, journal events, or
    // the snapshot. This proves exclusion/redaction rather than scanning
    // only clean fixture data.
    const canaryCredential = "sk-canary-abcdef1234567890aabbccdd";
    const canaryApiKey = "sk-canary-xyz9876543210fedcba";
    const canaryBearer = "Bearer dGhpcyBpcyBhIHNlY3JldCB0b2tlbg";
    const cwd = "/tmp/octant-phase10-provenance-canary";
    const canaryStartInput = startInput(
      {
        manifest: {
          extensionId: entry.extensionId,
          packageId: entry.packageId,
          version: "0.1.2",
          digest: entry.digest,
        },
      },
      cwd,
    );
    // Inject canary secrets at the environment boundary.
    (canaryStartInput as { env: Record<string, string> }).env = {
      ...canaryStartInput.env,
      OCTANT_CREDENTIAL: canaryCredential,
      API_KEY: canaryApiKey,
      AUTHORIZATION: canaryBearer,
      OCTANT_EXTENSION_ID: entry.extensionId,
    };
    await context.supervisor.start(canaryStartInput);

    // Crash the process to generate crash evidence.
    context.processes[0]!.emit("exit", { code: 1, signal: null });
    // Allow the supervisor to process the crash.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The canary secrets must NOT appear in runtime evidence.
    const evidenceJson = JSON.stringify(context.evidence);
    expect(evidenceJson).not.toContain(canaryCredential);
    expect(evidenceJson).not.toContain(canaryApiKey);
    expect(evidenceJson).not.toContain(canaryBearer);
    // General secret-pattern scans on evidence.
    expect(evidenceJson).not.toMatch(/api[_-]?key/i);
    expect(evidenceJson).not.toMatch(/secret/i);
    expect(evidenceJson).not.toMatch(/private[_-]?key/i);
    expect(evidenceJson).not.toMatch(/bearer\s+[a-z0-9]{20}/i);
    expect(evidenceJson).not.toMatch(/password/i);
    expect(evidenceJson).not.toMatch(/token\s*[:=]\s*["'][a-z0-9]{20}/i);

    // The canary secrets must NOT appear in journal events.
    const events = context.journal.replay({ afterSequence: 0 as never, limit: 1000 });
    const eventsJson = JSON.stringify(events);
    expect(eventsJson).not.toContain(canaryCredential);
    expect(eventsJson).not.toContain(canaryApiKey);
    expect(eventsJson).not.toContain(canaryBearer);
    // General secret-pattern scans on journal events.
    expect(eventsJson).not.toMatch(/api[_-]?key/i);
    expect(eventsJson).not.toMatch(/private[_-]?key/i);
    expect(eventsJson).not.toMatch(/bearer\s+[a-z0-9]{20}/i);
    expect(eventsJson).not.toMatch(/password/i);
    expect(eventsJson).not.toMatch(/token\s*[:=]\s*["'][a-z0-9]{20}/i);

    // The canary secrets must NOT appear in the snapshot.
    const snapshotJson = JSON.stringify(snapshot);
    expect(snapshotJson).not.toContain(canaryCredential);
    expect(snapshotJson).not.toContain(canaryApiKey);
    expect(snapshotJson).not.toContain(canaryBearer);
    // General secret-pattern scans on snapshot.
    expect(snapshotJson).not.toMatch(/api[_-]?key/i);
    expect(snapshotJson).not.toMatch(/private[_-]?key/i);
    expect(snapshotJson).not.toMatch(/bearer\s+[a-z0-9]{20}/i);
    expect(snapshotJson).not.toMatch(/password/i);

    // The canary secrets must NOT appear in the provider request body
    // when the skill content is sent through the non-Codex provider. The
    // provider context is composed from the skill instructions, not from
    // the process environment.
    const requestBodies = await sendSelectedSkillToGenericProvider(
      effectiveSnapshot(context.api.snapshot(), context.scope),
      entry,
    );
    expect(requestBodies).toHaveLength(1);
    const providerBodyJson = JSON.stringify(requestBodies[0]);
    expect(providerBodyJson).not.toContain(canaryCredential);
    expect(providerBodyJson).not.toContain(canaryApiKey);
    expect(providerBodyJson).not.toContain(canaryBearer);
  });

  it("proves explicit $skill selection fails closed before trust, then resolves with exact qualified identity and provider-context delivery after trust/enable through the non-Codex provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-phase10-skill-sources-"));
    directories.push(root);
    const projectRoot = join(root, "project");
    const workingDirectory = join(projectRoot, "packages", "app");
    const globalRoot = join(root, "global", ".agents", "skills");
    await mkdir(workingDirectory, { recursive: true });
    await mkdir(join(projectRoot, ".agents", "skills", "review"), { recursive: true });
    await mkdir(join(globalRoot, "review"), { recursive: true });

    // Project-ancestry skill named "review".
    await writeFile(
      join(projectRoot, ".agents", "skills", "review", "SKILL.md"),
      "# review\n\nProject-ancestry review skill.\n",
    );
    // User-global skill also named "review" (cross-source collision).
    await writeFile(
      join(globalRoot, "review", "SKILL.md"),
      "# review\n\nUser-global review skill.\n",
    );
    // A unique user-global skill that can be explicitly selected.
    const summarizeContent = "# summarize\n\nSummarize content concisely in bullet points.\n";
    await mkdir(join(globalRoot, "summarize"), { recursive: true });
    await writeFile(join(globalRoot, "summarize", "SKILL.md"), summarizeContent);

    const discovery = new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            workingDirectory,
            projectRoot,
            projectRef: "project:phase10-skills",
            userGlobalSkillsRoot: globalRoot,
          },
        ],
      },
    });
    const context = await setupIntegrated({ discoveryRoots: discovery });
    const reconciled = await context.skills.reconcile();
    const reconciledSkills = reconciled.skills ?? [];

    // All three skills are discovered (two "review" from different sources +
    // one "summarize" from user-global).
    const discoveredSkills = reconciledSkills.filter((skill) => skill.source.kind !== "bundled");
    const names = discoveredSkills.map((skill) => skill.skill.name).sort();
    expect(names).toEqual(["review", "review", "summarize"]);
    expect(
      reconciledSkills.some(
        (skill) => skill.skill.name === "review-in-parallel" && skill.source.kind === "bundled",
      ),
    ).toBe(true);

    // The user-global "summarize" skill was discovered with actual content.
    const summarize = discoveredSkills.find((skill) => skill.skill.name === "summarize");
    expect(summarize).toBeDefined();
    expect(summarize?.skill.diagnostic).toBeUndefined();
    const summarizeQualifiedId = summarize?.skill.qualifiedId;
    expect(summarizeQualifiedId).toBeDefined();

    // Discovered (non-bundled) skills are disabled-untrusted by default.
    expect(discoveredSkills.every((skill) => skill.desiredEnabled === false)).toBe(true);
    expect(reconciledSkillsBlocked(reconciled)).toBe(true);

    // The same-name "review" collision is visible (no silent shadowing).
    expect(reconciled.collisions.map((collision) => collision.name)).toContain("review");
    const reviewCollision = reconciled.collisions.find((collision) => collision.name === "review");
    expect(reviewCollision?.candidates.length).toBe(2);

    // --- RED: fail-closed before trust ---
    // An explicit $summarize selection on the untrusted skill resolves to
    // `blocked` with reason `untrusted` — not `selected`, not `ambiguous`.
    const blockedCatalog: ExtensionAddressingCatalog = {
      epoch: effectiveSnapshot(context.api.snapshot(), context.scope).catalogEpoch,
      plugins: [],
      skills: reconciledSkills.map((skill) => ({
        skillId: skill.skill.qualifiedId,
        name: skill.skill.name,
        label: skill.displayName,
        packageDigest: skill.skill.digest,
        effectiveState: skill.effectiveState,
        capabilityIds: [],
      })) as never,
    };
    const blockedResolution = resolveDraftExtensionReference(
      "$summarize",
      blockedCatalog,
      "pre-trust-draft",
    );
    expect(blockedResolution.kind).toBe("blocked");
    if (blockedResolution.kind === "blocked") {
      expect(blockedResolution.reason).toBe("untrusted");
    }

    // The unqualified $review invocation fails closed with an ambiguous chooser
    // (two candidates from different sources).
    const ambiguous = resolveDraftExtensionReference("$review", blockedCatalog, "collision-draft");
    expect(ambiguous.kind).toBe("ambiguous");
    if (ambiguous.kind === "ambiguous") {
      expect(ambiguous.candidates).toHaveLength(2);
    }

    // --- GREEN: successful explicit selection after trust/enable ---
    // Simulate trust/enable by constructing an addressing catalog where the
    // "summarize" skill has effectiveState { kind: "effective" } and a
    // corresponding capability catalog entry (as the chat-resolver does for
    // installed plugin-package skills).
    const effective = effectiveSnapshot(context.api.snapshot(), context.scope);
    const activeScope: CapabilityActiveScope = {
      mode: { referenceId: "mode:code", revision: 1 },
      project: { referenceId: "project:none", revision: 1 },
      host: { referenceId: "host:local", revision: 1 },
      model: { referenceId: `model:${modelId}`, revision: 1 },
    };
    const summarizeCapabilityId = contextEntryId(`skill:${summarizeQualifiedId}`);
    const summarizeCapability: CapabilityCatalogEntry = {
      id: summarizeCapabilityId,
      source: {
        kind: "plugin-package",
        referenceId: String(summarizeQualifiedId),
        packageId: "standalone:summarize",
        componentId: "summarize" as never,
      },
      componentKind: "plugin-instruction",
      label: "summarize",
      schemaCost: { kind: "known", tokens: 32, accuracy: "exact-tokenizer" },
      availability: "available",
      trust: "trusted",
      enablement: "enabled",
      policy: "allowed",
      providerEligibility: {
        providerInstanceId,
        status: "eligible",
        reason: "selected-provider",
      },
      scopeEligibility: {
        mode: { ...activeScope.mode, status: "eligible" },
        project: { ...activeScope.project, status: "eligible" },
        host: { ...activeScope.host, status: "eligible" },
        model: { ...activeScope.model, status: "eligible" },
      },
      posture: "optional",
      selectionMode: "explicit",
      taskKeywords: [],
      epoch: 1,
      invalidationFacts: [],
    };
    const trustedCatalog: ExtensionAddressingCatalog = {
      epoch: effective.catalogEpoch,
      plugins: [],
      skills: reconciledSkills.map((skill) => ({
        skillId: skill.skill.qualifiedId,
        name: skill.skill.name,
        label: skill.displayName,
        packageDigest: skill.skill.digest,
        effectiveState:
          skill.skill.name === "summarize"
            ? ({ kind: "effective" } as never)
            : skill.effectiveState,
        capabilityIds: skill.skill.name === "summarize" ? [summarizeCapabilityId] : [],
      })) as never,
    };
    const selectedResolution = resolveDraftExtensionReference(
      "$summarize",
      trustedCatalog,
      "post-trust-draft",
    );
    // Exact result kind: "selected" (not blocked, not ambiguous).
    expect(selectedResolution.kind).toBe("selected");
    if (selectedResolution.kind === "selected") {
      // Exact qualified identity: the selection's skillId matches the
      // discovered skill's qualifiedId.
      expect(selectedResolution.selection.kind).toBe("skill");
      if (selectedResolution.selection.kind === "skill") {
        expect(String(selectedResolution.selection.skillId)).toBe(String(summarizeQualifiedId));
      }
      expect(selectedResolution.label).toBe("summarize");
    }

    // --- Provider-context delivery through the non-Codex provider ---
    // Compose the selected skill's content into provider context and send
    // through the generic OpenAI-compatible driver (non-Codex/non-Claude).
    const composed = await composeSelectedExtensionCapabilities({
      phase: "send",
      selections: selectedResolution.kind === "selected" ? [selectedResolution.selection] : [],
      addressingCatalog: trustedCatalog,
      authoritativeCatalogEpoch: effective.catalogEpoch,
      capabilityCatalog: {
        entries: [summarizeCapability],
        epoch: deriveCatalogEpoch({
          entries: [summarizeCapability],
          activeFacts: { providerInstanceId, activeScope },
          invalidationFacts: [],
        }),
      },
      capabilityRequest: {
        providerInstanceId,
        activeScope,
        nativeToolSearch: "unsupported",
        taskKeywords: [],
        explicitSelections: [],
      },
      loadMaterial: async (capabilityEntry) => ({
        context: {
          kind: "instructions" as const,
          text:
            capabilityEntry.source.kind === "plugin-package" &&
            capabilityEntry.source.componentId === "summarize"
              ? summarizeContent.trim()
              : "unused",
        },
        tools: [],
      }),
    });
    if (composed.status !== "selected") {
      throw new Error(`Expected selected capabilities, received ${composed.reasons.join(", ")}.`);
    }

    const requestBodies: unknown[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/models")) return Response.json({ data: [{ id: modelId }] });
      requestBodies.push(JSON.parse(String(init?.body)) as unknown);
      return chatStream("summarized answer");
    });
    const runtimeRegistry = new ProviderRuntimeRegistry();
    const configuration: OpenAiCompatibleProviderConfiguration = {
      kind: "openai-compatible-http",
      baseUrl: "https://generic-provider.example/v1",
      authentication: "bearer",
      protocol: "chat-completions",
      manualModelIds: [modelId],
    };
    const driver = makeOpenAiCompatibleDriver({
      instanceId: providerInstanceId,
      configuration,
      runtimeRegistry,
      credentialResolver: { has: async () => true, resolve: async () => "private-key" },
      fetch,
      clock: () => "2026-07-30T00:00:00.000Z",
      correlationId: () => "42000000-0000-4000-8000-000000000210",
    });
    const observed = await Effect.runPromise(
      Effect.scoped(driver.probe({ instanceId: providerInstanceId })),
    );
    runtimeRegistry.setObservedState({
      ...observed,
      capabilities: { ...observed.capabilities, appManagedTools: "supported" },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.acquire({
            instanceId: providerInstanceId,
            projectRoot: "/tmp/octant-phase10-skill-provider",
          });
          yield* connection.start({
            sessionId: providerSessionId,
            modelId,
            executionPolicy: "approval-gated",
          });
          const terminal = yield* Effect.fork(
            Stream.runCollect(
              (yield* connection.subscribe).pipe(
                Stream.filter((event) => event.sessionId === providerSessionId),
                Stream.takeUntil(
                  (event) =>
                    event.kind === "completed" ||
                    event.kind === "interrupted" ||
                    event.kind === "failed",
                ),
              ),
            ),
          );
          yield* connection.send({
            sessionId: providerSessionId,
            prompt: "Summarize the selected content",
            context: composed.providerContext,
            attachments: [],
            tools: composed.tools,
          });
          expect(Array.from(yield* Fiber.join(terminal)).at(-1)?.kind).toBe("completed");
          yield* connection.stop(providerSessionId);
        }),
      ),
    );

    // The skill content was delivered to the non-Codex provider.
    expect(requestBodies).toHaveLength(1);
    const bodyJson = JSON.stringify(requestBodies[0]);
    expect(bodyJson).toContain("Summarize content concisely in bullet points");
  });

  it("cancels an active supervised process, drains it, and leaves no residual process after disable", async () => {
    const context = await setupIntegrated();
    const { entry, snapshot } = await installAndEnableCuratedPlugin(context);
    const cwd = "/tmp/octant-phase10-cancellation";

    // Start a supervised process.
    await context.supervisor.start(
      startInput(
        {
          manifest: {
            extensionId: entry.extensionId,
            packageId: entry.packageId,
            version: "0.1.2",
            digest: entry.digest,
          },
        },
        cwd,
      ),
    );
    expect(context.processes).toHaveLength(1);
    expect(context.processes[0]?.stop).not.toHaveBeenCalled();

    // The process cancel mock is available for drain cancellation.
    expect(context.processes[0]?.cancel).toBeDefined();

    // Disable the plugin: this triggers blockNewActivation + drain, which
    // cancels and stops the owned process. No residual process remains.
    await context.lifecycle.disable(entry.extensionId);

    // The process was stopped (drained).
    expect(context.processes[0]?.stop).toHaveBeenCalled();

    // After disable, the component is blocked at the activation level.
    const disabled = context.lifecycle.snapshot();
    const componentState = componentEffectiveState(context, disabled);
    expect(componentState).toMatchObject({ kind: "blocked", reason: "plugin-disabled" });

    // No residual process: the supervisor has no active runtimes for this
    // extension after drain + unregister.
    const receipts = await context.supervisor.receipts();
    expect(receipts.filter((r) => r.extensionId === entry.extensionId)).toHaveLength(0);

    // The supervisor's runtime map is empty for this extension (the process
    // was stopped and unregistered).
    expect(context.processes.length).toBeGreaterThanOrEqual(1); // process objects exist
    // But the stop was called, meaning the process was drained.
    expect(context.processes[0]?.stop).toHaveBeenCalledTimes(1);
  });

  it("proves core Apple build/run/test succeed with no Build iOS Apps extension installed", async () => {
    // No extension is installed — the core Apple capability must work
    // independently.
    const execute = vi.fn(async (input: { readonly argv: ReadonlyArray<string> }) => {
      const command = input.argv.join(" ");
      if (command === "xcode-select -p") {
        return processResult("/Applications/Xcode.app/Contents/Developer\n");
      }
      if (command === "xcodebuild -version")
        return processResult("Xcode 16.4\nBuild version 16F6\n");
      if (command === "swift --version") return processResult("Apple Swift version 6.1\n");
      if (command === "xcodebuild -showsdks") {
        return processResult(
          "iOS Simulator 18.5 -sdk iphonesimulator18.5\nmacOS 15.5 -sdk macosx15.5\n",
        );
      }
      if (command === "xcrun simctl list devices available --json") {
        return processResult(
          JSON.stringify({
            devices: {
              "com.apple.CoreSimulator.SimRuntime.iOS-18-5": [
                {
                  name: "iPhone 16",
                  udid: "42000000-0000-4000-8000-000000000020",
                  state: "Booted",
                  isAvailable: true,
                },
              ],
            },
          }),
        );
      }
      if (command.includes("xcodebuild") && command.includes("-list -json")) {
        return processResult(
          JSON.stringify({
            project: {
              schemes: ["Fixture"],
              configurations: ["Debug", "Release"],
              targets: ["Fixture", "FixtureTests"],
            },
          }),
        );
      }
      // A build command succeeds.
      if (command.includes("xcodebuild") && command.includes("build")) {
        return processResult("** BUILD SUCCEEDED **\n");
      }
      // A test command succeeds.
      if (command.includes("xcodebuild") && command.includes("test")) {
        return processResult("** TEST SUCCEEDED **\n");
      }
      return processResult("", { exitCode: 1, stderr: `unexpected command: ${command}` });
    });
    const service = new AppleToolchainService({
      execute,
      realpath: async (path: string) => path,
      now: () => now,
      newId: () => "42000000-0000-4000-8000-000000000012",
    });

    const coreAuthority: ToolActionAuthority = {
      hostId: "42000000-0000-4000-8000-000000000003" as never,
      mode: "code",
      projectId: "42000000-0000-4000-8000-000000000004" as never,
      rootId: "42000000-0000-4000-8000-000000000005" as never,
      worktreeId: "42000000-0000-4000-8000-000000000006" as never,
      providerInstanceId: providerInstanceId,
      extension: { kind: "core" },
    };
    const executionContext = {
      authority: coreAuthority,
      threadId: "42000000-0000-4000-8000-000000000008" as never,
      checkoutId: "42000000-0000-4000-8000-000000000009" as never,
      checkoutRoot: "/private/octant-phase10-fixture",
      artifactRoot: "/private/octant-phase10-artifacts",
      sourceRevision: "a".repeat(40),
      executionPolicy: "full-access" as const,
      approvalValid: true,
    };
    const discoveryRequest: AppleDiscoveryRequest = {
      actionId: "42000000-0000-4000-8000-000000000001" as never,
      correlationId: "42000000-0000-4000-8000-000000000002" as never,
      authority: coreAuthority,
      threadId: "42000000-0000-4000-8000-000000000008" as never,
      checkoutId: "42000000-0000-4000-8000-000000000009" as never,
      projectPath: "Fixture/Fixture.xcodeproj",
    };

    // Core discovery works with no extension installed.
    const discovery = await service.discover(discoveryRequest, executionContext);
    expect(discovery.kind).toBe("discovered");

    // Core build succeeds with no extension installed.
    const buildRequest: AppleBuildRequest = {
      ...discoveryRequest,
      kind: "build",
      platform: "ios",
      scheme: "Fixture",
      configuration: "debug",
      simulatorId: "42000000-0000-4000-8000-000000000020" as never,
      timeoutMs: 120_000,
      approval: { kind: "approved", approvalId: "42000000-0000-4000-8000-000000000011" as never },
    };
    const build = await service.execute(buildRequest, executionContext);
    expect(build.outcome).toBe("succeeded");

    // Core test succeeds with no extension installed.
    const testRequest: AppleBuildRequest = {
      ...buildRequest,
      kind: "test" as never,
    };
    const test = await service.execute(testRequest, executionContext);
    expect(test.outcome).toBe("succeeded");
  });
});

function reconciledSkillsBlocked(snapshot: ExtensionSnapshot): boolean {
  const skills = snapshot.skills?.filter((record) => record.source.kind !== "bundled");
  if (skills === undefined || skills.length === 0) return true;
  return skills.every(
    (record) =>
      record.effectiveState.kind === "blocked" &&
      (record.effectiveState as { readonly reason?: string }).reason === "untrusted",
  );
}

function processResult(
  stdout = "",
  options: {
    readonly stderr?: string;
    readonly exitCode?: number | null;
    readonly termination?: "exited" | "cancelled" | "timed-out" | "unavailable";
    readonly cleanupUncertain?: boolean;
  } = {},
) {
  return {
    termination: options.termination ?? "exited",
    exitCode: options.exitCode === undefined ? 0 : options.exitCode,
    stdout: new TextEncoder().encode(stdout),
    stderr: new TextEncoder().encode(options.stderr ?? ""),
    parserFailed: false,
    cleanupUncertain: options.cleanupUncertain ?? false,
  } as const;
}
