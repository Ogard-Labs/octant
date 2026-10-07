/**
 * The device signing key for one replica store instance.
 *
 * The private half never leaves the host. It is kept in its own namespace of
 * the host credential store (a separate macOS Keychain service, or a separate
 * Secret Service attribute), which the provider credential routes cannot
 * reach, and it is read into this process only to sign. Only the public key,
 * its fingerprint, and signatures go anywhere else. Entries a computer publishes are signed here, and a membership
 * record binds the instance to the public key other computers verify against.
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

export interface ReplicaDeviceSigner {
  /** Sign the canonical entry bytes another computer will verify. */
  readonly sign: (payload: Uint8Array) => Promise<{ readonly signature: string }>;
}

function credentialId(instanceId: string): string {
  const normalized = instanceId.toLowerCase();
  if (!REPLICA_DEVICE_KEY_CREDENTIAL_ID_PATTERN.test(normalized)) {
    throw new ReplicaDeviceKeyFailure("invalid");
  }
  return normalized;
}

/** Load or create the device signing key for one replica instance. */
export async function ensureReplicaDeviceKey(
  store: CredentialStore,
  instanceId: string,
): Promise<ReplicaDeviceSigningKey> {
  const id = credentialId(instanceId);
  let stored: string | undefined;
  try {
    stored = await store.resolve(id);
  } catch {
    // A resolve that throws is not "no key": the public half of an existing
    // key is already bound in published membership entries, and regenerating
    // the private half would strand every signature made before. Only a
    // resolve that reports absence may create one, so ask the store directly.
    let present: boolean;
    try {
      present = await store.has(id);
    } catch {
      throw new ReplicaDeviceKeyFailure("unavailable");
    }
    if (present) throw new ReplicaDeviceKeyFailure("unavailable");
    stored = undefined;
  }
  let privateKeyPem: string;
  let created = false;
  if (stored === undefined || stored.length === 0) {
    const generated = generateKeyPairSync(REPLICA_DEVICE_KEY_TYPE);
    privateKeyPem = String(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
    try {
      await store.set(id, privateKeyPem);
    } catch {
      throw new ReplicaDeviceKeyFailure("unavailable");
    }
    created = true;
  } else {
    privateKeyPem = stored;
  }
  let publicKey: string;
  try {
    publicKey = publicKeyBase64(privateKeyPem);
  } catch {
    throw new ReplicaDeviceKeyFailure("failed");
  }
  if (!created) {
    try {
      if (!(await store.has(id))) throw new ReplicaDeviceKeyFailure("missing");
    } catch (error) {
      if (error instanceof ReplicaDeviceKeyFailure) throw error;
      throw new ReplicaDeviceKeyFailure("unavailable");
    }
  }
  return {
    publicKey,
    fingerprint: fingerprintOf(publicKey),
  };
}

export function makeReplicaDeviceSigner(
  store: CredentialStore,
  instanceId: string,
): ReplicaDeviceSigner {
  return {
    sign: async (payload: Uint8Array) => {
      if (payload.byteLength === 0) throw new ReplicaDeviceKeyFailure("invalid");
      let privateKeyPem: string;
      try {
        privateKeyPem = await store.resolve(credentialId(instanceId));
      } catch {
        throw new ReplicaDeviceKeyFailure("missing");
      }
      try {
        const signature = cryptoSign(null, Buffer.from(payload), createPrivateKey(privateKeyPem));
        return { signature: signature.toString("base64") };
      } catch {
        throw new ReplicaDeviceKeyFailure("failed");
      }
    },
  };
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
