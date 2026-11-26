// The crypto behind the hub's public entrance: visitor-link grants a spoke signs
// with its host identity key, webhook signatures checked on raw bytes, and
// webhook secrets sealed to a hub or standby. The order and meaning of the
// checks live in the pure policy; this file only answers whether bytes match.

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  HubMemberId,
  SealedWebhookSecret,
  SignedVisitorLinkGrant,
  WebhookSignatureScheme,
} from "@octant/contracts";
import {
  decideVisitorLink,
  visitorLinkSecretHashInput,
  visitorLinkSigningPayload,
  type VisitorLinkDecision,
  type WebhookHeaderReading,
} from "@octant/domain";
import { publicKeyFingerprint, verifySignature } from "./hubCrypto";

/** Thirty-two random bytes for a link's URL fragment. */
export function mintVisitorLinkSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** Sixteen random bytes: a link id, an endpoint id, or a visitor comment id. */
export function mintPublicId(): string {
  // An id that began with "-" would read as a flag to `octant hub`.
  for (;;) {
    const id = randomBytes(16).toString("base64url");
    if (!id.startsWith("-")) return id;
  }
}

export function visitorLinkSecretHash(linkId: string, secret: string): string {
  return createHash("sha256")
    .update(visitorLinkSecretHashInput(linkId, secret))
    .digest("base64url");
}

/** Whether `secret` opens the link whose grant carries `secretHash`, compared in constant time. */
export function visitorLinkSecretMatches(input: {
  readonly linkId: string;
  readonly secret: string;
  readonly secretHash: string;
}): boolean {
  return sameBytes(
    Buffer.from(visitorLinkSecretHash(input.linkId, input.secret)),
    Buffer.from(input.secretHash),
  );
}

function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Whether the hub may carry a visitor's request for this grant. The signer's
 * key must be the one the roster lists for the spoke the grant names, so a
 * grant signed by any other key, however valid its signature, is refused.
 */
export function checkVisitorLinkGrant(input: {
  readonly signed: SignedVisitorLinkGrant;
  /**
   * The link's secret, on the request that opens it. A later request carries
   * no secret: the spoke holds it to the browser that opened the link instead.
   */
  readonly secret?: string;
  readonly nowMs: number;
  readonly rosterFingerprintFor: (memberId: HubMemberId) => string | undefined;
}): VisitorLinkDecision {
  const { grant, signerPublicKey, signature } = input.signed;
  const listed = input.rosterFingerprintFor(grant.spokeMemberId);
  const signerListed = listed !== undefined && listed === publicKeyFingerprint(signerPublicKey);
  const signatureValid =
    signerListed &&
    verifySignature({
      payload: visitorLinkSigningPayload(grant),
      signature,
      publicKey: signerPublicKey,
    });
  const secretMatches =
    input.secret === undefined ||
    sameBytes(
      Buffer.from(visitorLinkSecretHash(grant.linkId, input.secret)),
      Buffer.from(grant.secretHash),
    );
  return decideVisitorLink({
    grant,
    nowMs: input.nowMs,
    signerListed,
    signatureValid,
    secretMatches,
  });
}

const STANDARD_WEBHOOKS_PREFIX = "whsec_";

/**
 * A new endpoint secret. Standard Webhooks senders expect `whsec_` and base64;
 * GitHub takes any text, so one form serves both.
 */
export function mintWebhookSecret(): string {
  return `${STANDARD_WEBHOOKS_PREFIX}${randomBytes(32).toString("base64")}`;
}

function standardWebhooksKey(secret: string): Buffer {
  return Buffer.from(
    secret.startsWith(STANDARD_WEBHOOKS_PREFIX)
      ? secret.slice(STANDARD_WEBHOOKS_PREFIX.length)
      : secret,
    "base64",
  );
}

/** Whether any signature a delivery lists is the secret's HMAC-SHA256 over its signed bytes. */
export function verifyWebhookSignature(input: {
  readonly scheme: WebhookSignatureScheme;
  readonly secret: string;
  readonly reading: Extract<WebhookHeaderReading, { status: "read" }>;
  readonly body: Uint8Array;
}): boolean {
  if (input.scheme === "standard-webhooks") {
    const seconds = Math.floor((input.reading.timestampMs ?? 0) / 1000);
    const expected = createHmac("sha256", standardWebhooksKey(input.secret))
      .update(`${input.reading.deliveryId}.${seconds}.`)
      .update(input.body)
      .digest();
    return input.reading.signatures.some((presented) =>
      sameBytes(Buffer.from(presented, "base64"), expected),
    );
  }
  const expected = createHmac("sha256", input.secret).update(input.body).digest();
  return input.reading.signatures.some((presented) =>
    sameBytes(Buffer.from(presented, "hex"), expected),
  );
}

/** SHA-256 of a body as lowercase hex: GitHub's second dedupe key. */
export function webhookBodyDigest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A P-256 key pair a hub or standby keeps only for opening sealed webhook secrets. */
export function makeSealingKeyPair(): { readonly publicKey: string; readonly privateKey: string } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

function sealingKey(shared: Buffer, endpointId: string, recipientMemberId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.alloc(0),
      `octant/webhook-secret/v1|${endpointId}|${recipientMemberId}`,
      32,
    ),
  );
}

const GCM_TAG_BYTES = 16;

/** Seals a secret to one recipient: ephemeral ECDH, HKDF-SHA256, AES-256-GCM. */
export function sealWebhookSecret(input: {
  readonly secret: string;
  readonly endpointId: string;
  readonly recipientMemberId: HubMemberId;
  readonly recipientPublicKey: string;
}): SealedWebhookSecret {
  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(input.recipientPublicKey, "base64url"));
  const key = sealingKey(shared, input.endpointId, input.recipientMemberId);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(input.secret, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    recipientMemberId: input.recipientMemberId,
    ephemeralPublicKey: ephemeral.getPublicKey().toString("base64url"),
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** Opens a sealed secret, or undefined for any other key, endpoint, or a tampered seal. */
export function openWebhookSecret(input: {
  readonly sealed: SealedWebhookSecret;
  readonly endpointId: string;
  readonly privateKey: string;
}): string | undefined {
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(input.privateKey, "base64url"));
    const shared = ecdh.computeSecret(Buffer.from(input.sealed.ephemeralPublicKey, "base64url"));
    const key = sealingKey(shared, input.endpointId, input.sealed.recipientMemberId);
    const bytes = Buffer.from(input.sealed.ciphertext, "base64url");
    // Node accepts a GCM tag as short as 4 bytes unless told its length, so a
    // seal shorter than a full tag would be checked against 32 bits, not 128.
    if (bytes.length <= GCM_TAG_BYTES) return undefined;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(input.sealed.nonce, "base64url"),
      { authTagLength: GCM_TAG_BYTES },
    );
    decipher.setAuthTag(bytes.subarray(bytes.length - GCM_TAG_BYTES));
    return Buffer.concat([
      decipher.update(bytes.subarray(0, bytes.length - GCM_TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}
