import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createInMemoryDeviceKeyStore,
  createRemotePairingClient,
  readPairingFragment,
  parseTypedPairingCode,
  RemotePairingFailure,
} from "./remotePairingClient";
import { decodeStableHostId } from "@octant/contracts/remote-access";

const hostId = "11111111-1111-4111-8111-111111111111";
const ticketId = "00000000-0000-4000-8000-000000000001";
const ticketProof = "proof1234567890abcdefghijklmnopqrstuvwxyz";
const serverBaseUrl = "https://mac.example.test";

const hostHello = {
  productId: "octant" as const,
  hostId,
  displayName: "This Mac",
  hostKeyFingerprint: "a".repeat(64),
  serverBuildVersion: "0.1.0",
  supportedProtocolRange: { min: 1, max: 1 },
  authenticationProtocolVersions: [1],
  securityFloor: 1,
  remoteOrigin: serverBaseUrl,
  nonce: "nonce1234567890",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  signature: "sig_123",
};

const pairingClaim = {
  kind: "pending" as const,
  ticketId,
  hostId,
  deviceLabel: "Ada's Safari",
  deviceKeyFingerprint: "b".repeat(64),
  origin: serverBaseUrl,
  sourceClass: "lan-private" as const,
  comparisonCode: "123456",
  claimedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
};

function hostHelloFetch(): ReturnType<typeof globalThis.fetch> {
  return Promise.resolve(Response.json(hostHello));
}

function pairingClaimFetch(): ReturnType<typeof globalThis.fetch> {
  return Promise.resolve(Response.json(pairingClaim));
}

function pairingStatusApprovedFetch(): ReturnType<typeof globalThis.fetch> {
  return Promise.resolve(
    Response.json({
      status: "approved",
      deviceId: "00000000-0000-4000-8000-000000000002",
      credentialGeneration: 1,
    }),
  );
}

function createMockFetch(
  responses: ReadonlyArray<() => ReturnType<typeof globalThis.fetch>>,
): Mock<typeof globalThis.fetch> {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[index] ?? hostHelloFetch;
    index += 1;
    return response();
  });
}

