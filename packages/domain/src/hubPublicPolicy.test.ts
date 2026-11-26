import type { HubMemberId, VisitorLinkId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decideVisitorLink,
  decideWebhookDelivery,
  readWebhookHeaders,
  visitorLinkSigningPayload,
  webhookDedupeKeys,
} from "./hubPublicPolicy";

const NOW = 1_800_000_000_000;
const seconds = (ms: number) => String(Math.floor(ms / 1000));

describe("webhook headers", () => {
  it("reads a Standard Webhooks delivery's id, timestamp and every signature it lists", () => {
    const read = readWebhookHeaders("standard-webhooks", {
      "webhook-id": "msg_1",
      "webhook-timestamp": seconds(NOW),
      "webhook-signature": "v1,AAAA v1,BBBB v2,CCCC",
    });
    expect(read).toEqual({
      status: "read",
      deliveryId: "msg_1",
      timestampMs: Math.floor(NOW / 1000) * 1000,
      signatures: ["AAAA", "BBBB"],
    });
  });

  it("refuses a Standard Webhooks delivery with no v1 signature", () => {
    expect(
      readWebhookHeaders("standard-webhooks", {
        "webhook-id": "msg_1",
        "webhook-timestamp": seconds(NOW),
        "webhook-signature": "v2,CCCC",
      }),
    ).toEqual({ status: "refused", kind: "missing-signature" });
  });

  it("reads a GitHub delivery's guid, event and hex signature", () => {
    const signature = "a".repeat(64);
    expect(
      readWebhookHeaders("github", {
        "x-hub-signature-256": `sha256=${signature}`,
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-github-event": "push",
      }),
    ).toEqual({
      status: "read",
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      signatures: [signature],
      event: "push",
    });
  });

  it("refuses a GitHub delivery signed with the older SHA-1 header only", () => {
    expect(
      readWebhookHeaders("github", {
        "x-hub-signature": "sha1=abc",
        "x-github-delivery": "guid",
      }),
    ).toEqual({ status: "refused", kind: "missing-signature" });
  });
});

describe("deciding a delivery", () => {
  const signed = {
    endpointEnabled: true,
    signatureMatches: true,
    claimed: () => false,
  } as const;

  it("refuses a delivery whose timestamp is older than five minutes", () => {
    expect(
      decideWebhookDelivery({
        ...signed,
        timestampMs: NOW - 5 * 60_000 - 1_000,
        nowMs: NOW,
        dedupeKeys: ["id:msg_1"],
      }),
    ).toEqual({ status: "refused", kind: "stale-timestamp" });
  });

  it("refuses a delivery dated more than five minutes ahead", () => {
    expect(
      decideWebhookDelivery({
        ...signed,
        timestampMs: NOW + 5 * 60_000 + 1_000,
        nowMs: NOW,
        dedupeKeys: ["id:msg_1"],
      }),
    ).toEqual({ status: "refused", kind: "stale-timestamp" });
  });

  it("refuses a bad signature before it looks at anything else", () => {
    expect(
      decideWebhookDelivery({
        ...signed,
        signatureMatches: false,
        timestampMs: NOW - 60 * 60_000,
        nowMs: NOW,
        dedupeKeys: ["id:msg_1"],
      }),
    ).toEqual({ status: "refused", kind: "bad-signature" });
  });

  it("refuses every delivery to an endpoint that is off", () => {
    expect(
      decideWebhookDelivery({
        ...signed,
        endpointEnabled: false,
        nowMs: NOW,
        dedupeKeys: ["id:x"],
      }),
    ).toEqual({ status: "refused", kind: "endpoint-off" });
  });

  it("a redelivered webhook id starts no second run", () => {
    const claimedKeys = new Set<string>();
    const deliver = () =>
      decideWebhookDelivery({
        ...signed,
        timestampMs: NOW,
        nowMs: NOW,
        dedupeKeys: webhookDedupeKeys({ scheme: "standard-webhooks", deliveryId: "msg_1" }),
        claimed: (key) => claimedKeys.has(key),
      });
    const first = deliver();
    expect(first).toEqual({ status: "accept", claimKeys: ["id:msg_1"] });
    if (first.status === "accept") for (const key of first.claimKeys) claimedKeys.add(key);
    expect(deliver()).toEqual({ status: "duplicate" });
  });

  it("a GitHub delivery replayed under a new delivery id starts nothing", () => {
    const bodyDigest = "b".repeat(64);
    const claimedKeys = new Set(
      webhookDedupeKeys({ scheme: "github", deliveryId: "guid-1", bodyDigest }),
    );
    expect(
      decideWebhookDelivery({
        ...signed,
        nowMs: NOW,
        dedupeKeys: webhookDedupeKeys({ scheme: "github", deliveryId: "guid-2", bodyDigest }),
        claimed: (key) => claimedKeys.has(key),
      }),
    ).toEqual({ status: "duplicate" });
  });

  it("a GitHub delivery needs no timestamp, because GitHub signs none", () => {
    expect(
      decideWebhookDelivery({
        ...signed,
        nowMs: NOW,
        dedupeKeys: webhookDedupeKeys({
          scheme: "github",
          deliveryId: "g",
          bodyDigest: "c".repeat(64),
        }),
      }).status,
    ).toBe("accept");
  });
});

describe("visitor links", () => {
  const grant = {
    v: 1 as const,
    kind: "visitor-link" as const,
    linkId: "AAAAAAAAAAAAAAAAAAAAAA" as VisitorLinkId,
    spokeMemberId: "11111111-1111-4111-8111-111111111111" as HubMemberId,
    scope: "read" as const,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    revision: 1,
    secretHash: "h".repeat(43),
  };
  const valid = {
    grant,
    nowMs: NOW,
    signerListed: true,
    signatureValid: true,
    secretMatches: true,
  } as const;

  it("signs a fixed text: the domain line, then the grant's keys in sorted order", () => {
    const payload = visitorLinkSigningPayload(grant);
    expect(payload.startsWith("octant/visitor-link/v1\n{")).toBe(true);
    const keys = Object.keys(JSON.parse(payload.slice(payload.indexOf("\n") + 1)));
    expect(keys).toEqual([...keys].sort());
    expect(visitorLinkSigningPayload({ ...grant })).toBe(payload);
  });

  it("accepts a grant that is signed, listed, unexpired and opened with its secret", () => {
    expect(decideVisitorLink(valid)).toEqual({ status: "valid" });
  });

  it("a link signed by a key the roster does not list is refused", () => {
    expect(decideVisitorLink({ ...valid, signerListed: false })).toEqual({
      status: "refused",
      kind: "unknown-signer",
    });
  });

  it("a link whose secret does not match its hash is refused", () => {
    expect(decideVisitorLink({ ...valid, secretMatches: false })).toEqual({
      status: "refused",
      kind: "secret-mismatch",
    });
  });

  it("refuses an expired link and one that would outlive seven days", () => {
    expect(decideVisitorLink({ ...valid, nowMs: grant.expiresAt })).toEqual({
      status: "refused",
      kind: "expired",
    });
    expect(
      decideVisitorLink({
        ...valid,
        grant: { ...grant, expiresAt: grant.issuedAt + 7 * 24 * 3_600_000 + 1 },
      }),
    ).toEqual({ status: "refused", kind: "lifetime-too-long" });
  });
});
