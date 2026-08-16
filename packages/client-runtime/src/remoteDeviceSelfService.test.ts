import { describe, expect, it, vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createInMemoryDeviceKeyStore } from "./remotePairingClient";
import { createRemoteSessionBridge } from "./remoteSessionBridge";
import {
  fetchRemoteOwnDeviceMetadata,
  remoteRevokeSelf,
  remoteRotateDeviceKey,
  remoteSignOut,
} from "./remoteDeviceSelfService";
import {
  createFakeRemoteServer,
  fingerprintFromPem,
  HOST_ID,
  HOST_KEY_FINGERPRINT,
  ORIGIN,
  TICKET_ID,
} from "./remoteConnectionFixtures";

const hostId = decodeStableHostId(HOST_ID);

async function pemFromPublicKey(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += 64) {
    lines.push(base64.slice(i, i + 64));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function waitForReady(bridge: ReturnType<typeof createRemoteSessionBridge>): Promise<void> {
  const start = Date.now();
  while (bridge.getState().kind !== "ready") {
    if (Date.now() - start > 5000) throw new Error("Timed out waiting for ready.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readyBridge(config: Parameters<typeof createFakeRemoteServer>[0] = {}) {
  const server = createFakeRemoteServer(config);
  const pairingStore = createInMemoryDeviceKeyStore();
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
  const deviceKeyId = await pairingStore.set(keyPair, { origin: ORIGIN, hostId, deviceId });
  // A real paired device carries approved metadata, which is what `resume` and
  // any rotation replacement have to reproduce.
  await pairingStore.updateMetadata(deviceKeyId, {
    deviceId,
    credentialGeneration: 1,
    hostKeyFingerprint: HOST_KEY_FINGERPRINT,
  });
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
  await waitForReady(bridge);
  return { bridge, pairingStore, deviceKeyId, server, deviceId };
}

async function storedPublicKeyPem(
  pairingStore: ReturnType<typeof createInMemoryDeviceKeyStore>,
  keyId: string,
): Promise<string | undefined> {
  const keyPair = await pairingStore.get(keyId);
  if (keyPair === undefined) return undefined;
  return pemFromPublicKey(keyPair.publicKey);
}

describe("remoteDeviceSelfService", () => {
  it("reads own-device metadata and signs out without revoking registration", async () => {
    const { bridge } = await readyBridge();
    const metadata = await fetchRemoteOwnDeviceMetadata({ bridge });
    expect(metadata.deviceLabel).toBe("Remote browser");
    expect(metadata.deviceId).toBe("22222222-2222-4222-8222-222222222222");
    await remoteSignOut({ bridge });
    expect(bridge.getState().kind).toBe("stale");
  });

  it("fails closed when disconnected", async () => {
    const { bridge } = await readyBridge();
    bridge.connection()?.disconnect();
    await expect(fetchRemoteOwnDeviceMetadata({ bridge })).rejects.toMatchObject({
      category: "offline",
    });
  });

  it("forgets the persisted device credentials after self-revocation", async () => {
    const { bridge, pairingStore, deviceKeyId } = await readyBridge();

    await remoteRevokeSelf({ bridge });

    // The browser must not keep a credential it knows the host revoked, so a
    // reload lands on re-pairing instead of resuming into a doomed rejection.
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeUndefined();
    expect(bridge.getState()).toEqual({ kind: "idle" });
  });

  it("disconnects after revocation when local credential cleanup fails", async () => {
    const { bridge, pairingStore, deviceKeyId } = await readyBridge();
    vi.spyOn(pairingStore, "remove").mockRejectedValueOnce(new Error("IndexedDB unavailable."));

    await expect(remoteRevokeSelf({ bridge })).resolves.toEqual({
      localCredentialRemoved: false,
      warning: "Remote device was revoked, but this browser could not remove its local credential.",
    });
    expect(bridge.getState()).toEqual({ kind: "idle" });
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
    // The registration the browser failed to delete stays discoverable, so the
    // returned warning is the only honest signal that it is now dead. A later
    // resume is rejected by the host as revoked, which clears it.
    await expect(pairingStore.findByOrigin(ORIGIN)).resolves.toMatchObject({
      keyId: deviceKeyId,
    });
  });

  it("adopts the rotated key only after the host accepts it, and can reconnect with it", async () => {
    const { bridge, pairingStore, deviceKeyId, server, deviceId } = await readyBridge();
    const originalPem = server.devicePublicKey();

    const result = await remoteRotateDeviceKey({ bridge });

    // The host advanced the generation by one and now trusts the new key.
    expect(server.credentialGeneration()).toBe(2);
    expect(server.devicePublicKey()).not.toBe(originalPem);
    expect(result.credentialGeneration).toBe(2);
    expect(result.warning).toBeUndefined();

    // The browser stores the matching key pair and generation, replacing the
    // superseded registration rather than accumulating one.
    const stored = await pairingStore.findByOrigin(ORIGIN);
    expect(stored?.keyId).not.toBe(deviceKeyId);
    expect(stored?.credentialGeneration).toBe(2);
    expect(stored?.deviceId).toBe(deviceId);
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeUndefined();
    await expect(storedPublicKeyPem(pairingStore, stored!.keyId)).resolves.toBe(
      server.devicePublicKey(),
    );

    // Rotation invalidates the session, so the bridge must not pretend it
    // continues — but the device must still be able to authenticate.
    expect(bridge.getState()).toEqual({ kind: "idle" });
    bridge.resume(ORIGIN);
    await waitForReady(bridge);
    await expect(fetchRemoteOwnDeviceMetadata({ bridge })).resolves.toMatchObject({ deviceId });
  });

  it("keeps the old key authenticating when the host rejects the rotation", async () => {
    const { bridge, pairingStore, deviceKeyId, server } = await readyBridge({
      rotateKeyStatus: 403,
    });
    const originalPem = server.devicePublicKey();

    await expect(remoteRotateDeviceKey({ bridge })).rejects.toMatchObject({
      category: "rejected",
    });

    // Nothing about this device may have moved: the host still registers the
    // old key, and the browser still stores exactly that key pair.
    expect(server.devicePublicKey()).toBe(originalPem);
    expect(server.credentialGeneration()).toBe(1);
    const stored = await pairingStore.findByOrigin(ORIGIN);
    expect(stored?.keyId).toBe(deviceKeyId);
    expect(stored?.credentialGeneration).toBe(1);
    await expect(storedPublicKeyPem(pairingStore, deviceKeyId)).resolves.toBe(originalPem);

    // Proof that the device is not locked out: a fresh request proof signed
    // with the stored key is still accepted by the host.
    expect(bridge.getState().kind).toBe("ready");
    await expect(fetchRemoteOwnDeviceMetadata({ bridge })).resolves.toBeDefined();
  });

  it("reports honestly when the host rotated but this browser could not store the new key", async () => {
    const { bridge, pairingStore, deviceKeyId } = await readyBridge();
    vi.spyOn(pairingStore, "updateMetadata").mockRejectedValueOnce(
      new Error("IndexedDB unavailable."),
    );

    const result = await remoteRotateDeviceKey({ bridge });

    expect(result.warning).toBe(
      "The host rotated this device's key, but this browser could not store the replacement. Pair this browser again.",
    );
    // The superseded registration is left in place rather than removed: it no
    // longer works, but silently emptying storage would hide why.
    await expect(pairingStore.get(deviceKeyId)).resolves.toBeDefined();
    expect(bridge.getState()).toEqual({ kind: "idle" });
  });

  it("fails closed without touching stored keys when the session is not authenticated", async () => {
    const { bridge, pairingStore, deviceKeyId } = await readyBridge();
    bridge.connection()?.disconnect();

    await expect(remoteRotateDeviceKey({ bridge })).rejects.toMatchObject({ category: "offline" });
    await expect(pairingStore.findByOrigin(ORIGIN)).resolves.toMatchObject({
      keyId: deviceKeyId,
      credentialGeneration: 1,
    });
  });
});
