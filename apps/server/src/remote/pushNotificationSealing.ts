// Sealing a notification for one phone.
//
// What leaves the host for the delivery path is an envelope that Apple,
// Google, the gateway, and the phone's operating system can all read, so it
// carries only a fixed placeholder, an opaque collapse id, an urgency, and the
// sealed content. The content (kind, host, thread, mode, display text) is
// encrypted to the notification key the phone registered for this host, and
// only that phone holds the private half.
//
// The construction is HPKE (RFC 9180) base mode with DHKEM(X25519,
// HKDF-SHA256), HKDF-SHA256, and AES-256-GCM, single-shot (sequence 0, empty
// associated data). The info string binds the host id and device id, so
// content sealed for one phone and host does not open as another's. It is
// built from `node:crypto` alone; the test checks it against the published
// test vector for this suite. Nothing here logs or keeps what it seals.

import {
  createCipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  decodeRemotePushEnvelopeV1,
  REMOTE_PUSH_PLACEHOLDER_ALERT,
  REMOTE_PUSH_SEALED_CONTENT_MAX_BYTES,
  type RemotePushEnvelopeV1,
  type RemotePushNotificationKind,
} from "@octant/contracts";
import { remotePushUrgency } from "@octant/domain/push-notification-policy";

export type SealedPushNotification =
  | { readonly status: "sealed"; readonly envelope: RemotePushEnvelopeV1 }
  | { readonly status: "refused"; readonly reason: "unusable-key" | "too-large" };

/** The HPKE info string the phone uses to open what this host sealed for it. */
function pushNotificationSealingInfo(input: {
  readonly hostId: string;
  readonly deviceId: string;
}): Buffer {
  return Buffer.from(`octant-push-v1\n${input.hostId}\n${input.deviceId}`, "utf8");
}

const KEM_SUITE = Buffer.from([0x4b, 0x45, 0x4d, 0x00, 0x20]); // "KEM" || 0x0020
const HPKE_SUITE = Buffer.from([0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02]);
const VERSION_LABEL = Buffer.from("HPKE-v1");
const EMPTY = Buffer.alloc(0);
const X25519_KEY_BYTES = 32;
const AES_256_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const COLLAPSE_ID_BYTES = 16;

function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = EMPTY;
  let produced = 0;
  for (let counter = 1; produced < length; counter += 1) {
    previous = createHmac("sha256", prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
    produced += previous.length;
  }
  return Buffer.concat(blocks).subarray(0, length);
}

function labeledExtract(suite: Buffer, salt: Buffer, label: string, ikm: Buffer): Buffer {
  return hkdfExtract(salt, Buffer.concat([VERSION_LABEL, suite, Buffer.from(label), ikm]));
}

function labeledExpand(
  suite: Buffer,
  prk: Buffer,
  label: string,
  info: Buffer,
  length: number,
): Buffer {
  const lengthPrefix = Buffer.from([(length >> 8) & 0xff, length & 0xff]);
  return hkdfExpand(
    prk,
    Buffer.concat([lengthPrefix, VERSION_LABEL, suite, Buffer.from(label), info]),
    length,
  );
}

function rawPublicKey(key: KeyObject): Buffer {
  const x = key.export({ format: "jwk" }).x;
  return Buffer.from(typeof x === "string" ? x : "", "base64url");
}

function recipientKey(
  encoded: string,
): { readonly key: KeyObject; readonly raw: Buffer } | undefined {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return undefined;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== X25519_KEY_BYTES) return undefined;
  try {
    return {
      key: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: encoded }, format: "jwk" }),
      raw,
    };
  } catch {
    return undefined;
  }
}

/**
 * Seal one notification's content to one phone and wrap it in the envelope
 * the delivery path sees. A key that is not a usable X25519 public key, or
 * content over the sealed bound, is refused rather than sent in another form.
 */
export function sealPushNotification(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly notificationPublicKey: string;
  /** The destination's own collapse key, base64url, kept in its registration. */
  readonly collapseKey: string;
  readonly threadId: string;
  readonly kind: RemotePushNotificationKind;
  readonly content: unknown;
}): SealedPushNotification {
  const plaintext = Buffer.from(JSON.stringify(input.content), "utf8");
  if (plaintext.length > REMOTE_PUSH_SEALED_CONTENT_MAX_BYTES) {
    return { status: "refused", reason: "too-large" };
  }
  const recipient = recipientKey(input.notificationPublicKey);
  if (recipient === undefined) return { status: "refused", reason: "unusable-key" };

  // Encap: an ephemeral key per notification, so no two seals share a key.
  const ephemeral = generateKeyPairSync("x25519");
  let dh: Buffer;
  try {
    dh = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.key });
  } catch {
    return { status: "refused", reason: "unusable-key" };
  }
  // RFC 9180 §7.1.4: an all-zero X25519 output means a low-order public key.
  if (dh.every((byte) => byte === 0)) return { status: "refused", reason: "unusable-key" };
  const encapsulatedKey = rawPublicKey(ephemeral.publicKey);
  const sharedSecret = labeledExpand(
    KEM_SUITE,
    labeledExtract(KEM_SUITE, EMPTY, "eae_prk", dh),
    "shared_secret",
    Buffer.concat([encapsulatedKey, recipient.raw]),
    X25519_KEY_BYTES,
  );

  // Key schedule, base mode: no PSK.
  const context = Buffer.concat([
    Buffer.from([0x00]),
    labeledExtract(HPKE_SUITE, EMPTY, "psk_id_hash", EMPTY),
    labeledExtract(
      HPKE_SUITE,
      EMPTY,
      "info_hash",
      pushNotificationSealingInfo({ hostId: input.hostId, deviceId: input.deviceId }),
    ),
  ]);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, "secret", EMPTY);
  const key = labeledExpand(HPKE_SUITE, secret, "key", context, AES_256_KEY_BYTES);
  const nonce = labeledExpand(HPKE_SUITE, secret, "base_nonce", context, GCM_NONCE_BYTES);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const collapseId = createHmac("sha256", Buffer.from(input.collapseKey, "base64url"))
    .update(input.threadId)
    .digest()
    .subarray(0, COLLAPSE_ID_BYTES)
    .toString("base64url");

  return {
    status: "sealed",
    envelope: decodeRemotePushEnvelopeV1({
      alert: REMOTE_PUSH_PLACEHOLDER_ALERT,
      collapseId,
      urgency: remotePushUrgency(input.kind),
      sealed: {
        encapsulatedKey: encapsulatedKey.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      },
    }),
  };
}
