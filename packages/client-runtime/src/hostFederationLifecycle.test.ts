import { describe, expect, it, vi } from "vitest";
import { LOCAL_HOST_ID, decodeHostId } from "@octant/contracts/host";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
  type ClientHostRegistration,
} from "./hostFederationRegistry";
import {
  createHostFederationTransports,
  type HostFederationTransportFactory,
} from "./hostFederationTransports";
import {
  createHostReadModelCache,
  buildFederatedReadItem,
  rejectQueuedAuthorityMutation,
} from "./hostFederationMergedReads";
import { createInMemoryDeviceKeyStore, type RemoteDeviceKeyStore } from "./remotePairingClient";
import type { RemoteSessionBridge, RemoteSessionBridgeState } from "./remoteSessionBridge";
import {
  createHostFederationLifecycle,
  federatedLifecycleStateFromTransport,
  mapLifecycleStateToHostHealth,
  type FederatedHostLifecycleState,
  type HostFederationLifecycle,
} from "./hostFederationLifecycle";

const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";

function remoteHost(
  overrides: Partial<ClientHostRegistration> &
    Pick<ClientHostRegistration, "hostId" | "displayName" | "origin" | "credential">,
): ClientHostRegistration {
  return {
    kind: "remote",
    enabled: true,
    ...overrides,
  };
}

function createControllableBridge(
  hostId: string,
  displayName: string,
): RemoteSessionBridge & {
  readonly setState: (next: RemoteSessionBridgeState) => void;
} {
  let state: RemoteSessionBridgeState = {
    kind: "ready",
    hostId,
    displayName,
  };
  const listeners = new Set<(next: RemoteSessionBridgeState) => void>();
  const connection = {
    authenticatedFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    disconnect: vi.fn(),
    reconnect: vi.fn(async () => {
      state = { kind: "ready", hostId, displayName };
      for (const listener of listeners) listener(state);
    }),
    state: () => "ready" as const,
    session: () => ({ sessionId: `session-${hostId}` }),
  };
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: vi.fn(),
    resume: vi.fn((origin: string) => {
      void origin;
      state = { kind: "ready", hostId, displayName };
      for (const listener of listeners) listener(state);
    }),
    forgetDeviceKey: vi.fn(async () => undefined),
    stageDeviceKeyRotation: vi.fn(async () => {
      throw new Error("Device key rotation is not part of this test double.");
    }),
    reconnect: vi.fn(() => {
      state = { kind: "reconnecting", hostId, displayName };
      for (const listener of listeners) listener(state);
      state = { kind: "ready", hostId, displayName };
      for (const listener of listeners) listener(state);
    }),
    disconnect: vi.fn(() => {
      state = { kind: "idle" };
      for (const listener of listeners) listener(state);
    }),
    connection: vi.fn(() => connection as never),
  };
}

function createFactory(
  bridges: Map<string, ReturnType<typeof createControllableBridge>>,
): HostFederationTransportFactory {
  return {
    createRemoteBridge: (registration) => {
      const existing = bridges.get(registration.hostId);
      if (existing !== undefined) return existing;
      const bridge = createControllableBridge(registration.hostId, registration.displayName);
      bridges.set(registration.hostId, bridge);
      return bridge;
    },
  };
}

async function seedDeviceKey(
  store: RemoteDeviceKeyStore,
  input: { readonly origin: string; readonly hostId: string; readonly deviceId: string },
): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ]);
  const keyId = await store.set(
    { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey },
    { origin: input.origin, hostId: input.hostId as never, deviceId: input.deviceId },
  );
  await store.updateMetadata(keyId, {
    deviceId: input.deviceId,
    credentialGeneration: 1,
    hostKeyFingerprint: input.hostId === HOST_A ? "a".repeat(64) : "b".repeat(64),
  });
  return keyId;
}

