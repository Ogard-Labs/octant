import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CredentialStore } from "@octant/host-runtime";
import {
  createReplicaDeviceKey,
  makeReplicaDeviceSigner,
  replicaInstanceIdOf,
  verifyReplicaEntrySignature,
  ReplicaDeviceKeyFailure,
  type ReplicaDeviceSignOutcome,
} from "./replicaDeviceKeyService";

function signedText(outcome: ReplicaDeviceSignOutcome): string {
  if (outcome.status !== "signed") throw new Error(`Signing was refused: ${outcome.reason}`);
  return outcome.signature;
}

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

describe("replica device key service", () => {
  it("stores each new key under the UUIDv8 id its public key certifies", async () => {
    const store = memoryStore();
    const first = await createReplicaDeviceKey(store);
    const second = await createReplicaDeviceKey(store);
    expect(first.instanceId).toBe(replicaInstanceIdOf(first.publicKey));
    expect(first.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect([...store.values.keys()].sort()).toEqual([first.instanceId, second.instanceId].sort());
  });

  it("derives the same id from the same key, and another id from another key", () => {
    const key = Buffer.from(
      generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64");
    const other = Buffer.from(
      generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64");
    expect(replicaInstanceIdOf(key)).toBe(replicaInstanceIdOf(key));
    expect(replicaInstanceIdOf(other)).not.toBe(replicaInstanceIdOf(key));
  });

  it("signs with the stored key and verifies against the public key", async () => {
    const store = memoryStore();
    const key = await createReplicaDeviceKey(store);
    const signer = makeReplicaDeviceSigner(store, key.instanceId);
    const payload = new TextEncoder().encode("octant.replica-entry/2\nbody\n");
    const signature = signedText(await signer.sign(payload));
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
    const key = await createReplicaDeviceKey(store);
    const signer = makeReplicaDeviceSigner(store, key.instanceId);
    const signature = signedText(await signer.sign(new TextEncoder().encode("original")));
    expect(
      verifyReplicaEntrySignature({
        publicKeyBase64: key.publicKey,
        payload: new TextEncoder().encode("tampered"),
        signatureBase64: signature,
      }),
    ).toBe(false);
  });

  it("refuses to sign before a key exists, and says the key is missing", async () => {
    const store = memoryStore();
    const signer = makeReplicaDeviceSigner(store, "11111111-1111-8111-8111-111111111111");
    expect(await signer.sign(new TextEncoder().encode("bytes"))).toEqual({
      status: "refused",
      reason: "missing",
    });
  });

  it("says the store is unavailable, not that the key is missing, when the store cannot answer", async () => {
    const store = memoryStore();
    const key = await createReplicaDeviceKey(store);
    const locked: CredentialStore = {
      ...store,
      async resolve() {
        throw new Error("keychain locked");
      },
      async has() {
        throw new Error("keychain locked");
      },
    };
    const signer = makeReplicaDeviceSigner(locked, key.instanceId);
    expect(await signer.sign(new TextEncoder().encode("bytes"))).toEqual({
      status: "refused",
      reason: "unavailable",
    });
  });

  it("refuses an instance id that is not a device-key id as invalid, without asking the store", async () => {
    let asked = false;
    const store: CredentialStore = {
      ...memoryStore(),
      async resolve() {
        asked = true;
        throw new Error("unexpected");
      },
    };
    const signer = makeReplicaDeviceSigner(store, "not-an-instance");
    expect(await signer.sign(new TextEncoder().encode("bytes"))).toEqual({
      status: "refused",
      reason: "invalid",
    });
    expect(asked).toBe(false);
  });

  it("reports an unavailable credential store instead of returning a key it did not keep", async () => {
    const store: CredentialStore = {
      ...memoryStore(),
      async set() {
        throw new Error("keychain locked");
      },
    };
    const failure = await createReplicaDeviceKey(store).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReplicaDeviceKeyFailure);
    expect((failure as ReplicaDeviceKeyFailure).category).toBe("unavailable");
  });

  it("refuses a signature from a different key", async () => {
    const store = memoryStore();
    const key = await createReplicaDeviceKey(store);
    const other = generateKeyPairSync("ed25519");
    const otherPublic = other.publicKey.export({ format: "der", type: "spki" });
    const signer = makeReplicaDeviceSigner(store, key.instanceId);
    const signature = signedText(await signer.sign(new TextEncoder().encode("bytes")));
    expect(
      verifyReplicaEntrySignature({
        publicKeyBase64: Buffer.from(otherPublic).toString("base64"),
        payload: new TextEncoder().encode("bytes"),
        signatureBase64: signature,
      }),
    ).toBe(false);
  });
});
