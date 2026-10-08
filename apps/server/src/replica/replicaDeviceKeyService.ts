/**
 * The device signing key for one replica store instance.
 *
 * The private half never leaves the host. It is kept in its own namespace of
 * the host credential store (a separate macOS Keychain service, or a separate
 * Secret Service attribute), which the provider credential routes cannot
 * reach, and it is read into this process only to sign. Only the public key,
 * its fingerprint, and signatures go anywhere else. Entries a computer
 * publishes are signed here. Every entry carries the public key, and the
 * instance id is derived from it, so other computers verify an entry against
 * the key it names and check that the id is that key's.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import type { CredentialStore } from "@octant/host-runtime";

/** Ed25519 keys are small and verification is fast on every supported host. */
export const REPLICA_DEVICE_KEY_TYPE = "ed25519" as const;
/** The device-key namespace keys by instance UUID and is scoped per host data store. */
export const REPLICA_DEVICE_KEY_CREDENTIAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ReplicaDeviceKeyFailureCategory = "failed" | "invalid" | "missing" | "unavailable";

const FAILURE_MESSAGES: Readonly<Record<ReplicaDeviceKeyFailureCategory, string>> = {
  failed: "The replica device-key operation failed.",
  invalid: "The replica device-key request is invalid.",
  missing: "No replica device key is stored for this instance.",
  unavailable: "The secure replica device-key store is unavailable.",
};

export class ReplicaDeviceKeyFailure extends Error {
  constructor(readonly category: ReplicaDeviceKeyFailureCategory) {
    super(FAILURE_MESSAGES[category]);
    this.name = "ReplicaDeviceKeyFailure";
  }
}

export interface ReplicaDeviceSigningKey {
  /** Base64-encoded SPKI public key. Membership records carry this. */
  readonly publicKey: string;
  /** SHA-256 of the SPKI bytes, lowercase hex. */
  readonly fingerprint: string;
}

/**
 * Signing either produces a signature or says why it could not: the request
 * was invalid, no key is stored for the instance, the credential store could
 * not be reached, or the stored key did not sign.
 */
export type ReplicaDeviceSignOutcome =
  | { readonly status: "signed"; readonly signature: string }
  | { readonly status: "refused"; readonly reason: ReplicaDeviceKeyFailureCategory };

export interface ReplicaDeviceSigner {
  /** Sign the canonical entry bytes another computer will verify. */
  readonly sign: (payload: Uint8Array) => Promise<ReplicaDeviceSignOutcome>;
}

function deviceKeyId(instanceId: string): string | undefined {
  const normalized = instanceId.toLowerCase();
  return REPLICA_DEVICE_KEY_CREDENTIAL_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function credentialId(instanceId: string): string {
  const id = deviceKeyId(instanceId);
  if (id === undefined) throw new ReplicaDeviceKeyFailure("invalid");
  return id;
}

/**
 * The instance id a device key certifies: the first 16 bytes of SHA-256 over
 * the key's SPKI bytes, written as a lowercase UUIDv8. Anyone can recompute
 * it from the key an entry carries, so no record can name another key for an
 * id, and a rewrite cannot change a member's key.
 */
export function replicaInstanceIdOf(publicKeyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Create a new device signing key and store it under the instance id it
 * certifies. Every identity starts here: the id comes from the key, so a new
 * identity is always a new key, and an old key is always the old id.
 */
export async function createReplicaDeviceKey(
  store: CredentialStore,
): Promise<ReplicaDeviceSigningKey & { readonly instanceId: string }> {
  const generated = generateKeyPairSync(REPLICA_DEVICE_KEY_TYPE);
  const privateKeyPem = String(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKey = publicKeyBase64(privateKeyPem);
  const instanceId = credentialId(replicaInstanceIdOf(publicKey));
  try {
    await store.set(instanceId, privateKeyPem);
  } catch {
    throw new ReplicaDeviceKeyFailure("unavailable");
  }
  return { instanceId, publicKey, fingerprint: fingerprintOf(publicKey) };
}

export function makeReplicaDeviceSigner(
  store: CredentialStore,
  instanceId: string,
): ReplicaDeviceSigner {
  return {
    sign: async (payload: Uint8Array): Promise<ReplicaDeviceSignOutcome> => {
      const id = deviceKeyId(instanceId);
      if (id === undefined || payload.byteLength === 0) {
        return { status: "refused", reason: "invalid" };
      }
      let privateKeyPem: string;
      try {
        privateKeyPem = await store.resolve(id);
      } catch {
        return {
          status: "refused",
          reason: (await keyIsAbsent(store, id)) ? "missing" : "unavailable",
        };
      }
      try {
        const signature = cryptoSign(null, Buffer.from(payload), createPrivateKey(privateKeyPem));
        return { status: "signed", signature: signature.toString("base64") };
      } catch {
        return { status: "refused", reason: "failed" };
      }
    },
  };
}

/**
 * Whether a failed lookup means the key is not there. The local stores and the
 * broker client report an absent key in different shapes, so this asks the
 * store rather than reading the error; a store that cannot answer is
 * unavailable, not empty, and a locked Keychain is never reported as a lost key.
 */
async function keyIsAbsent(store: CredentialStore, id: string): Promise<boolean> {
  try {
    return !(await store.has(id));
  } catch {
    return false;
  }
}

/** Verify a detached signature against a member's published public key. */
export function verifyReplicaEntrySignature(input: {
  readonly publicKeyBase64: string;
  readonly payload: Uint8Array;
  readonly signatureBase64: string;
}): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(input.publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      null,
      Buffer.from(input.payload),
      publicKey,
      Buffer.from(input.signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

function publicKeyBase64(privateKeyPem: string): string {
  const spki = createPublicKey(privateKeyPem).export({ format: "der", type: "spki" });
  return Buffer.from(spki).toString("base64");
}

function fingerprintOf(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex");
}
