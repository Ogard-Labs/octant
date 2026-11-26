import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { HubMemberId, VisitorLinkGrant, VisitorLinkId } from "@octant/contracts";
import { visitorLinkSigningPayload } from "@octant/domain";
import { describe, expect, it } from "vitest";
import {
  checkVisitorLinkGrant,
  makeSealingKeyPair,
  mintVisitorLinkSecret,
  mintWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  verifyWebhookSignature,
  visitorLinkSecretHash,
} from "./publicEntranceCrypto";

const NOW = 1_800_000_000_000;
const SPOKE = "11111111-1111-4111-8111-111111111111" as HubMemberId;
const HUB = "22222222-2222-4222-8222-222222222222" as HubMemberId;

function hostKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    publicKey: spki,
    fingerprint: createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex"),
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

function signedLink(key = hostKey()) {
  const secret = mintVisitorLinkSecret();
  const grant: VisitorLinkGrant = {
    v: 1,
    kind: "visitor-link",
    linkId: "AAAAAAAAAAAAAAAAAAAAAA" as VisitorLinkId,
    spokeMemberId: SPOKE,
    scope: "comment",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 3_600_000,
    revision: 1,
    secretHash: visitorLinkSecretHash("AAAAAAAAAAAAAAAAAAAAAA", secret),
  };
  return {
    key,
    secret,
    signed: {
      grant,
      signerPublicKey: key.publicKey,
      signature: key.sign(visitorLinkSigningPayload(grant)),
    },
  };
}

describe("visitor link grants", () => {
  it("opens a grant the listed spoke signed, with its secret", () => {
    const { key, secret, signed } = signedLink();
    expect(
      checkVisitorLinkGrant({
        signed,
        secret,
        nowMs: NOW,
        rosterFingerprintFor: (memberId) => (memberId === SPOKE ? key.fingerprint : undefined),
      }),
    ).toEqual({ status: "valid" });
  });

  it("a link signed by a key the roster does not list is refused", () => {
    const listed = hostKey();
    const { secret, signed } = signedLink();
    expect(
      checkVisitorLinkGrant({
        signed,
        secret,
        nowMs: NOW,
        rosterFingerprintFor: () => listed.fingerprint,
      }),
    ).toEqual({ status: "refused", kind: "unknown-signer" });
  });

  it("refuses a grant whose scope was widened after signing", () => {
    const { key, secret, signed } = signedLink();
    const widened = { ...signed, grant: { ...signed.grant, scope: "read" as const } };
    expect(
      checkVisitorLinkGrant({
        signed: { ...widened, grant: { ...widened.grant, expiresAt: NOW + 7_000_000 } },
        secret,
        nowMs: NOW,
        rosterFingerprintFor: () => key.fingerprint,
      }),
    ).toEqual({ status: "refused", kind: "bad-signature" });
  });

  it("a link whose secret does not match its hash is refused", () => {
    const { key, signed } = signedLink();
    expect(
      checkVisitorLinkGrant({
        signed,
        secret: mintVisitorLinkSecret(),
        nowMs: NOW,
        rosterFingerprintFor: () => key.fingerprint,
      }),
    ).toEqual({ status: "refused", kind: "secret-mismatch" });
  });
});

describe("webhook signatures", () => {
  const body = Buffer.from('{"action":"opened"}');

  it("verifies a Standard Webhooks signature over the id, timestamp and raw bytes", () => {
    const secret = mintWebhookSecret();
    const key = Buffer.from(secret.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key)
      .update(`msg_1.1800000000.`)
      .update(body)
      .digest("base64");
    const reading = {
      status: "read",
      deliveryId: "msg_1",
      timestampMs: 1_800_000_000_000,
      signatures: ["bm9wZQ==", signature],
    } as const;
    expect(verifyWebhookSignature({ scheme: "standard-webhooks", secret, reading, body })).toBe(
      true,
    );
    expect(
      verifyWebhookSignature({
        scheme: "standard-webhooks",
        secret,
        reading,
        body: Buffer.from('{"action":"closed"}'),
      }),
    ).toBe(false);
  });

  it("verifies GitHub's sha256 signature over the body alone", () => {
    const secret = mintWebhookSecret();
    const hex = createHmac("sha256", secret).update(body).digest("hex");
    const reading = { status: "read", deliveryId: "guid", signatures: [hex] } as const;
    expect(verifyWebhookSignature({ scheme: "github", secret, reading, body })).toBe(true);
    expect(
      verifyWebhookSignature({ scheme: "github", secret: mintWebhookSecret(), reading, body }),
    ).toBe(false);
  });
});

describe("sealed webhook secrets", () => {
  it("opens only with the recipient's sealing key and for the endpoint it was sealed for", () => {
    const recipient = makeSealingKeyPair();
    const other = makeSealingKeyPair();
    const secret = mintWebhookSecret();
    const sealed = sealWebhookSecret({
      secret,
      endpointId: "BBBBBBBBBBBBBBBBBBBBBB",
      recipientMemberId: HUB,
      recipientPublicKey: recipient.publicKey,
    });
    expect(sealed.ciphertext).not.toContain(secret);
    expect(
      openWebhookSecret({
        sealed,
        endpointId: "BBBBBBBBBBBBBBBBBBBBBB",
        privateKey: recipient.privateKey,
      }),
    ).toBe(secret);
    expect(
      openWebhookSecret({
        sealed,
        endpointId: "BBBBBBBBBBBBBBBBBBBBBB",
        privateKey: other.privateKey,
      }),
    ).toBeUndefined();
    expect(
      openWebhookSecret({
        sealed,
        endpointId: "CCCCCCCCCCCCCCCCCCCCCC",
        privateKey: recipient.privateKey,
      }),
    ).toBeUndefined();
  });
});
