import { describe, expect, it, vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function registerWebCryptoDevice(
  server: ReturnType<typeof createFakeRemoteServer>,
  store: ReturnType<typeof createInMemoryDeviceKeyStore>,
): Promise<{ deviceKeyId: string; deviceId: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pem = await pemFromPublicKey(keyPair.publicKey);
  const deviceId = "22222222-2222-4222-8222-222222222222";
  server.registerDevice({
    deviceId,
    publicKeyPem: pem,
    fingerprint: fingerprintFromPem(pem),
  });
  const deviceKeyId = await store.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  return { deviceKeyId, deviceId };
}

describe("RemoteSessionBridge", () => {
  it("starts in the idle state", () => {
    const bridge = createRemoteSessionBridge();
    expect(bridge.getState()).toEqual({ kind: "idle" });
  });

  it("wires pairing approval through connecting to ready via RemoteConnection", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });
    const states: ReturnType<typeof bridge.getState>[] = [];
    bridge.subscribe((state) => states.push(state));

    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
    });

    await waitUntil(() => bridge.getState().kind === "ready");
    expect(bridge.connection()?.session()).toBeDefined();
    expect(states.some((state) => state.kind === "connecting")).toBe(true);
    expect(states.some((state) => state.kind === "authenticating")).toBe(true);
    expect(bridge.getState()).toMatchObject({
      kind: "ready",
      hostId: HOST_ID,
      displayName: "This Mac",
    });
  });

  it("maps incompatible protocol failures", async () => {
    const server = createFakeRemoteServer({ incompatibleProtocol: true });
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
    });

    await waitUntil(() => bridge.getState().kind === "incompatible");
    expect(bridge.connection()).toBeUndefined();
  });

  it("resets to idle on disconnect", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
    });
    await waitUntil(() => bridge.getState().kind === "ready");
    bridge.disconnect();
    expect(bridge.getState()).toEqual({ kind: "idle" });
  });

  it("reconnects from stale without re-pairing", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
    });
    await waitUntil(() => bridge.getState().kind === "ready");
    bridge.connection()?.disconnect();
    await waitUntil(() => bridge.getState().kind === "stale");

    bridge.reconnect();
    await waitUntil(() => bridge.getState().kind === "ready");
  });

  it("rehydrates a known device on a fresh bridge without pairing", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "ready");
    expect(server.fetch).not.toHaveBeenCalledWith(
      "https://mac.example.test/api/remote/pairing",
      expect.anything(),
    );
    expect(bridge.getState()).toMatchObject({ kind: "ready", hostId: HOST_ID });
    expect(deviceId).toBeDefined();
  });

  it("fails closed when a resumed endpoint presents a different host key", async () => {
    const server = createFakeRemoteServer({ hostKeyFingerprint: "c".repeat(64) });
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unauthorized");
    expect(bridge.getState()).toMatchObject({ kind: "unauthorized", reasonCode: "host-changed" });
  });

  it.each([
    ["lost-key", undefined, {}],
    ["revoked", "revoked", { credentialFailure: "revoked" }],
    ["expired", "expired", { credentialFailure: "expired" }],
  ] as const)("surfaces an explicit %s re-pair state", async (reason, failure, config) => {
    const server = createFakeRemoteServer(config);
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId: server.deviceId() ?? "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    if (failure === undefined) {
      vi.spyOn(pairingStore, "get").mockResolvedValue(undefined);
    }
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unauthorized");
    expect(bridge.getState()).toMatchObject({ kind: "unauthorized", reasonCode: reason });
  });

  it("retains the paired key after an ambiguous unauthorized resume failure", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/remote/auth/challenge") {
        return Response.json({ category: "unauthorized" }, { status: 401 });
      }
      return server.fetch(input, init);
    });
    const bridge = createRemoteSessionBridge({
      fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unauthorized");
    expect(bridge.getState()).toMatchObject({ kind: "unauthorized" });
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it("surfaces a revoked registration as a generic rejection without a lifecycle reason", async () => {
    const server = createFakeRemoteServer({ revoked: true });
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unauthorized");
    expect(bridge.getState()).toMatchObject({ kind: "unauthorized" });
    // The rejection carries no lifecycle reason (remote redaction contract),
    // so the key is retained and the failure stays recoverable.
    expect(bridge.getState()).not.toHaveProperty("reasonCode");
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it("forgets the persisted device after an authenticated self-revoke", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });
    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
    });
    await waitUntil(() => bridge.getState().kind === "ready");

    await bridge.forgetDeviceKey();

    await expect(pairingStore.get(deviceKeyId)).resolves.toBeUndefined();
    // A reload after self-revocation must land on the pairing entry, not resume.
    bridge.resume(ORIGIN);
    await waitUntil(() => bridge.getState().kind === "idle");
  });

  it("forgets the persisted device after a resumed session self-revokes", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });
    bridge.resume(ORIGIN);
    await waitUntil(() => bridge.getState().kind === "ready");

    await bridge.forgetDeviceKey();

    await expect(pairingStore.findByOrigin(ORIGIN)).resolves.toBeUndefined();
  });

  it("reports temporary device-store failures without deleting the registration", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    vi.spyOn(pairingStore, "get").mockRejectedValue(new Error("IndexedDB temporarily unavailable"));
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unavailable");
    expect(bridge.getState()).toMatchObject({
      kind: "unavailable",
      reason: "Remote device storage is temporarily unavailable.",
    });
    expect(await pairingStore.findByOrigin(ORIGIN)).toBeDefined();
  });

  it("preserves incompatible resume state for the pairing UI", async () => {
    const server = createFakeRemoteServer({ incompatibleProtocol: true });
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "incompatible");
    expect(bridge.getState()).toMatchObject({ kind: "incompatible" });
  });
});