describe("RemotePairingClient", () => {
  it("persists and looks up only non-secret known-device facts", async () => {
    const store = createInMemoryDeviceKeyStore();
    const keyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const keyId = await store.set(keyPair, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });

    await store.updateMetadata(keyId, {
      deviceId: "00000000-0000-4000-8000-000000000002",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });

    await expect(store.findByOrigin(serverBaseUrl)).resolves.toEqual({
      keyId,
      origin: serverBaseUrl,
      hostId,
      deviceId: "00000000-0000-4000-8000-000000000002",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    expect(JSON.stringify(await store.findByOrigin(serverBaseUrl))).not.toContain("privateKey");
  });

  it("replaces older device registrations for the same origin after approval", async () => {
    const store = createInMemoryDeviceKeyStore();
    const first = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const second = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const firstId = await store.set(first, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });
    const secondId = await store.set(second, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });

    await store.updateMetadata(firstId, {
      deviceId: "00000000-0000-4000-8000-000000000003",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    await store.updateMetadata(secondId, {
      deviceId: "00000000-0000-4000-8000-000000000004",
      credentialGeneration: 2,
      hostKeyFingerprint: "b".repeat(64),
    });
    await store.removeOtherApprovedForOrigin(serverBaseUrl, secondId);

    await expect(store.get(firstId)).resolves.toBeUndefined();
    await expect(store.findByOrigin(serverBaseUrl)).resolves.toMatchObject({
      keyId: secondId,
      deviceId: "00000000-0000-4000-8000-000000000004",
    });
  });

  it("keeps pending pairing claims when replacing approved registrations", async () => {
    const store = createInMemoryDeviceKeyStore();
    const first = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pending = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const fresh = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const firstId = await store.set(first, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });
    const pendingId = await store.set(pending, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });
    const freshId = await store.set(fresh, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });

    await store.updateMetadata(firstId, {
      deviceId: "00000000-0000-4000-8000-000000000003",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    await store.updateMetadata(freshId, {
      deviceId: "00000000-0000-4000-8000-000000000005",
      credentialGeneration: 1,
      hostKeyFingerprint: "c".repeat(64),
    });
    // The pending claim has no approved metadata yet; a concurrent approval in
    // another tab must not destroy its still-unapproved key record.
    await store.removeOtherApprovedForOrigin(serverBaseUrl, freshId);

    await expect(store.get(firstId)).resolves.toBeUndefined();
    await expect(store.get(pendingId)).resolves.toBeDefined();
    await expect(store.get(freshId)).resolves.toBeDefined();
  });

  it("prefers the most recently stored registration when multiple exist", async () => {
    const store = createInMemoryDeviceKeyStore();
    const stale = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const fresh = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const staleId = await store.set(stale, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });
    const freshId = await store.set(fresh, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
    });

    await store.updateMetadata(staleId, {
      deviceId: "00000000-0000-4000-8000-000000000003",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    await store.updateMetadata(freshId, {
      deviceId: "00000000-0000-4000-8000-000000000005",
      credentialGeneration: 1,
      hostKeyFingerprint: "c".repeat(64),
    });

    await expect(store.findByOrigin(serverBaseUrl)).resolves.toMatchObject({
      keyId: freshId,
      deviceId: "00000000-0000-4000-8000-000000000005",
    });
  });

  it("reads a pairing ticket from a URL fragment", () => {
    const href = `https://mac.example.test/#ticketId=${ticketId}&ticketProof=${ticketProof}`;
    const ticket = readPairingFragment(href);
    expect(ticket).toEqual({ ticketId, ticketProof });
  });

  it("ignores non-pairing URL fragments", () => {
    const href = "https://mac.example.test/#launchToken=abc123";
    expect(readPairingFragment(href)).toBeUndefined();
  });

  it("parses a pasted pairing link as a typed code", () => {
    const href = `https://mac.example.test/#ticketId=${ticketId}&ticketProof=${ticketProof}`;
    expect(parseTypedPairingCode(href)).toEqual({ ticketId, ticketProof });
  });

  it("requests a host hello before claiming a ticket", async () => {
    const fetch = createMockFetch([hostHelloFetch, pairingClaimFetch]);
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: createInMemoryDeviceKeyStore(),
    });

    const hello = await client.requestHostHello();
    expect(hello.hostId).toBe(hostId);
    expect(fetch).toHaveBeenCalledWith("https://mac.example.test/api/remote/hello", {
      method: "GET",
    });

    const claim = await client.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });

    expect(claim.comparisonCode).toBe("123456");
    const [_, claimCall] = fetch.mock.calls;
    expect(claimCall?.[0]).toBe("https://mac.example.test/api/remote/pairing");
    expect(claimCall?.[1]?.method).toBe("POST");
    const body = JSON.parse(String(claimCall?.[1]?.body));
    expect(body.ticketId).toBe(ticketId);
    expect(body.ticketProof).toBe(ticketProof);
    expect(body.hostHelloNonce).toBe(hostHello.nonce);
    expect(body.deviceKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(body.devicePublicKey).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(body.origin).toBe(serverBaseUrl);
    expect(body.clientHello.webBuildVersion).toBe("0.1.0");
  });

  it("polls pairing status and returns an approved result", async () => {
    const store = createInMemoryDeviceKeyStore();
    const fetch = createMockFetch([hostHelloFetch, pairingClaimFetch, pairingStatusApprovedFetch]);
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: store,
    });

    const hello = await client.requestHostHello();
    const claim = await client.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });
    const status = await client.pollPairingStatus({
      ticket: { ticketId, ticketProof },
      claim,
    });

    expect(status.kind).toBe("approved");
    if (status.kind !== "approved") throw new Error("unexpected status");
    expect(status.approval.deviceId).toBe("00000000-0000-4000-8000-000000000002");
    expect(status.approval.credentialGeneration).toBe(1);
    await expect(store.findByOrigin(serverBaseUrl)).resolves.toMatchObject({
      deviceId: "00000000-0000-4000-8000-000000000002",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
  });

  it("fails closed when the approved key disappears before origin replacement", async () => {
    const store = createInMemoryDeviceKeyStore();
    const previousKeyPair = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const previousKeyId = await store.set(previousKeyPair, {
      origin: serverBaseUrl,
      hostId: decodeStableHostId(hostId),
      deviceId: "00000000-0000-4000-8000-000000000003",
    });
    await store.updateMetadata(previousKeyId, {
      deviceId: "00000000-0000-4000-8000-000000000003",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const fetch = createMockFetch([hostHelloFetch, pairingClaimFetch, pairingStatusApprovedFetch]);
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: store,
    });
    const hello = await client.requestHostHello();
    const claim = await client.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });
    const removeOther = store.removeOtherApprovedForOrigin.bind(store);
    vi.spyOn(store, "removeOtherApprovedForOrigin").mockImplementation(
      async (origin, keepKeyId) => {
        await store.remove(keepKeyId);
        await removeOther(origin, keepKeyId);
      },
    );

    await expect(
      client.pollPairingStatus({ ticket: { ticketId, ticketProof }, claim }),
    ).resolves.toEqual({
      kind: "failed",
      category: "unavailable",
      message: "This browser could not save the approved device; retry to finish pairing.",
      retryable: true,
    });
    await expect(store.get(previousKeyId)).resolves.toBeDefined();
  });

  it("fails closed when the approved device key is lost before status polling", async () => {
    const fetch = createMockFetch([hostHelloFetch, pairingClaimFetch, pairingStatusApprovedFetch]);
    const store = createInMemoryDeviceKeyStore();
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: store,
    });

    const hello = await client.requestHostHello();
    const claim = await client.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });
    await store.remove(claim.deviceKeyId);

    await expect(
      client.pollPairingStatus({ ticket: { ticketId, ticketProof }, claim }),
    ).resolves.toEqual({
      kind: "failed",
      category: "unavailable",
      message: "This browser lost its approved device key; pair it again.",
    });
  });

  it("fails closed when the host hello does not match the server origin", async () => {
    const mismatchedHello = { ...hostHello, remoteOrigin: "https://other.test" };
    const fetch = createMockFetch([() => Promise.resolve(Response.json(mismatchedHello))]);
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: createInMemoryDeviceKeyStore(),
    });

    await expect(client.requestHostHello()).rejects.toBeInstanceOf(RemotePairingFailure);
  });

  it("generates a non-extractable P-256 device key", async () => {
    const store = createInMemoryDeviceKeyStore();
    const fetch = createMockFetch([hostHelloFetch, pairingClaimFetch]);
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: store,
    });

    const hello = await client.requestHostHello();
    const claim = await client.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });

    const keyPair = await store.get(claim.deviceKeyId);
    expect(keyPair).toBeDefined();
    if (keyPair === undefined) throw new Error("device key not stored");
    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.publicKey.algorithm).toMatchObject({
      name: "ECDSA",
      namedCurve: "P-256",
    });
  });

  it("removes the device key after a failed claim", async () => {
    const server = createMockRemotePairingServer();
    const store = createInMemoryDeviceKeyStore();
    const setSpy = vi.spyOn(store, "set");
    const removeSpy = vi.spyOn(store, "remove");
    const client = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch: server.fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: store,
    });

    const hello = await client.requestHostHello();
    server.setIsClaimed(true);

    await expect(
      client.claimPairing({
        ticket: { ticketId, ticketProof },
        deviceLabel: "Ada's Safari",
        hostHello: hello,
      }),
    ).rejects.toBeInstanceOf(RemotePairingFailure);

    expect(setSpy).toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    const keyId = removeSpy.mock.calls[0]?.[0];
    expect(keyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await store.get(keyId!)).toBeUndefined();
  });

  it("supports two browser profiles with isolated device keys on one ticket", async () => {
    const server = createMockRemotePairingServer();
    const storeA = createInMemoryDeviceKeyStore();
    const storeB = createInMemoryDeviceKeyStore();
    const clientA = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch: server.fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: storeA,
    });
    const clientB = createRemotePairingClient({
      baseUrl: serverBaseUrl,
      fetch: server.fetch,
      webBuildVersion: "0.1.0",
      deviceKeyStore: storeB,
    });

    const hello = await clientA.requestHostHello();

    const claimA = await clientA.claimPairing({
      ticket: { ticketId, ticketProof },
      deviceLabel: "Ada's Safari",
      hostHello: hello,
    });
    expect(claimA.comparisonCode).toBe("123456");
    const keyA = await storeA.get(claimA.deviceKeyId);
    expect(keyA).toBeDefined();

    const setSpyB = vi.spyOn(storeB, "set");
    const removeSpyB = vi.spyOn(storeB, "remove");

    await expect(
      clientB.claimPairing({
        ticket: { ticketId, ticketProof },
        deviceLabel: "Ada's Chrome",
        hostHello: hello,
      }),
    ).rejects.toBeInstanceOf(RemotePairingFailure);

    expect(setSpyB).toHaveBeenCalled();
    expect(removeSpyB).toHaveBeenCalledTimes(1);
    const keyB = removeSpyB.mock.calls[0]?.[0];
    expect(keyB).toMatch(/^[0-9a-f-]{36}$/);
    expect(await storeB.get(keyB!)).toBeUndefined();

    server.setPairingStatus("approved");
    const statusA = await clientA.pollPairingStatus({
      ticket: { ticketId, ticketProof },
      claim: claimA,
    });
    expect(statusA.kind).toBe("approved");
    if (statusA.kind !== "approved") throw new Error("unexpected status");
    expect(statusA.approval.deviceId).toBe("00000000-0000-4000-8000-000000000002");

    const keyAAfter = await storeA.get(claimA.deviceKeyId);
    expect(keyAAfter).toBeDefined();
  });
});

