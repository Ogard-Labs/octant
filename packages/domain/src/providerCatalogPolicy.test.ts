import type {
  AggregateVersion,
  DiscoverySnapshot,
  ProviderDriverKind,
  ProviderInstance,
  ProviderInstanceId,
  ProviderObservedState,
  UtcTimestamp,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  providerCatalogCapabilities,
  resolveProviderCatalogState,
  type ProviderCatalogHostFacts,
  type ProviderCatalogPackage,
} from "./providerCatalogPolicy";
import {
  createCodexProvider,
  createOllamaProvider,
  createOutsideHarnessEndpointProvider,
} from "./providerPolicy";

const now = "2026-10-11T12:00:00.000Z" as UtcTimestamp;
const codexId = "codex-1" as ProviderInstanceId;

function bundled(driverKind: ProviderDriverKind, available = true): ProviderCatalogPackage {
  return { driverKind, installed: true, trusted: true, available };
}

function codex(enabled: boolean, id = codexId): ProviderInstance {
  return createCodexProvider({
    id,
    displayName: `Codex ${String(id)}`,
    binaryPath: "/opt/homebrew/bin/codex",
    existingInstances: [],
    expectedVersion: 0 as AggregateVersion,
    createdAt: now,
    enabled,
  });
}

function observed(
  instanceId: ProviderInstanceId,
  readiness: ProviderObservedState["readiness"],
): ProviderObservedState {
  return {
    instanceId,
    readiness,
    processState: "stopped",
    models: [],
    capabilities: {
      streaming: "supported",
      resume: "supported",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "supported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "unsupported",
      nativeAttachments: "supported",
      nativeWebResearch: "unsupported",
      appManagedTools: "supported",
      citations: "unsupported",
      harnessAutoReview: "unsupported",
    },
    observedAt: now,
  };
}

function snapshot(
  candidates: DiscoverySnapshot["candidates"],
  status: DiscoverySnapshot["status"] = "completed",
  searchedDirectories?: DiscoverySnapshot["searchedDirectories"],
): DiscoverySnapshot {
  return {
    hostId: "local" as DiscoverySnapshot["hostId"],
    candidates,
    scannedAt: now,
    scanDurationMs: 10,
    status,
    ...(searchedDirectories === undefined ? {} : { searchedDirectories }),
  };
}

const codexCandidate = {
  driverKind: "codex",
  displayName: "Codex CLI",
  binaryPath: "/opt/homebrew/Cellar/codex/1.0/bin/codex",
  discoveredPath: "/opt/homebrew/bin/codex",
  readiness: "ready",
  pathSummary: "/opt/homebrew/bin",
  detectedAt: now,
} as DiscoverySnapshot["candidates"][number];

function host(overrides: Partial<ProviderCatalogHostFacts> = {}): ProviderCatalogHostFacts {
  return {
    instances: [],
    observedByInstance: new Map(),
    probingIds: new Set(),
    discovery: undefined,
    ...overrides,
  };
}

