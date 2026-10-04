import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  ensureReplicaDeviceKey,
  makeReplicaDeviceSigner,
  verifyReplicaEntrySignature,
  ReplicaDeviceKeyFailure,
} from "./replicaDeviceKeyService";

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    async set(id, credential) {
      values.set(id, credential);
    },
    async has(id) {
      return values.has(id);
    },
    async resolve(id) {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    async delete(id) {
      values.delete(id);
    },
  };
}

const instanceId = "11111111-1111-4111-8111-111111111111";

describe("replica device key service", () => {
  it("creates a key once and returns the same public key afterwards", async () => {
    const store = memoryStore();
    const first = await ensureReplicaDeviceKey(store, instanceId);
    const second = await ensureReplicaDeviceKey(store, instanceId);
    expect(second.publicKey).toBe(first.publicKey);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(store.values.size).toBe(1);
  });

  it("signs with the stored key and verifies against the public key", async () => {
    const store = memoryStore();
    const key = await ensureReplicaDeviceKey(store, instanceId);
    const signer = makeReplicaDeviceSigner(store, instanceId);
    const payload = new TextEncoder().encode("octant.replica-entry/1\nbody\n");
    const { signature } = await signer.sign(payload);
    expect(
      verifyReplicaEntrySignature({
        publicKeyBase64: key.publicKey,
        payload,
        signatureBase64: signature,
      }),
    ).toBe(true);
  });

  it("refuses a signature made over different bytes", async () => {
    const store = memoryStore();
    const key = await ensureReplicaDeviceKey(store, instanceId);
    const signer = makeReplicaDeviceSigner(store, instanceId);
    const payload = new TextEncoder().encode("original");
    const { signature } = await signer.sign(payload);
    expect(
      verifyReplicaEntrySignature({
        publicKeyBase64: key.publicKey,
        payload: new TextEncoder().encode("tampered"),
        signatureBase64: signature,
      }),
    ).toBe(false);
  });

  it("refuses to sign before a key exists", async () => {
    const store = memoryStore();
    const signer = makeReplicaDeviceSigner(store, instanceId);
    await expect(signer.sign(new TextEncoder().encode("bytes"))).rejects.toBeInstanceOf(
      ReplicaDeviceKeyFailure,
    );
  });

  it("refuses a signature from a different key", async () => {
    const store = memoryStore();
    await ensureReplicaDeviceKey(store, instanceId);
    const other = generateKeyPairSync("ed25519");
    const otherPublic = other.publicKey.export({ format: "der", type: "spki" });
    const signer = makeReplicaDeviceSigner(store, instanceId);
    const { signature } = await signer.sign(new TextEncoder().encode("bytes"));
    expect(
      verifyReplicaEntrySignature({
        publicKeyBase64: Buffer.from(otherPublic).toString("base64"),
        payload: new TextEncoder().encode("bytes"),
        signatureBase64: signature,
      }),
    ).toBe(false);
  });
});
