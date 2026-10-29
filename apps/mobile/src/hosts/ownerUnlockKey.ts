// The phone's unlock key: a P-256 key an owner phone uses to answer a host's
// challenge. Its private half lives only in the platform's secure store, which
// asks the person (biometrics or the passcode) on every read, and the person
// is also asked through the system prompt before the store is read at all, so
// a signature never comes from a key read for another reason. It is a narrower
// form than a Secure Enclave or Keystore key: the store protects the stored
// bytes, but the key is not bound to hardware and is briefly in memory while it
// signs. The private key is never returned, logged, or sent.

import {
  base64UrlEncode,
  unlockKeyFingerprint,
  type OwnerUnlockSigner,
  type UnlockAttempt,
} from "@octant/client-runtime";
import type { BiometricAuthenticator } from "../security/BiometricGate";

const KEY_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;
const PROMPT = "Unlock this action on your computer";

export type UnlockKeyRead =
  | { readonly status: "read"; readonly pkcs8: string }
  | { readonly status: "missing" }
  /** The platform did not release the key: the person declined or could not authenticate. */
  | { readonly status: "refused" };

/** Secure storage that requires user authentication for every read of the private key. */
export interface UnlockKeyVault {
  readonly read: () => Promise<UnlockKeyRead>;
  readonly write: (pkcs8: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

/** Where the public half is kept. It is not secret, so reading it asks for nothing. */
export interface UnlockPublicKeyStore {
  readonly get: () => Promise<string | null>;
  readonly set: (publicKey: string) => Promise<void>;
  readonly remove: () => Promise<void>;
}

export interface PhoneUnlockKeyPorts {
  readonly vault: UnlockKeyVault;
  readonly publicKey: UnlockPublicKeyStore;
  readonly presence: Pick<BiometricAuthenticator, "authenticate">;
  readonly subtle?: SubtleCrypto;
}

export interface UnlockKeyIdentity {
  /** SubjectPublicKeyInfo, base64url: what a host records for this phone. */
  readonly publicKey: string;
  readonly fingerprint: string;
}

export interface PhoneUnlockKey {
  /** The key's public half, made on first use. Never asks the person. */
  readonly ensure: () => Promise<UnlockKeyIdentity>;
  readonly existing: () => Promise<UnlockKeyIdentity | undefined>;
  /** A raw-shape signer that asks the person before every signature; absent until a key exists. */
  readonly signer: () => Promise<OwnerUnlockSigner | undefined>;
  readonly forget: () => Promise<void>;
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function createPhoneUnlockKey(ports: PhoneUnlockKeyPorts): PhoneUnlockKey {
  const subtle = ports.subtle ?? globalThis.crypto.subtle;

  const identityOf = async (publicKey: string): Promise<UnlockKeyIdentity> => ({
    publicKey,
    fingerprint: await unlockKeyFingerprint(publicKey),
  });

  const existing = async (): Promise<UnlockKeyIdentity | undefined> => {
    const publicKey = await ports.publicKey.get();
    return publicKey === null || publicKey === "" ? undefined : identityOf(publicKey);
  };

  const sign = async (text: string): Promise<UnlockAttempt<string>> => {
    // The system prompt comes first, and the store is read only after it passes.
    const present = await ports.presence
      .authenticate({ reason: "approve", promptMessage: PROMPT })
      .catch(() => "unavailable" as const);
    if (present === "denied") return { status: "cancelled" };
    if (present !== "confirmed") return { status: "unavailable" };
    const read = await ports.vault.read().catch((): UnlockKeyRead => ({ status: "refused" }));
    if (read.status === "refused") return { status: "cancelled" };
    if (read.status === "missing") return { status: "unavailable" };
    try {
      const privateKey = await subtle.importKey(
        "pkcs8",
        fromBase64(read.pkcs8),
        KEY_ALGORITHM,
        false,
        ["sign"],
      );
      const signature = await subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        new TextEncoder().encode(text),
      );
      return { status: "signed", value: base64UrlEncode(signature) };
    } catch {
      return { status: "unavailable" };
    }
  };

  return {
    existing,
    async ensure() {
      const held = await existing();
      if (held !== undefined) return held;
      const pair = await subtle.generateKey(KEY_ALGORITHM, true, ["sign", "verify"]);
      const publicKey = base64UrlEncode(await subtle.exportKey("spki", pair.publicKey));
      // The private key is stored first, so a public key never exists without one.
      await ports.vault.write(toBase64(await subtle.exportKey("pkcs8", pair.privateKey)));
      await ports.publicKey.set(publicKey);
      return identityOf(publicKey);
    },
    async signer() {
      const held = await existing();
      if (held === undefined) return undefined;
      return {
        shape: "raw",
        publicKey: held.publicKey,
        sign,
      };
    },
    async forget() {
      await ports.vault.remove();
      await ports.publicKey.remove();
    },
  };
}
