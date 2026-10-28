// Signature and pin helpers shared by the hub role and the spoke link. Keys
// are P-256 and signatures are IEEE-P1363 base64url, the same shapes the host
// identity key already signs with.

import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";

const PIN_PREFIX = "sha256-";

/** SHA-256 (lowercase hex) of a base64url SubjectPublicKeyInfo, as a roster entry names a key. */
export function publicKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
}

/** Whether `signature` is the key's signature over `payload`; a malformed key or signature is a no. */
export function verifySignature(input: {
  readonly payload: string;
  readonly signature: string;
  readonly publicKey: string;
}): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(input.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(
      "sha256",
      Buffer.from(input.payload, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(input.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** The 64-hex digest a roster holds for a listener pin written as `sha256-` and base64url. */
export function digestFromListenerPin(pin: string): string | undefined {
  if (!pin.startsWith(PIN_PREFIX)) return undefined;
  const bytes = Buffer.from(pin.slice(PIN_PREFIX.length), "base64url");
  return bytes.byteLength === 32 ? bytes.toString("hex") : undefined;
}

/** The pin a transport holds a listener to, from the digest a roster holds. */
export function listenerPinFromDigest(digest: string): string {
  return `${PIN_PREFIX}${Buffer.from(digest, "hex").toString("base64url")}`;
}