function createMockRemotePairingServer() {
  let isClaimed = false;
  let status: "pending" | "approved" | "denied" | "expired" = "pending";

  return {
    setIsClaimed(value: boolean) {
      isClaimed = value;
    },
    setPairingStatus(next: "pending" | "approved" | "denied" | "expired") {
      status = next;
    },
    fetch: vi.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/remote/hello") {
        return Response.json(hostHello);
      }
      if (url.pathname === "/api/remote/pairing" && init?.method === "POST") {
        if (isClaimed) {
          return new Response(
            JSON.stringify({ category: "unauthorized", message: "Ticket already claimed." }),
            { status: 401, headers: { "content-type": "application/json" } },
          );
        }
        isClaimed = true;
        return Response.json(pairingClaim);
      }
      if (url.pathname === "/api/remote/pairing/status" && init?.method === "POST") {
        if (status === "approved") {
          return Response.json({
            status: "approved",
            deviceId: "00000000-0000-4000-8000-000000000002",
            credentialGeneration: 1,
          });
        }
        if (status === "denied" || status === "expired") {
          return Response.json({ status: "failed" });
        }
        return Response.json({ status: "pending" });
      }
      return new Response("Not found", { status: 404 });
    }) as Mock<typeof globalThis.fetch>,
  };
}
