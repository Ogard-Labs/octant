import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { decodeHostId } from "@octant/contracts/host";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  createClientHostRegistry,
  createInMemoryClientHostRegistryStorage,
  createInMemoryDeviceKeyStore,
  createRemotePairingClient,
  createRemoteSessionBridge,
  type RemotePairingClient,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "../../../../packages/client-runtime/src/remoteConnectionFixtures";
import { useRemotePairing } from "./useRemotePairing";

const hostId = decodeStableHostId(HOST_ID);
const deviceId = "22222222-2222-4222-8222-222222222222";

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

function createIdleClient(): RemotePairingClient {
  return {
    requestHostHello: vi.fn(async () => {
      throw new Error("pairing hello must not be requested during resume");
    }),
    claimPairing: vi.fn(async () => {
      throw new Error("pairing claim must not run during resume");
    }),
    pollPairingStatus: vi.fn(async () => {
      throw new Error("pairing status poll must not run during resume");
    }),
    removeDeviceKey: vi.fn(async () => undefined),
  };
}

async function seedApprovedDevice(
  server: ReturnType<typeof createFakeRemoteServer>,
  store: ReturnType<typeof createInMemoryDeviceKeyStore>,
  config: Parameters<typeof createFakeRemoteServer>[0] = {},
): Promise<void> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  server.registerDevice({
    deviceId,
    publicKeyPem: pem,
    fingerprint: fingerprintFromPem(pem),
  });
  const deviceKeyId = await store.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  await store.updateMetadata(deviceKeyId, {
    deviceId,
    credentialGeneration: 1,
    hostKeyFingerprint: "a".repeat(64),
  });
}

