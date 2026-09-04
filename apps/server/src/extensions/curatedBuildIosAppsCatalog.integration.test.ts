import { randomUUID, createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { CodexPluginPackageResolver } from "./codexPluginResolver";
import { createMockCatalogSource, MOCK_BUILD_IOS_APPS_FILES } from "./curatedCatalogTestFixtures";
import {
  ExtensionActivationService,
  LOCAL_EXTENSION_ACTIVATION_POLICY,
} from "./extensionActivationService";
import { ExtensionApiService } from "./extensionApiService";
import { composeSelectedExtensionCapabilities } from "./extensionAddressingService";
import { ExtensionLifecycleService, NOOP_EXTENSION_SUPERVISOR } from "./extensionLifecycleService";
import { ExtensionPackageStore } from "./extensionPackageStore";

const directories: Array<string> = [];
const now = "2026-07-30T08:00:00.000Z";
const providerInstanceId = decodeProviderInstanceId("91000000-0000-4000-8000-000000000101");
const providerSessionId = decodeProviderSessionId("91000000-0000-4000-8000-000000000102");
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

async function execute(api: ExtensionApiService, command: ExtensionCommand) {
  return api.execute(command);
}

function onlyPackage(snapshot: ExtensionSnapshot) {
  const entry = snapshot.packages[0];
  if (entry === undefined) throw new Error("Expected an installed extension package.");
  return entry;
}

/**
 * Installs the curated Build iOS Apps package through the real journaled
 * lifecycle and drives it to a fully trusted, enabled state, returning the
 * scoped effective snapshot for a non-Codex provider family.
 */
async function installAndEnableCuratedPlugin(providerFamily: string) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "octant-curated-provider-"));
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
  const { catalogSource: record, mockFetch } = await createMockCatalogSource();
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

  const search = await execute(api, { kind: "search-catalog", query: "build-ios-apps" });
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
  const disabledScope = scopeFor(providerFamily);
  const disabledEffective = effectiveSnapshot(installed.snapshot, disabledScope);

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
  const componentEnabled = await execute(api, {
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
  const scope = scopeFor(providerFamily);
  return {
    entry,
    snapshot: componentEnabled.snapshot,
    effective: effectiveSnapshot(componentEnabled.snapshot, scope),
    disabledEffective,
    scope,
  };
}

function scopeFor(providerFamily: string) {
  return {
    hostId: "local",
    mode: "code",
    projectId: null,
    threadId: null,
    providerFamily,
  } as const;
}

function effectiveSnapshot(
  snapshot: ExtensionSnapshot,
  scope: ReturnType<typeof scopeFor>,
): ExtensionEffectiveSnapshot {
  const activation = new ExtensionActivationService({
    policy: LOCAL_EXTENSION_ACTIVATION_POLICY,
    catalogStatus: () => "available",
  });
  return activation.resolve(snapshot, { scope: scope as never });
}

/**
 * Mirrors the server chat-resolver catalog projection for the selected skill
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

describe("curated Build iOS Apps through the provider-neutral extension path", () => {
  it("resolves structured addressing and sends the selected skill through a non-Codex provider", async () => {
    const { entry, effective, disabledEffective } =
      await installAndEnableCuratedPlugin("openai-compatible");

    // Disabled/untrusted plugin: the skill stays blocked and contributes zero context.
    const disabledCatalogs = catalogsFor(disabledEffective, entry);
    const disabledResolution = resolveDraftExtensionReference(
      "@build-ios-apps/skill-swiftui-ui-patterns",
      disabledCatalogs.addressing,
      "d0",
    );
    expect(disabledResolution).toEqual({ kind: "blocked", reason: "untrusted" });

    // Bare @build-ios-apps has no unambiguous primary capability: fail closed.
    const catalogs = catalogsFor(effective, entry);
    expect(resolveDraftExtensionReference("@build-ios-apps", catalogs.addressing, "d1")).toEqual({
      kind: "blocked",
      reason: "component-required",
    });

    const draft = resolveDraftExtensionReference(
      "@build-ios-apps/skill-swiftui-ui-patterns",
      catalogs.addressing,
      "d2",
    );
    if (draft.kind !== "selected") throw new Error("Expected a structured plugin selection.");
    expect(draft.selection.packageDigest).toBe(entry.digest);

    const activeScope: CapabilityActiveScope = {
      mode: { referenceId: "mode:code", revision: 1 },
      project: { referenceId: "project:none", revision: 1 },
      host: { referenceId: "host:local", revision: 1 },
      model: { referenceId: `model:${modelId}`, revision: 1 },
    };
    const skillContent =
      MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/skills/swiftui-ui-patterns/SKILL.md"]!;
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
    expect(composed.providerContext).toHaveLength(1);
    expect(composed.tools).toHaveLength(0);

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
      correlationId: () => "91000000-0000-4000-8000-000000000103",
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
            projectRoot: "/tmp/octant-generic-provider",
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

    expect(requestBodies).toHaveLength(1);
    // The exact upstream skill instructions reached the non-Codex provider turn.
    expect(JSON.stringify(requestBodies[0])).toContain("SwiftUI UI Patterns");
    expect(JSON.stringify(requestBodies[0])).toContain("Choose a track based on your goal");
    // The curated plugin content declares no provider-specific activation.
    expect(
      MOCK_BUILD_IOS_APPS_FILES["plugins/build-ios-apps/.codex-plugin/plugin.json"],
    ).not.toContain("openai.yaml");
  });
});

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
      id: "chatcmpl_generic",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl_generic",
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