async function seedTwoRemotes(input?: { readonly deviceKeyStore?: RemoteDeviceKeyStore }): Promise<{
  readonly registry: ReturnType<typeof createClientHostRegistry>;
  readonly deviceKeyStore: RemoteDeviceKeyStore;
  readonly bridges: Map<string, ReturnType<typeof createControllableBridge>>;
  readonly transports: ReturnType<typeof createHostFederationTransports>;
  readonly cache: ReturnType<typeof createHostReadModelCache>;
  readonly lifecycle: HostFederationLifecycle;
  readonly keyIdA: string;
  readonly keyIdB: string;
}> {
  const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
  const deviceKeyStore = input?.deviceKeyStore ?? createInMemoryDeviceKeyStore();

  const keyIdA = await seedDeviceKey(deviceKeyStore, {
    origin: "https://studio.tailnet:8443",
    hostId: HOST_A,
    deviceId: "device-a",
  });
  const keyIdB = await seedDeviceKey(deviceKeyStore, {
    origin: "https://laptop.tailnet:8443",
    hostId: HOST_B,
    deviceId: "device-b",
  });

  await registry.upsertRemote(
    remoteHost({
      hostId: decodeHostId(HOST_A),
      displayName: "Studio",
      origin: "https://studio.tailnet:8443",
      credential: {
        keyId: keyIdA,
        credentialGeneration: 1,
        hostKeyFingerprint: "a".repeat(64),
        deviceId: "device-a",
      },
      cacheMetadata: {
        lastReadyAt: "2026-08-12T08:00:00.000Z",
        lastReplayCursor: "seq:studio:42",
      },
    }),
  );
  await registry.upsertRemote(
    remoteHost({
      hostId: decodeHostId(HOST_B),
      displayName: "Laptop",
      origin: "https://laptop.tailnet:8443",
      credential: {
        keyId: keyIdB,
        credentialGeneration: 1,
        hostKeyFingerprint: "b".repeat(64),
        deviceId: "device-b",
      },
      cacheMetadata: {
        lastReadyAt: "2026-08-12T08:05:00.000Z",
        lastReplayCursor: "seq:laptop:17",
      },
    }),
  );

  const bridges = new Map<string, ReturnType<typeof createControllableBridge>>();
  const transports = createHostFederationTransports({
    registry,
    deviceKeyStore,
    factory: createFactory(bridges),
  });
  await transports.syncEnabledHosts();

  const cache = createHostReadModelCache();
  cache.put({
    hostId: decodeHostId(HOST_A),
    hostDisplayName: "Studio",
    freshness: "ready",
    items: [
      buildFederatedReadItem({
        hostId: HOST_A,
        entityId: "thread-a",
        kind: "thread",
        hostDisplayName: "Studio",
        title: "Studio thread",
        sortKey: "2026-08-12T08:00:00.000Z",
      }),
    ],
  });
  cache.put({
    hostId: decodeHostId(HOST_B),
    hostDisplayName: "Laptop",
    freshness: "ready",
    items: [
      buildFederatedReadItem({
        hostId: HOST_B,
        entityId: "thread-b",
        kind: "thread",
        hostDisplayName: "Laptop",
        title: "Laptop thread",
        sortKey: "2026-08-12T08:05:00.000Z",
      }),
    ],
  });

  const lifecycle = createHostFederationLifecycle({
    registry,
    transports,
    deviceKeyStore,
    cache,
  });
  await lifecycle.sync();

  return { registry, deviceKeyStore, bridges, transports, cache, lifecycle, keyIdA, keyIdB };
}

describe("federatedLifecycleStateFromTransport / HostHealth mapping", () => {
  it("exposes explicit connecting/ready/stale/incompatible/unauthorized/unavailable states", () => {
    const cases: Array<{
      transport: Parameters<typeof federatedLifecycleStateFromTransport>[0];
      expected: FederatedHostLifecycleState;
    }> = [
      { transport: { kind: "local-ready" }, expected: "ready" },
      {
        transport: { kind: "ready", hostId: HOST_A, displayName: "Studio" },
        expected: "ready",
      },
      {
        transport: { kind: "connecting", hostId: HOST_A, displayName: "Studio" },
        expected: "connecting",
      },
      {
        transport: { kind: "reconnecting", hostId: HOST_A, displayName: "Studio" },
        expected: "connecting",
      },
      {
        transport: { kind: "stale", hostId: HOST_A, displayName: "Studio" },
        expected: "stale",
      },
      {
        transport: { kind: "incompatible", reason: "wire mismatch" },
        expected: "incompatible",
      },
      {
        transport: { kind: "unauthorized", reason: "expired", reasonCode: "expired" },
        expected: "unauthorized",
      },
      {
        transport: { kind: "unavailable", reason: "offline" },
        expected: "unavailable",
      },
      { transport: { kind: "idle" }, expected: "unavailable" },
    ];

    for (const entry of cases) {
      expect(federatedLifecycleStateFromTransport(entry.transport)).toBe(entry.expected);
    }

    expect(mapLifecycleStateToHostHealth("ready")).toBe("healthy");
    expect(mapLifecycleStateToHostHealth("connecting")).toBe("connecting");
    expect(mapLifecycleStateToHostHealth("stale")).toBe("stale");
    expect(mapLifecycleStateToHostHealth("incompatible")).toBe("incompatible");
    expect(mapLifecycleStateToHostHealth("unauthorized")).toBe("unauthorized");
    expect(mapLifecycleStateToHostHealth("unavailable")).toBe("unavailable");
  });
});

