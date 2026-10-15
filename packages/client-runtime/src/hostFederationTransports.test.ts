import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_HOST_ID,
  decodeEntityId,
  decodeGlobalEntityReference,
  decodeHostId,
} from "@octant/contracts/host";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import type { RemoteSessionBridge, RemoteSessionBridgeState } from "./remoteSessionBridge";
import { createInMemoryDeviceKeyStore, type RemoteDeviceKeyStore } from "./remotePairingClient";
import {
  createFakeRemoteServer,
  createTestHostKey,
  fingerprintFromPem,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
} from "./remoteConnectionFixtures";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
  type ClientHostRegistration,
} from "./hostFederationRegistry";
import {
  createHostFederationTransports,
  federatedEntityRefsCollide,
  globalEntityReference,
  routeToOwningHost,
  type FederatedHostTransportSlot,
  type HostFederationTransportFactory,
} from "./hostFederationTransports";
import { PLATFORM_LISTENER_TRUST } from "./remoteListenerTrust";

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

function createFakeBridge(
  hostId: string,
  displayName: string,
): RemoteSessionBridge & {
  readonly setState: (next: RemoteSessionBridgeState) => void;
} {
  let state: RemoteSessionBridgeState = { kind: "idle" };
  const listeners = new Set<(next: RemoteSessionBridgeState) => void>();
  const connection = {
    authenticatedFetch: vi.fn(async () => new Response("{}", { status: 200 })),
    disconnect: vi.fn(),
    state: () => "ready" as const,
    session: () => undefined,
  };
  return {
    getState: () => state,
    setState: (next) => {
      state = next;
      for (const listener of listeners) listener(state);
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
    reconnect: vi.fn(),
    disconnect: vi.fn(() => {
      state = { kind: "idle" };
      for (const listener of listeners) listener(state);
    }),
    connection: vi.fn(() => connection as never),
  };
}

function createFactory(
  bridges: Map<string, ReturnType<typeof createFakeBridge>>,
): HostFederationTransportFactory {
  return {
    createRemoteBridge: (registration) => {
      const existing = bridges.get(registration.hostId);
      if (existing !== undefined) return existing;
      const bridge = createFakeBridge(registration.hostId, registration.displayName);
      bridges.set(registration.hostId, bridge);
      return bridge;
    },
  };
}

describe("HostFederationTransports (Post-preview B2)", () => {
  it("maps enabled hosts to concurrent transport slots keyed by hostId", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
          deviceId: "device-a",
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_B),
        displayName: "Laptop",
        origin: "https://laptop.tailnet:8443",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
          deviceId: "device-b",
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });

    await transports.syncEnabledHosts();

    const slots = transports.list();
    expect(slots.map((slot) => slot.hostId)).toEqual([LOCAL_HOST_ID, HOST_A, HOST_B]);
    expect(transports.get(LOCAL_HOST_ID)?.kind).toBe("local");
    expect(transports.get(HOST_A)?.kind).toBe("remote");
    expect(transports.get(HOST_B)?.kind).toBe("remote");
    expect(transports.get(HOST_A)?.state.kind).toBe("ready");
    expect(transports.get(HOST_B)?.state.kind).toBe("ready");
    expect(bridges.get(HOST_A)?.resume).toHaveBeenCalledWith("https://studio.tailnet:8443");
    expect(bridges.get(HOST_B)?.resume).toHaveBeenCalledWith("https://laptop.tailnet:8443");
  });

  it("skips disabled remotes and keeps This Mac when present", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        enabled: false,
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_B),
        displayName: "Laptop",
        origin: "https://laptop.tailnet:8443",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();

    expect(transports.list().map((slot) => slot.hostId)).toEqual([LOCAL_HOST_ID, HOST_B]);
    expect(transports.get(HOST_A)).toBeUndefined();
  });

  it("keeps entity refs with identical entityId distinct across hosts", () => {
    const projectId = "project-shared-name";
    const onA = globalEntityReference(HOST_A, projectId);
    const onB = globalEntityReference(HOST_B, projectId);
    expect(onA).toEqual(decodeGlobalEntityReference({ hostId: HOST_A, entityId: projectId }));
    expect(onB.entityId).toBe(onA.entityId);
    expect(onA.hostId).not.toBe(onB.hostId);
    expect(federatedEntityRefsCollide(onA, onB)).toBe(false);
    expect(federatedEntityRefsCollide(onA, globalEntityReference(HOST_A, projectId))).toBe(true);
  });

  it("isolates transport failure: revoking one host does not clear other sessions", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_B),
        displayName: "Laptop",
        origin: "https://laptop.tailnet:8443",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();

    const studioBridge = bridges.get(HOST_A)!;
    const laptopBridge = bridges.get(HOST_B)!;

    await transports.disconnectHost(HOST_A);

    expect(studioBridge.disconnect).toHaveBeenCalled();
    expect(laptopBridge.disconnect).not.toHaveBeenCalled();
    expect(transports.get(HOST_A)).toBeUndefined();
    expect(transports.get(HOST_B)?.state.kind).toBe("ready");
    expect(transports.get(LOCAL_HOST_ID)).toBeDefined();
  });

  it("routes commands only to the owning or selected host transport", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_B),
        displayName: "Laptop",
        origin: "https://laptop.tailnet:8443",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();

    const called: string[] = [];
    const result = await routeToOwningHost({
      transports,
      ref: globalEntityReference(HOST_B, "thread-1"),
      execute: async (slot) => {
        called.push(slot.hostId);
        return `ok:${slot.hostId}`;
      },
    });

    expect(result).toBe(`ok:${HOST_B}`);
    expect(called).toEqual([HOST_B]);
  });

  it("rejects routing when the owning host has no transport", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(new Map()),
    });
    await transports.syncEnabledHosts();

    await expect(
      routeToOwningHost({
        transports,
        ref: globalEntityReference(HOST_A, "missing"),
        execute: async () => "nope",
      }),
    ).rejects.toThrow(/no transport/i);
  });

  it("rejects routing when the owning host transport is not ready", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();
    bridges.get(HOST_A)!.setState({
      kind: "stale",
      hostId: HOST_A,
      displayName: "Studio",
    });

    await expect(
      routeToOwningHost({
        transports,
        ref: globalEntityReference(HOST_A, "thread-1"),
        action: "mutate-thread",
        execute: async () => "nope",
      }),
    ).rejects.toThrow(/stale \(read-only\)|not queued/i);
  });

  it("fan-out uses allSettled isolation so one host failure does not reject others", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_B),
        displayName: "Laptop",
        origin: "https://laptop.tailnet:8443",
        credential: {
          keyId: "key-b",
          credentialGeneration: 1,
          hostKeyFingerprint: "b".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();

    const settled = await transports.fanOut(async (slot: FederatedHostTransportSlot) => {
      if (slot.hostId === HOST_A) {
        throw new Error("Studio offline");
      }
      return { hostId: slot.hostId, value: 1 };
    });

    const studio = settled.find((entry) => entry.hostId === HOST_A);
    const laptop = settled.find((entry) => entry.hostId === HOST_B);
    const local = settled.find((entry) => entry.hostId === LOCAL_HOST_ID);

    expect(studio?.status).toBe("rejected");
    expect(laptop).toEqual({
      hostId: HOST_B,
      status: "fulfilled",
      value: { hostId: HOST_B, value: 1 },
    });
    expect(local?.status).toBe("fulfilled");
    // Laptop and local remain listed even though Studio failed.
    expect(transports.get(HOST_B)?.state.kind).toBe("ready");
    expect(transports.get(HOST_A)?.state.kind).toBe("ready");
  });

  it("exposes authenticated remote transport ports keyed by hostId", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();

    const remote = transports.remoteTransportFor(HOST_A);
    expect(remote?.hostId).toBe(HOST_A);
    expect(remote?.authenticatedFetch).toBeTypeOf("function");
    expect(transports.remoteTransportFor(LOCAL_HOST_ID)).toBeUndefined();
    expect(transports.remoteTransportFor(HOST_B)).toBeUndefined();
  });

  it("does not remove local when syncing after remote removals", async () => {
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: "https://studio.tailnet:8443",
        credential: {
          keyId: "key-a",
          credentialGeneration: 1,
          hostKeyFingerprint: "a".repeat(64),
        },
      }),
    );

    const bridges = new Map();
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore: {} as RemoteDeviceKeyStore,
      factory: createFactory(bridges),
    });
    await transports.syncEnabledHosts();
    await registry.removeRemote(HOST_A);
    await transports.syncEnabledHosts();

    expect(transports.list().map((slot) => slot.hostId)).toEqual([LOCAL_HOST_ID]);
    expect(bridges.get(HOST_A)?.disconnect).toHaveBeenCalled();
  });

  it.each([
    ["whose hello does not verify", "forged"],
    ["that replays a genuine hello recorded from an earlier request", "replayed"],
  ] as const)("refuses a paired host %s, keeping the pairing", async (_label, answer) => {
    // The desktop window reaches other hosts through these transports and the
    // production session bridge, so this drives the real verification path.
    const forger = createTestHostKey();
    let recorded: Record<string, unknown> | undefined;
    const server = createFakeRemoteServer({
      hostId: HOST_A,
      tamperHello: (hello) =>
        answer === "forged" ? { ...hello, signature: forger.sign("forged") } : (recorded ?? hello),
    });
    if (answer === "replayed") {
      recorded = await (
        await server.fetch(`${ORIGIN}/api/remote/hello?clientNonce=${"r".repeat(43)}`)
      ).json();
    }
    const deviceKeyStore = createInMemoryDeviceKeyStore();
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`;
    const deviceId = "33333333-3333-4333-8333-333333333333";
    server.registerDevice({ deviceId, publicKeyPem: pem, fingerprint: fingerprintFromPem(pem) });
    const keyId = await deviceKeyStore.set(keyPair, {
      origin: ORIGIN,
      hostId: decodeStableHostId(HOST_A),
      deviceId,
    });
    await deviceKeyStore.updateMetadata(keyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });
    const registry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());
    await registry.upsertRemote(
      remoteHost({
        hostId: decodeHostId(HOST_A),
        displayName: "Studio",
        origin: ORIGIN,
        credential: {
          keyId,
          credentialGeneration: 1,
          hostKeyFingerprint: HOST_KEY_FINGERPRINT,
          deviceId,
        },
      }),
    );
    const transports = createHostFederationTransports({
      registry,
      deviceKeyStore,
      fetch: server.fetch,
    });

    await transports.syncEnabledHosts();
    await vi.waitFor(() => expect(transports.get(HOST_A)?.state.kind).toBe("unavailable"));

    expect(transports.get(HOST_A)?.state).toMatchObject({
      kind: "unavailable",
      reason: "This host could not prove its identity, so Octant did not connect.",
    });
    expect(transports.remoteTransportFor(HOST_A)).toBeUndefined();
    await expect(deviceKeyStore.get(keyId)).resolves.toBeDefined();
    transports.disconnectAll();
  });

  it("globalEntityReference rejects empty entity ids via contracts", () => {
    expect(() => globalEntityReference(HOST_A, "")).toThrow();
    expect(decodeEntityId("thread-9")).toBe("thread-9");
  });
});
