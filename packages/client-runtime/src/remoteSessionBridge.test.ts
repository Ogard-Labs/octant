import { describe, expect, it, vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import { localHostDisplayName } from "./localHostDisplayName";
import {
  createFakeRemoteServer,
  createTestHostKey,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";
import { PLATFORM_LISTENER_TRUST } from "./remoteListenerTrust";

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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });

    expect(bridge.getState()).toMatchObject({
      kind: "connecting",
      hostId,
      displayName: "Remote host",
    });
    expect(bridge.getState()).not.toMatchObject({ displayName: localHostDisplayName() });

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

  it("keeps the origin's listener pin when the device key is replaced", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    const listenerTrust = {
      current: { kind: "pinned", pin: `sha256-${"A".repeat(43)}` },
    } as const;
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: pairingStore });
    bridge.connect({
      ticketId: TICKET_ID,
      hostId,
      deviceId,
      credentialGeneration: 1,
      deviceKeyId,
      origin: ORIGIN,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust,
    });
    await waitUntil(() => bridge.getState().kind === "ready");

    const staged = await bridge.stageDeviceKeyRotation();
    await staged.adopt({ credentialGeneration: 2 });

    await expect(pairingStore.findByOrigin(ORIGIN)).resolves.toMatchObject({
      credentialGeneration: 2,
      listenerTrust,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    const states: ReturnType<typeof bridge.getState>[] = [];
    bridge.subscribe((state) => states.push(state));
    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "ready");
    expect(server.fetch).not.toHaveBeenCalledWith(
      "https://mac.example.test/api/remote/pairing",
      expect.anything(),
    );
    expect(
      states.some((state) => state.kind === "connecting" && state.displayName === "Remote host"),
    ).toBe(true);
    expect(
      states.every(
        (state) => !("displayName" in state) || state.displayName !== localHostDisplayName(),
      ),
    ).toBe(true);
    expect(bridge.getState()).toMatchObject({ kind: "ready", hostId: HOST_ID });
    expect(deviceId).toBeDefined();
  });

  it("fails closed when a resumed endpoint presents a different host key", async () => {
    const server = createFakeRemoteServer({ hostKey: createTestHostKey() });
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });
    const bridge = createRemoteSessionBridge({
      fetch: server.fetch,
      deviceKeyStore: pairingStore,
    });

    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unauthorized");
    expect(bridge.getState()).toMatchObject({ kind: "unauthorized", reasonCode: "host-changed" });
    // A validly signed hello from any other key ends nothing by itself: the
    // key stays until the person forgets the host or pairs again.
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  async function resumePairedDevice(config: Parameters<typeof createFakeRemoteServer>[0]) {
    const server = createFakeRemoteServer(config);
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: pairingStore });
    bridge.resume(ORIGIN);
    return { server, pairingStore, deviceKeyId, bridge };
  }

  it("refuses a host whose hello signature does not verify and keeps the pairing", async () => {
    const forger = createTestHostKey();
    const { server, pairingStore, deviceKeyId, bridge } = await resumePairedDevice({
      // States the paired key and fingerprint but signs with a key it holds.
      tamperHello: (hello) => ({ ...hello, signature: forger.sign("forged") }),
    });

    await waitUntil(() => bridge.getState().kind === "unavailable");
    expect(bridge.getState()).toMatchObject({
      kind: "unavailable",
      reason: "This host could not prove its identity, so Octant did not connect.",
    });
    expect(server.fetch).not.toHaveBeenCalledWith(
      "https://mac.example.test/api/remote/auth/challenge",
      expect.anything(),
    );
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it.each([
    ["as that host sent it", "host-changed", (hello: Record<string, unknown>) => hello],
    [
      "relabelled with the paired key",
      "unproven",
      (hello: Record<string, unknown>) => ({
        ...hello,
        hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      }),
    ],
  ] as const)(
    "refuses a genuine hello from another host replayed %s",
    async (_label, outcome, tamperHello) => {
      const { server, bridge } = await resumePairedDevice({
        hostKey: createTestHostKey(),
        tamperHello,
      });

      await waitUntil(() => {
        const kind = bridge.getState().kind;
        return kind === "unauthorized" || kind === "unavailable";
      });
      expect(bridge.getState()).toMatchObject(
        outcome === "host-changed"
          ? { kind: "unauthorized", reasonCode: "host-changed" }
          : { kind: "unavailable" },
      );
      expect(server.fetch).not.toHaveBeenCalledWith(
        "https://mac.example.test/api/remote/auth/challenge",
        expect.anything(),
      );
    },
  );

  it("asks to update a host whose hello carries no public key and keeps the pairing", async () => {
    const { pairingStore, deviceKeyId, bridge } = await resumePairedDevice({
      tamperHello: ({ hostPublicKey: _omitted, ...hello }) => hello,
    });

    await waitUntil(() => bridge.getState().kind === "incompatible");
    expect(bridge.getState()).toMatchObject({
      kind: "incompatible",
      reason:
        "This host runs an older Octant that cannot prove its identity. Update Octant on the host, then connect again.",
    });
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it("refuses a genuine, unexpired hello recorded from an earlier request and keeps the pairing", async () => {
    // Something at the paired origin answers every hello with one the real
    // host signed moments ago for another request, and passes the rest on.
    let recorded: Record<string, unknown> | undefined;
    const server = createFakeRemoteServer({ tamperHello: (hello) => recorded ?? hello });
    recorded = await (
      await server.fetch(`${ORIGIN}/api/remote/hello?clientNonce=${"r".repeat(43)}`)
    ).json();
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
    });
    const bridge = createRemoteSessionBridge({ fetch: server.fetch, deviceKeyStore: pairingStore });
    bridge.resume(ORIGIN);

    await waitUntil(() => bridge.getState().kind === "unavailable");
    expect(bridge.getState()).toMatchObject({
      kind: "unavailable",
      reason: "This host could not prove its identity, so Octant did not connect.",
    });
    expect(server.fetch).not.toHaveBeenCalledWith(
      "https://mac.example.test/api/remote/auth/challenge",
      expect.anything(),
    );
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it("asks to update a host built before client nonces and keeps the pairing", async () => {
    const { server, pairingStore, deviceKeyId, bridge } = await resumePairedDevice({
      predatesClientNonces: true,
    });

    await waitUntil(() => bridge.getState().kind === "incompatible");
    expect(bridge.getState()).toMatchObject({
      kind: "incompatible",
      reason:
        "This host runs an older Octant that cannot prove its identity. Update Octant on the host, then connect again.",
    });
    expect(server.fetch).not.toHaveBeenCalledWith(
      "https://mac.example.test/api/remote/hello",
      expect.anything(),
    );
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
  });

  it("connects a device paired before hellos carried a key, whose record holds only the fingerprint", async () => {
    // Records written before hellos were verified hold the fingerprint the
    // host stated; the host has always computed it as SHA-256 of the key's
    // DER SubjectPublicKeyInfo, so the stored value pins the proven key as is.
    const { bridge } = await resumePairedDevice({});

    await waitUntil(() => bridge.getState().kind === "ready");
    expect(bridge.getState()).toMatchObject({ kind: "ready", hostId: HOST_ID });
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
    if (failure !== undefined) {
      // A bare 401 naming the reason is unauthenticated, so the key stays.
      await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
    }
  });

  it("retains the paired key after an ambiguous unauthorized resume failure", async () => {
    const server = createFakeRemoteServer({});
    const pairingStore = createInMemoryDeviceKeyStore();
    const { deviceKeyId, deviceId } = await registerWebCryptoDevice(server, pairingStore);
    await pairingStore.updateMetadata(deviceKeyId, {
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
      hostKeyFingerprint: HOST_KEY_FINGERPRINT,
      listenerTrust: PLATFORM_LISTENER_TRUST,
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
