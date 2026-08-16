import type { StableHostId } from "@octant/contracts/remote-access";
import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createExpoSecureDeviceKeyStore,
  createInMemoryExpoSecureStringStorage,
} from "./expoSecureDeviceKeyStore";

const hostId = "11111111-1111-4111-8111-111111111111" as StableHostId;

async function generateExtractablePair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

function verifyIeeeP1363(pem: string, payload: string, signature: string): boolean {
  return verify(
    "sha256",
    Buffer.from(payload, "utf8"),
    { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
}

async function publicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const b64 = Buffer.from(spki).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

describe("expoSecureDeviceKeyStore", () => {
  it("requires extractable private keys for SecureStore persistence", () => {
    const store = createExpoSecureDeviceKeyStore({
      storage: createInMemoryExpoSecureStringStorage(),
    });
    expect(store.requiresExtractablePrivateKeys).toBe(true);
  });

  it("persists and restores a device key pair across store instances", async () => {
    const storage = createInMemoryExpoSecureStringStorage();
    const storeA = createExpoSecureDeviceKeyStore({ storage });
    const pair = await generateExtractablePair();
    const keyId = await storeA.set(
      { publicKey: pair.publicKey, privateKey: pair.privateKey },
      { origin: "https://host.example:8443", hostId },
    );

    const storeB = createExpoSecureDeviceKeyStore({ storage });
    const restored = await storeB.get(keyId);
    expect(restored).toBeDefined();

    const payload = "mobile-device-proof";
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      restored!.privateKey,
      new TextEncoder().encode(payload),
    );
    const pem = await publicKeyPem(restored!.publicKey);
    expect(verifyIeeeP1363(pem, payload, Buffer.from(signature).toString("base64url"))).toBe(true);
  });

  it("keeps private key material out of metadata and JSON snapshots", async () => {
    const storage = createInMemoryExpoSecureStringStorage();
    const store = createExpoSecureDeviceKeyStore({ storage });
    const pair = await generateExtractablePair();
    const keyId = await store.set(
      { publicKey: pair.publicKey, privateKey: pair.privateKey },
      { origin: "https://host.example:8443", hostId },
    );
    await store.updateMetadata(keyId, {
      deviceId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      hostKeyFingerprint: createHash("sha256").update("host").digest("hex"),
    });

    const metadata = await store.findByOrigin("https://host.example:8443");
    expect(metadata).toMatchObject({
      keyId,
      origin: "https://host.example:8443",
      hostId,
      deviceId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
    });
    const snapshot = JSON.stringify(metadata);
    expect(snapshot.includes("PRIVATE")).toBe(false);
    expect(snapshot.includes("privateKey")).toBe(false);
    expect(snapshot.includes("pkcs8")).toBe(false);
  });

  it("rejects non-extractable private keys with an actionable error", async () => {
    const store = createExpoSecureDeviceKeyStore({
      storage: createInMemoryExpoSecureStringStorage(),
    });
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ]);
    await expect(
      store.set(
        { publicKey: pair.publicKey, privateKey: pair.privateKey },
        { origin: "https://host.example:8443", hostId },
      ),
    ).rejects.toThrow(/requiresExtractablePrivateKeys/);
  });

  it("preserves pending claims when replacing other approved keys for an origin", async () => {
    const storage = createInMemoryExpoSecureStringStorage();
    const store = createExpoSecureDeviceKeyStore({ storage });
    const origin = "https://host.example:8443";

    const approvedPair = await generateExtractablePair();
    const approvedId = await store.set(
      { publicKey: approvedPair.publicKey, privateKey: approvedPair.privateKey },
      { origin, hostId },
    );
    await store.updateMetadata(approvedId, {
      deviceId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 1,
      hostKeyFingerprint: "a".repeat(64),
    });

    const pendingPair = await generateExtractablePair();
    const pendingId = await store.set(
      { publicKey: pendingPair.publicKey, privateKey: pendingPair.privateKey },
      { origin, hostId },
    );

    const nextPair = await generateExtractablePair();
    const nextId = await store.set(
      { publicKey: nextPair.publicKey, privateKey: nextPair.privateKey },
      { origin, hostId },
    );
    await store.updateMetadata(nextId, {
      deviceId: "33333333-3333-4333-8333-333333333333",
      credentialGeneration: 1,
      hostKeyFingerprint: "b".repeat(64),
    });
    await store.removeOtherApprovedForOrigin(origin, nextId);

    expect(await store.get(approvedId)).toBeUndefined();
    expect(await store.get(pendingId)).toBeDefined();
    expect(await store.get(nextId)).toBeDefined();
    expect(await store.findByOrigin(origin)).toMatchObject({ keyId: nextId });
  });
});