describe("useRemotePairing resume", () => {
  it("rehydrates a paired profile to ready on a fresh page without re-pairing", async () => {
    const server = createFakeRemoteServer({});
    const store = createInMemoryDeviceKeyStore();
    await seedApprovedDevice(server, store);
    const client = createIdleClient();
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });

    const { result } = renderHook(() =>
      useRemotePairing({ baseUrl: ORIGIN, client, sessionClient: bridge }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("resumed"));
    expect(server.issuedSessionId()).toBeDefined();
    const pairingCalls = vi
      .mocked(server.fetch)
      .mock.calls.filter(([input]) => String(input).includes("/api/remote/pairing"));
    expect(pairingCalls).toHaveLength(0);
  });

  it("surfaces an explicit lost-key state and a re-pair path when the key is gone", async () => {
    const server = createFakeRemoteServer({});
    const store = createInMemoryDeviceKeyStore();
    await seedApprovedDevice(server, store);
    vi.spyOn(store, "get").mockResolvedValue(undefined);
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });

    const { result } = renderHook(() =>
      useRemotePairing({ baseUrl: ORIGIN, client: createIdleClient(), sessionClient: bridge }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("failed"));
    expect(result.current.screen).toMatchObject({ category: "lost-key" });

    act(() => result.current.reset());
    expect(result.current.screen.kind).toBe("entry");
  });

  it.each([
    ["revoked", { credentialFailure: "revoked" as const }],
    ["expired", { credentialFailure: "expired" as const }],
  ] as const)(
    "surfaces an explicit %s re-pair state when the server reports the reason",
    async (reason, config) => {
      const server = createFakeRemoteServer(config);
      const store = createInMemoryDeviceKeyStore();
      await seedApprovedDevice(server, store);
      const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });

      const { result } = renderHook(() =>
        useRemotePairing({ baseUrl: ORIGIN, client: createIdleClient(), sessionClient: bridge }),
      );

      await waitFor(() => expect(result.current.screen.kind).toBe("failed"));
      expect(result.current.screen).toMatchObject({ category: reason });
    },
  );

  it("surfaces an explicit recovery state when the server rejects without a reason", async () => {
    // Production revocation/expiry is reported as a generic unauthorized
    // rejection (remote redaction contract); the client must still fail
    // explicitly with a re-pair path instead of returning to the entry screen.
    const server = createFakeRemoteServer({ revoked: true });
    const store = createInMemoryDeviceKeyStore();
    await seedApprovedDevice(server, store);
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });

    const { result } = renderHook(() =>
      useRemotePairing({ baseUrl: ORIGIN, client: createIdleClient(), sessionClient: bridge }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("failed"));
    expect(result.current.screen).toMatchObject({ category: "recovery-required" });

    act(() => result.current.reset());
    expect(result.current.screen.kind).toBe("entry");
  });

  it("does not resume when a fresh pairing ticket is present", async () => {
    const server = createFakeRemoteServer({});
    const store = createInMemoryDeviceKeyStore();
    await seedApprovedDevice(server, store);
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: store });
    const resumeSpy = vi.spyOn(bridge, "resume");

    const { result } = renderHook(() =>
      useRemotePairing({
        baseUrl: ORIGIN,
        client: createIdleClient(),
        sessionClient: bridge,
        ticket: { ticketId: TICKET_ID, ticketProof: "ticket_proof_1234567890" },
      }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("requesting-hello"));
    expect(resumeSpy).not.toHaveBeenCalled();
  });

  it("retries approved-claim persistence without reusing the pairing ticket", async () => {
    const claim = {
      ticketId: TICKET_ID,
      hostId,
      hostDisplayName: "This Mac",
      hostKeyFingerprint: "a".repeat(64),
      origin: ORIGIN,
      comparisonCode: "123456",
      deviceKeyFingerprint: "b".repeat(64),
      deviceKeyId: "00000000-0000-4000-8000-000000000003",
      deviceLabel: "Browser",
      sourceClass: "lan-private",
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as Awaited<ReturnType<RemotePairingClient["claimPairing"]>>;
    const hostHello = {
      productId: "octant",
      hostId,
      displayName: "This Mac",
      hostKeyFingerprint: "a".repeat(64),
      serverBuildVersion: "0.1.0",
      supportedProtocolRange: { min: 1, max: 1 },
      authenticationProtocolVersions: [1],
      securityFloor: 1,
      remoteOrigin: ORIGIN,
      nonce: "nonce1234567890",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: "sig_123",
    } as unknown as Awaited<ReturnType<RemotePairingClient["requestHostHello"]>>;
    const pollPairingStatus = vi
      .fn<RemotePairingClient["pollPairingStatus"]>()
      .mockResolvedValueOnce({
        kind: "failed",
        category: "unavailable",
        message: "This browser could not save the approved device; retry to finish pairing.",
        retryable: true,
      })
      .mockResolvedValue({ kind: "pending", claim });
    const client: RemotePairingClient = {
      requestHostHello: vi.fn(async () => hostHello),
      claimPairing: vi.fn(async () => claim),
      pollPairingStatus,
      removeDeviceKey: vi.fn(async () => undefined),
    };
    const sessionClient = {
      getState: () => ({ kind: "idle" as const }),
      subscribe: () => () => undefined,
      connect: vi.fn(),
      resume: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      connection: () => undefined,
      forgetDeviceKey: vi.fn(async () => undefined),
      stageDeviceKeyRotation: vi.fn(async () => {
        throw new Error("Device key rotation is not part of this test double.");
      }),
    } as unknown as RemoteSessionBridge;
    const { result } = renderHook(() =>
      useRemotePairing({
        baseUrl: ORIGIN,
        ticket: { ticketId: TICKET_ID, ticketProof: "ticket_proof_1234567890" },
        client,
        sessionClient,
      }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("confirm"));
    act(() => result.current.confirmPairing("Browser"));
    await waitFor(() => expect(result.current.screen.kind).toBe("failed"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.screen.kind).toBe("waiting"));
    expect(pollPairingStatus).toHaveBeenCalledTimes(2);
    expect(pollPairingStatus.mock.calls[1]?.[0].ticket.ticketId).toBe(TICKET_ID);
    expect(pollPairingStatus.mock.calls[1]?.[0].claim).toBe(claim);
  });

  it("writes the approved host into the federation registry", async () => {
    const claim = {
      ticketId: TICKET_ID,
      hostId,
      hostDisplayName: "Studio",
      hostKeyFingerprint: "a".repeat(64),
      origin: ORIGIN,
      comparisonCode: "123456",
      deviceKeyFingerprint: "b".repeat(64),
      deviceKeyId: "00000000-0000-4000-8000-000000000003",
      deviceLabel: "Browser",
      sourceClass: "lan-private",
      claimedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as Awaited<ReturnType<RemotePairingClient["claimPairing"]>>;
    const hostHello = {
      productId: "octant",
      hostId,
      displayName: "Studio",
      hostKeyFingerprint: "a".repeat(64),
      serverBuildVersion: "0.1.0",
      supportedProtocolRange: { min: 1, max: 1 },
      authenticationProtocolVersions: [1],
      securityFloor: 1,
      remoteOrigin: ORIGIN,
      nonce: "nonce1234567890",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signature: "sig_123",
    } as unknown as Awaited<ReturnType<RemotePairingClient["requestHostHello"]>>;
    const approval = {
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId: claim.deviceKeyId,
      origin: ORIGIN,
    };
    const client: RemotePairingClient = {
      requestHostHello: vi.fn(async () => hostHello),
      claimPairing: vi.fn(async () => claim),
      pollPairingStatus: vi.fn(async () => ({ kind: "approved" as const, approval })),
      removeDeviceKey: vi.fn(async () => undefined),
    };
    const sessionClient = {
      getState: () => ({ kind: "idle" as const }),
      subscribe: () => () => undefined,
      connect: vi.fn(),
      resume: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      connection: () => undefined,
      forgetDeviceKey: vi.fn(async () => undefined),
      stageDeviceKeyRotation: vi.fn(async () => {
        throw new Error("Device key rotation is not part of this test double.");
      }),
    } as unknown as RemoteSessionBridge;
    const hostRegistry = createClientHostRegistry(createInMemoryClientHostRegistryStorage());

    const { result } = renderHook(() =>
      useRemotePairing({
        baseUrl: ORIGIN,
        ticket: { ticketId: TICKET_ID, ticketProof: "ticket_proof_1234567890" },
        client,
        sessionClient,
        hostRegistry,
      }),
    );

    await waitFor(() => expect(result.current.screen.kind).toBe("confirm"));
    act(() => result.current.confirmPairing("Browser"));
    await waitFor(() => expect(result.current.screen.kind).toBe("approved"));

    const remote = await hostRegistry.get(HOST_ID);
    expect(remote).toMatchObject({
      hostId: decodeHostId(HOST_ID),
      kind: "remote",
      displayName: "Studio",
      origin: ORIGIN,
      enabled: true,
      credential: {
        keyId: claim.deviceKeyId,
        credentialGeneration: 1,
        hostKeyFingerprint: "a".repeat(64),
        deviceId,
      },
    });
    expect(sessionClient.connect).toHaveBeenCalledWith(approval);
  });
});
