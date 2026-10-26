// A phone's side of sealed push, for tests: an HPKE (RFC 9180) base-mode
// opener for DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, written
// apart from the host's sealer so a mistake in one is not repeated in the
// other. The sealing tests check it against the published test vector for
// this exact suite before any test trusts it to open what the host sealed.

import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { RemotePushEnvelopeV1 } from "@octant/contracts";

const KEM_SUITE = Buffer.concat([Buffer.from("KEM"), Buffer.from([0x00, 0x20])]);
const HPKE_SUITE = Buffer.concat([
  Buffer.from("HPKE"),
  Buffer.from([0x00, 0x20, 0x00, 0x01, 0x00, 0x02]),
]);

const extract = (salt: Buffer, ikm: Buffer) => createHmac("sha256", salt).update(ikm).digest();

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  let previous = Buffer.alloc(0);
  const blocks: Buffer[] = [];
  for (let counter = 1; Buffer.concat(blocks).length < length; counter += 1) {
    previous = createHmac("sha256", prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
  extract(salt, Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]));

const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) =>
  expand(
    prk,
    Buffer.concat([
      Buffer.from([length >> 8, length & 0xff]),
      Buffer.from("HPKE-v1"),
      suite,
      Buffer.from(label),
      info,
    ]),
    length,
  );

const rawPublic = (key: KeyObject) =>
  Buffer.from(String(key.export({ format: "jwk" }).x), "base64url");

const x25519Public = (raw: Buffer) =>
  createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") },
    format: "jwk",
  });

/** Single-shot HPKE open (sequence 0). Throws when the key, info, or bytes do not match. */
export function referenceOpen(input: {
  readonly recipient: KeyObject;
  readonly enc: Buffer;
  readonly info: Buffer;
  readonly aad: Buffer;
  readonly ciphertext: Buffer;
}): Buffer {
  const dh = diffieHellman({ privateKey: input.recipient, publicKey: x25519Public(input.enc) });
  // A private key's JWK carries its public half as `x`.
  const kemContext = Buffer.concat([input.enc, rawPublic(input.recipient)]);
  const sharedSecret = labeledExpand(
    KEM_SUITE,
    labeledExtract(KEM_SUITE, Buffer.alloc(0), "eae_prk", dh),
    "shared_secret",
    kemContext,
    32,
  );
  const context = Buffer.concat([
    Buffer.from([0x00]),
    labeledExtract(HPKE_SUITE, Buffer.alloc(0), "psk_id_hash", Buffer.alloc(0)),
    labeledExtract(HPKE_SUITE, Buffer.alloc(0), "info_hash", input.info),
  ]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", Buffer.alloc(0));
  const key = labeledExpand(HPKE_SUITE, secret, "key", context, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, 12);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(input.aad);
  decipher.setAuthTag(input.ciphertext.subarray(input.ciphertext.length - 16));
  return Buffer.concat([
    decipher.update(input.ciphertext.subarray(0, input.ciphertext.length - 16)),
    decipher.final(),
  ]);
}

export function x25519PrivateFromRaw(raw: Buffer): KeyObject {
  // PKCS#8 prefix for an X25519 private key followed by its 32 raw bytes.
  const prefix = Buffer.from("302e020100300506032b656e04220420", "hex");
  return createPrivateKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "pkcs8" });
}

/** A phone's notification key pair for one host; only the public half is registered. */
export function phoneNotificationKeys(): {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
} {
  const pair = generateKeyPairSync("x25519");
  return {
    privateKey: pair.privateKey,
    publicKey: rawPublic(pair.publicKey).toString("base64url"),
  };
}

/**
 * Opens an envelope the way the phone does: the info string is the one the
 * specification names, rebuilt here rather than taken from the sealer.
 */
export function openSealedPushNotification(input: {
  readonly envelope: RemotePushEnvelopeV1;
  readonly recipient: KeyObject;
  readonly hostId: string;
  readonly deviceId: string;
}): unknown {
  return JSON.parse(
    referenceOpen({
      recipient: input.recipient,
      enc: Buffer.from(input.envelope.sealed.encapsulatedKey, "base64url"),
      info: Buffer.from(`octant-push-v1\n${input.hostId}\n${input.deviceId}`, "utf8"),
      aad: Buffer.alloc(0),
      ciphertext: Buffer.from(input.envelope.sealed.ciphertext, "base64url"),
    }).toString("utf8"),
  );
}