describe("provider catalog state", () => {
  it("repeats the package's installed and trusted facts rather than deciding them", () => {
    const state = resolveProviderCatalogState(bundled("codex"), host());
    expect(state).toMatchObject({ installed: true, trusted: true, available: true });
    const untrusted = resolveProviderCatalogState(
      { driverKind: "codex", installed: true, trusted: false, available: false },
      host(),
    );
    expect(untrusted).toMatchObject({ trusted: false, available: false });
    expect(untrusted.next).toEqual({ kind: "unavailable" });
  });

  it("asks to check the host, not to install, before any scan has run", () => {
    const state = resolveProviderCatalogState(bundled("codex"), host());
    expect(state.presence).toEqual({ kind: "not-checked" });
    expect(state.enabled).toBe("not-added");
    expect(state.next).toEqual({ kind: "check-host" });
  });

  it("says install only when a scan that covered the driver did not find it", () => {
    expect(
      resolveProviderCatalogState(bundled("codex"), host({ discovery: snapshot([]) })).next,
    ).toEqual({ kind: "install" });
    // A partial scan that never reached Codex proves nothing about it.
    const partial = resolveProviderCatalogState(
      bundled("codex"),
      host({ discovery: snapshot([], "partial", [{ driverKind: "claude", directories: [] }]) }),
    );
    expect(partial.presence).toEqual({ kind: "not-checked" });
    expect(partial.next).toEqual({ kind: "check-host" });
    // A failed scan proves nothing either.
    expect(
      resolveProviderCatalogState(bundled("codex"), host({ discovery: snapshot([], "failed") }))
        .next,
    ).toEqual({ kind: "check-host" });
  });

  it("offers to add a detected runtime only while no provider uses that driver", () => {
    const fresh = resolveProviderCatalogState(
      bundled("codex"),
      host({ discovery: snapshot([codexCandidate]) }),
    );
    expect(fresh.next).toEqual({ kind: "add-detected", candidate: codexCandidate });

    const existing = resolveProviderCatalogState(
      bundled("codex"),
      host({ discovery: snapshot([codexCandidate]), instances: [codex(false)] }),
    );
    expect(existing.instance?.id).toBe(codexId);
    expect(existing.next).toEqual({ kind: "turn-on", instanceId: codexId });
  });

  it("continues the configured provider that is on and ready when a driver has several", () => {
    const other = "codex-2" as ProviderInstanceId;
    const state = resolveProviderCatalogState(
      bundled("codex"),
      host({
        instances: [codex(false), codex(true, other)],
        observedByInstance: new Map([[other, observed(other, "ready")]]),
      }),
    );
    expect(state.instance?.id).toBe(other);
    expect(state.instanceCount).toBe(2);
    expect(state).toMatchObject({ enabled: "yes", authenticated: "yes", ready: "yes" });
    expect(state.next).toEqual({ kind: "done", instanceId: other });
  });

  it("keeps enabled, authenticated, and ready distinct as a check moves on", () => {
    const on = [codex(true)];
    expect(resolveProviderCatalogState(bundled("codex"), host({ instances: on }))).toMatchObject({
      enabled: "yes",
      authenticated: "not-checked",
      ready: "not-checked",
      next: { kind: "check-connection", instanceId: codexId },
    });
    expect(
      resolveProviderCatalogState(
        bundled("codex"),
        host({ instances: on, probingIds: new Set([codexId]) }),
      ),
    ).toMatchObject({ ready: "checking", next: { kind: "check-connection" } });
    expect(
      resolveProviderCatalogState(
        bundled("codex"),
        host({
          instances: on,
          observedByInstance: new Map([[codexId, observed(codexId, "unauthenticated")]]),
        }),
      ),
    ).toMatchObject({
      enabled: "yes",
      authenticated: "no",
      ready: "no",
      next: { kind: "sign-in", instanceId: codexId },
    });
    expect(
      resolveProviderCatalogState(
        bundled("codex"),
        host({
          instances: on,
          observedByInstance: new Map([[codexId, observed(codexId, "unavailable")]]),
        }),
      ),
    ).toMatchObject({
      authenticated: "not-checked",
      ready: "no",
      next: { kind: "fix-runtime", instanceId: codexId, readiness: "unavailable" },
    });
  });

  it("never calls a provider that is off ready, whatever it last observed", () => {
    const state = resolveProviderCatalogState(
      bundled("codex"),
      host({
        instances: [codex(false)],
        observedByInstance: new Map([[codexId, observed(codexId, "ready")]]),
      }),
    );
    expect(state).toMatchObject({ enabled: "no", ready: "no" });
    expect(state.next).toEqual({ kind: "turn-on", instanceId: codexId });
  });

  it("sends an endpoint driver to Add endpoint and says Ollama needs no sign-in", () => {
    const azure = resolveProviderCatalogState(bundled("azure-foundry"), host());
    expect(azure).toMatchObject({ setup: "endpoint", presence: { kind: "not-applicable" } });
    expect(azure.next).toEqual({ kind: "add-endpoint" });

    const ollamaId = "ollama-1" as ProviderInstanceId;
    const ollama = createOllamaProvider({
      id: ollamaId,
      displayName: "Ollama",
      configuration: {
        kind: "ollama-native-http",
        baseUrl: "http://127.0.0.1:11434",
      },
      existingInstances: [],
      expectedVersion: 0 as AggregateVersion,
      createdAt: now,
    });
    const state = resolveProviderCatalogState(bundled("ollama"), host({ instances: [ollama] }));
    expect(state.authenticated).toBe("not-needed");

    // A local Ollama server the scan found is still added as an endpoint.
    const ollamaCandidate = {
      ...codexCandidate,
      driverKind: "ollama",
      displayName: "Ollama",
    } as DiscoverySnapshot["candidates"][number];
    const unconfigured = resolveProviderCatalogState(
      bundled("ollama"),
      host({ discovery: snapshot([ollamaCandidate]) }),
    );
    expect(unconfigured.presence).toEqual({ kind: "not-applicable" });
    expect(unconfigured.next).toEqual({ kind: "add-endpoint" });
  });

  it("sets an outside driver up as an endpoint added with its address, keyless only on loopback", () => {
    const outside = resolveProviderCatalogState(bundled("outside-harness-endpoint"), host());
    expect(outside).toMatchObject({ setup: "endpoint", presence: { kind: "not-applicable" } });
    expect(outside.next).toEqual({ kind: "add-endpoint" });
    expect(outside.capabilities.agentLoop).toBe("octant-harness");

    const keyless = createOutsideHarnessEndpointProvider({
      id: "outside-1" as ProviderInstanceId,
      displayName: "Loopback chat",
      configuration: {
        kind: "outside-harness-endpoint",
        driver: {
          extensionId: "00000000-0000-4000-8000-000000000911",
          packageId: "00000000-0000-4000-8000-000000000912",
          componentId: "driver",
          version: "0.1.0",
          digest: `sha256:${"d".repeat(64)}`,
        },
        baseUrl: "http://127.0.0.1:8080",
        modelIds: ["local-model"],
      } as never,
      existingInstances: [],
      expectedVersion: 0 as AggregateVersion,
      createdAt: now,
    });
    const added = resolveProviderCatalogState(
      bundled("outside-harness-endpoint"),
      host({ instances: [keyless] }),
    );
    // Added off, so the next step is turning it on, and a keyless one needs no sign-in.
    expect(added.next).toEqual({ kind: "turn-on", instanceId: keyless.id });
    expect(added.authenticated).toBe("not-needed");
  });

  it("states each driver's modes and agent loop as the send gates apply them", () => {
    expect(providerCatalogCapabilities("claude")).toEqual({
      modes: { chat: "yes", work: "checked-models", code: "checked-models" },
      agentLoop: "runtime",
      sandbox: "octant-in-plan",
    });
    expect(providerCatalogCapabilities("codex").sandbox).toBe("runtime");
    expect(providerCatalogCapabilities("opencode").sandbox).toBe("octant");
    expect(providerCatalogCapabilities("openai-compatible")).toEqual({
      modes: { chat: "yes", work: "verified-models", code: "verified-models" },
      agentLoop: "octant-harness",
      sandbox: "not-applicable",
    });
    expect(providerCatalogCapabilities("ollama")).toEqual({
      modes: { chat: "yes", work: "verified-models", code: "verified-models" },
      agentLoop: "octant-harness",
      sandbox: "not-applicable",
    });
    expect(providerCatalogCapabilities("oh-my-pi")).toEqual({
      modes: { chat: "no", work: "no", code: "no" },
      agentLoop: "none",
      sandbox: "not-applicable",
    });
  });
});