describe("HostFederationLifecycle (Post-preview B6)", () => {
  it("lists independent per-host lifecycle snapshots including This Mac", async () => {
    const { lifecycle } = await seedTwoRemotes();
    const listed = lifecycle.list();
    expect(listed.map((entry) => entry.hostId)).toEqual([LOCAL_HOST_ID, HOST_A, HOST_B]);
    expect(listed.every((entry) => entry.state === "ready")).toBe(true);
    expect(lifecycle.get(HOST_A)?.displayName).toBe("Studio");
    expect(lifecycle.get(HOST_A)?.replayCursor).toBe("seq:studio:42");
    expect(lifecycle.get(HOST_B)?.replayCursor).toBe("seq:laptop:17");
    expect(lifecycle.get(HOST_A)?.actions.canReconnect).toBe(false);
    expect(lifecycle.get(HOST_A)?.actions.canRevoke).toBe(true);
    expect(lifecycle.get(HOST_A)?.actions.canRemove).toBe(true);
    expect(lifecycle.get(LOCAL_HOST_ID)?.actions.canRemove).toBe(false);
  });

  it("isolates fail-one: marking one host unavailable leaves others ready and shell usable", async () => {
    const { lifecycle, bridges, cache } = await seedTwoRemotes();
    bridges.get(HOST_A)!.setState({
      kind: "unavailable",
      reason: "Studio transport dropped.",
      hostId: HOST_A,
      displayName: "Studio",
    });

    lifecycle.observeTransportChange();

    expect(lifecycle.get(HOST_A)?.state).toBe("unavailable");
    expect(lifecycle.get(HOST_B)?.state).toBe("ready");
    expect(lifecycle.get(LOCAL_HOST_ID)?.state).toBe("ready");
    expect(cache.get(HOST_A)?.freshness).toBe("stale");
    expect(cache.get(HOST_A)?.items.every((item) => item.readOnly)).toBe(true);
    expect(cache.get(HOST_B)?.freshness).toBe("ready");

    const mutation = rejectQueuedAuthorityMutation({
      hostId: HOST_A,
      freshness: "stale",
      action: "create-thread",
    });
    expect(mutation.allowed).toBe(false);
    expect(mutation.queued).toBe(false);
  });

  it("surfaces expiry as unauthorized with actionable reconnect disabled until re-pair", async () => {
    const { lifecycle, bridges } = await seedTwoRemotes();
    bridges.get(HOST_B)!.setState({
      kind: "unauthorized",
      reason: "This remote device credential expired; pair this browser again.",
      reasonCode: "expired",
      hostId: HOST_B,
      displayName: "Laptop",
    });
    lifecycle.observeTransportChange();

    const laptop = lifecycle.get(HOST_B)!;
    expect(laptop.state).toBe("unauthorized");
    expect(laptop.reasonCode).toBe("expired");
    expect(laptop.expiry?.expired).toBe(true);
    expect(laptop.actions.canReconnect).toBe(false);
    expect(laptop.actions.canRemove).toBe(true);
    expect(laptop.reason).toMatch(/expired/i);
    expect(lifecycle.get(HOST_A)?.state).toBe("ready");
  });

  it("reconnects one host from its durable replay cursor without touching others", async () => {
    const { lifecycle, bridges } = await seedTwoRemotes();
    bridges.get(HOST_A)!.setState({
      kind: "stale",
      hostId: HOST_A,
      displayName: "Studio",
    });
    lifecycle.observeTransportChange();
    expect(lifecycle.get(HOST_A)?.actions.canReconnect).toBe(true);

    const result = await lifecycle.reconnect(HOST_A);
    expect(result.ok).toBe(true);
    expect(result.replayCursor).toBe("seq:studio:42");
    expect(bridges.get(HOST_A)!.reconnect).toHaveBeenCalledTimes(1);
    expect(bridges.get(HOST_B)!.reconnect).not.toHaveBeenCalled();
    expect(lifecycle.get(HOST_A)?.state).toBe("ready");
    expect(lifecycle.get(HOST_B)?.state).toBe("ready");
  });

  it("revokes one host clearing only that host credential + cache + transport", async () => {
    const { lifecycle, registry, deviceKeyStore, bridges, transports, cache, keyIdA, keyIdB } =
      await seedTwoRemotes();

    const revokeSelf = vi.fn(async () => ({ localCredentialRemoved: true }));
    const result = await lifecycle.revoke(HOST_A, { revokeSelf });

    expect(result.ok).toBe(true);
    expect(result.localCredentialRemoved).toBe(true);
    expect(revokeSelf).toHaveBeenCalledTimes(1);
    expect(bridges.get(HOST_A)!.disconnect).toHaveBeenCalled();
    expect(bridges.get(HOST_B)!.disconnect).not.toHaveBeenCalled();
    expect(await deviceKeyStore.get(keyIdA)).toBeUndefined();
    expect(await deviceKeyStore.get(keyIdB)).toBeDefined();
    expect(await registry.get(HOST_A)).toBeUndefined();
    expect(await registry.get(HOST_B)).toBeDefined();
    expect(await registry.get(LOCAL_HOST_ID)).toBeDefined();
    expect(cache.get(HOST_A)).toBeUndefined();
    expect(cache.get(HOST_B)?.freshness).toBe("ready");
    expect(transports.get(HOST_A)).toBeUndefined();
    expect(transports.get(HOST_B)?.state.kind).toBe("ready");
    expect(lifecycle.get(HOST_A)).toBeUndefined();
    expect(lifecycle.get(HOST_B)?.state).toBe("ready");
  });

  it("removeLocal clears only that remote without host-side revoke and never removes This Mac", async () => {
    const { lifecycle, registry, deviceKeyStore, cache, keyIdA, keyIdB } = await seedTwoRemotes();

    await expect(lifecycle.removeLocal(LOCAL_HOST_ID)).rejects.toThrow(/This Mac|local/i);

    const result = await lifecycle.removeLocal(HOST_B);
    expect(result.ok).toBe(true);
    expect(await deviceKeyStore.get(keyIdB)).toBeUndefined();
    expect(await deviceKeyStore.get(keyIdA)).toBeDefined();
    expect(await registry.get(HOST_B)).toBeUndefined();
    expect(await registry.get(HOST_A)).toBeDefined();
    expect(cache.get(HOST_B)).toBeUndefined();
    expect(cache.get(HOST_A)?.freshness).toBe("ready");
    expect(lifecycle.list().map((entry) => entry.hostId)).toEqual([LOCAL_HOST_ID, HOST_A]);
  });

  it("never queues mutations for expired/revoked/stale hosts during partial outage", async () => {
    const { lifecycle, bridges } = await seedTwoRemotes();
    bridges.get(HOST_A)!.setState({
      kind: "unauthorized",
      reason: "revoked",
      reasonCode: "revoked",
      hostId: HOST_A,
      displayName: "Studio",
    });
    lifecycle.observeTransportChange();

    const decision = lifecycle.mutationDecision(HOST_A, "approve-tool");
    expect(decision.allowed).toBe(false);
    expect(decision.queued).toBe(false);
    expect(decision.reason).toMatch(/unauthorized|read-only|reconnect/i);

    const healthy = lifecycle.mutationDecision(HOST_B, "approve-tool");
    expect(healthy.allowed).toBe(true);
    expect(healthy.queued).toBe(false);
  });

  it("builds HostIdentity observations for shell selectors without collapsing failures", async () => {
    const { lifecycle, bridges } = await seedTwoRemotes();
    bridges.get(HOST_A)!.setState({
      kind: "incompatible",
      reason: "Capability mismatch",
      hostId: HOST_A,
      displayName: "Studio",
    });
    lifecycle.observeTransportChange();

    const identities = lifecycle.toHostIdentities();
    expect(identities).toHaveLength(3);
    expect(identities.find((host) => host.hostId === HOST_A)?.health).toBe("incompatible");
    expect(identities.find((host) => host.hostId === HOST_B)?.health).toBe("healthy");
    expect(identities.find((host) => host.hostId === LOCAL_HOST_ID)?.health).toBe("healthy");
  });
});
