import type { HubMemberId, VisitorLinkId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  decidePublicEntranceBind,
  decideVisitorLink,
  decideWebhookDelivery,
  publicFrontAdmitted,
  readPublicFronts,
  readWebhookHeaders,
  redactForVisitor,
  stripeEventId,
  visitorLinkSigningPayload,
  webhookDedupeKeys,
  publicFrontOrigin,
  relayUrlForPublicOrigin,
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

describe("Stripe webhook headers", () => {
  it("reads a Stripe delivery's timestamp and every v1 signature, ignoring v0", () => {
    const one = "a".repeat(64);
    const two = "B".repeat(64);
    expect(
      readWebhookHeaders("stripe", {
        "stripe-signature": `t=${seconds(NOW)},v1=${one},v0=${"c".repeat(64)},v1=${two}`,
      }),
    ).toEqual({
      status: "read",
      timestampMs: Math.floor(NOW / 1000) * 1000,
      signatures: [one, two.toLowerCase()],
    });
  });

  it("refuses a Stripe delivery with no timestamp or no v1 signature", () => {
    expect(readWebhookHeaders("stripe", { "stripe-signature": `v1=${"a".repeat(64)}` })).toEqual({
      status: "refused",
      kind: "missing-signature",
    });
    expect(
      readWebhookHeaders("stripe", {
        "stripe-signature": `t=${seconds(NOW)},v0=${"a".repeat(64)}`,
      }),
    ).toEqual({ status: "refused", kind: "missing-signature" });
    expect(readWebhookHeaders("stripe", {})).toEqual({
      status: "refused",
      kind: "missing-signature",
    });
  });

  it("names a Stripe delivery by the event id in its body", () => {
    expect(stripeEventId('{"id":"evt_1","type":"invoice.paid"}')).toBe("evt_1");
    expect(stripeEventId('{"type":"invoice.paid"}')).toBeUndefined();
    expect(stripeEventId("not json")).toBeUndefined();
    expect(stripeEventId(`{"id":"${"e".repeat(257)}"}`)).toBeUndefined();
  });

  it("a Stripe delivery signed more than five minutes ago is refused", () => {
    const read = readWebhookHeaders("stripe", {
      "stripe-signature": `t=${seconds(NOW - 5 * 60_000 - 1_000)},v1=${"a".repeat(64)}`,
    });
    if (read.status !== "read") throw new Error(read.kind);
    expect(
      decideWebhookDelivery({
        endpointEnabled: true,
        signatureMatches: true,
        ...(read.timestampMs === undefined ? {} : { timestampMs: read.timestampMs }),
        nowMs: NOW,
        dedupeKeys: webhookDedupeKeys({ scheme: "stripe", deliveryId: "evt_1" }),
        claimed: () => false,
      }),
    ).toEqual({ status: "refused", kind: "stale-timestamp" });
  });

  it("a redelivered Stripe event starts no second run", () => {
    const claimedKeys = new Set(webhookDedupeKeys({ scheme: "stripe", deliveryId: "evt_1" }));
    expect(
      decideWebhookDelivery({
        endpointEnabled: true,
        signatureMatches: true,
        timestampMs: NOW,
        nowMs: NOW,
        dedupeKeys: webhookDedupeKeys({ scheme: "stripe", deliveryId: "evt_1" }),
        claimed: (key) => claimedKeys.has(key),
      }),
    ).toEqual({ status: "duplicate" });
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

  it("accepts a delivery exactly five minutes old and refuses one a millisecond older", () => {
    const at = (timestampMs: number) =>
      decideWebhookDelivery({ ...signed, timestampMs, nowMs: NOW, dedupeKeys: ["id:msg_1"] });
    expect(at(NOW - 5 * 60_000)).toEqual({ status: "accept", claimKeys: ["id:msg_1"] });
    expect(at(NOW - 5 * 60_000 - 1)).toEqual({ status: "refused", kind: "stale-timestamp" });
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

  it("answers a wrong secret the same way whether or not the link has expired", () => {
    expect(decideVisitorLink({ ...valid, secretMatches: false, nowMs: grant.expiresAt })).toEqual({
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

describe("what a visitor reads", () => {
  it("never carries an absolute path, a home-relative path, or a secret-shaped value", () => {
    const text = redactForVisitor(
      "Edited /Users/ada/dev/app/src/main.ts and C:\\Users\\ada\\notes.txt, see ~/secrets/.env; key ghp_" +
        "a".repeat(36),
    );
    expect(text).not.toContain("/Users/ada");
    expect(text).not.toContain("C:\\Users");
    expect(text).not.toContain("~/secrets");
    expect(text).not.toContain("ghp_");
    expect(text).toContain("[path]");
  });

  it("redacts an absolute path under any folder, a network share, and a file URL", () => {
    const text = redactForVisitor(
      "Read /workspace/private-project/strategy.md and /data/customer/export.csv, " +
        "then \\\\fileserver\\finance\\q3.xlsx, D:/clients/acme/plan.md and file:///srv/app/env.",
    );
    expect(text).not.toContain("private-project");
    expect(text).not.toContain("customer");
    expect(text).not.toContain("fileserver");
    expect(text).not.toContain("acme");
    expect(text).not.toContain("/srv/app");
  });

  it("leaves ordinary prose and web addresses alone", () => {
    expect(redactForVisitor("The build passed; see https://example.com/a/b for notes.")).toBe(
      "The build passed; see https://example.com/a/b for notes.",
    );
  });

  it("keeps a path inside a web address, such as a login link's next page", () => {
    expect(redactForVisitor("Sign in at https://example.com/login?next=/docs/start first.")).toBe(
      "Sign in at https://example.com/login?next=/docs/start first.",
    );
    expect(redactForVisitor("See https://example.com/a?next=/docs then /srv/app/env too")).toBe(
      "See https://example.com/a?next=/docs then [path] too",
    );
  });

  it("still redacts a path that only sits next to a web address", () => {
    expect(redactForVisitor("[https://example.com](/home/alice/private/notes.md)")).toBe(
      "[https://example.com]([path])",
    );
    expect(redactForVisitor("https://example.com,/home/alice/notes.md")).toBe(
      "https://example.com,[path]",
    );
  });
});

describe("a front on another machine", () => {
  it("takes only Tailscale addresses as front addresses", () => {
    expect(readPublicFronts([" 100.101.102.103 ", "FD7A:115C:A1E0::1"])).toEqual({
      status: "read",
      fronts: ["100.101.102.103", "fd7a:115c:a1e0::1"],
    });
    for (const address of [
      "192.168.1.20",
      "10.0.0.5",
      "8.8.8.8",
      "0.0.0.0",
      "::",
      "127.0.0.1",
      "vps.tail1234.ts.net",
      "100.064.1.1",
    ]) {
      expect(readPublicFronts([address])).toEqual({
        status: "refused",
        kind: "not-a-tailscale-address",
        address,
      });
    }
    expect(readPublicFronts(Array.from({ length: 9 }, (_, index) => `100.64.0.${index}`))).toEqual({
      status: "refused",
      kind: "too-many",
    });
  });

  it("admits a connection only from a listed front, in whichever form the socket reports it", () => {
    const fronts = ["100.101.102.103", "fd7a:115c:a1e0::1"];
    expect(publicFrontAdmitted("100.101.102.103", fronts)).toBe(true);
    expect(publicFrontAdmitted("::ffff:100.101.102.103", fronts)).toBe(true);
    expect(publicFrontAdmitted("fd7a:115c:a1e0:0:0:0:0:1", fronts)).toBe(true);
    expect(publicFrontAdmitted("100.101.102.104", fronts)).toBe(false);
    expect(publicFrontAdmitted("127.0.0.1", fronts)).toBe(false);
    expect(publicFrontAdmitted(undefined, fronts)).toBe(false);
  });

  it("binds the hub's Tailscale address with its certificate, and never a wildcard, LAN or public one", () => {
    expect(
      decidePublicEntranceBind({ fronts: [], tailnetAddress: undefined, certificate: false }),
    ).toEqual({ kind: "loopback" });
    expect(
      decidePublicEntranceBind({
        fronts: ["100.101.102.103"],
        tailnetAddress: "100.90.1.2",
        certificate: true,
      }),
    ).toEqual({ kind: "tailnet", address: "100.90.1.2" });
    for (const address of ["0.0.0.0", "::", "192.168.1.20", "203.0.113.9", undefined]) {
      expect(
        decidePublicEntranceBind({
          fronts: ["100.101.102.103"],
          tailnetAddress: address,
          certificate: true,
        }),
      ).toEqual({ kind: "refused", reason: "no-tailnet-address" });
    }
    expect(
      decidePublicEntranceBind({
        fronts: ["100.101.102.103"],
        tailnetAddress: "100.90.1.2",
        certificate: false,
      }),
    ).toEqual({ kind: "refused", reason: "no-tailnet-certificate" });
  });

  it("refuses a front list none of whose addresses can reach the bound address's family", () => {
    expect(
      decidePublicEntranceBind({
        fronts: ["fd7a:115c:a1e0::1"],
        tailnetAddress: "100.90.1.2",
        certificate: true,
      }),
    ).toEqual({ kind: "refused", reason: "no-front-in-address-family" });
    expect(
      decidePublicEntranceBind({
        fronts: ["100.101.102.103"],
        tailnetAddress: "fd7a:115c:a1e0::2",
        certificate: true,
      }),
    ).toEqual({ kind: "refused", reason: "no-front-in-address-family" });
    expect(
      decidePublicEntranceBind({
        fronts: ["fd7a:115c:a1e0::1", "100.101.102.103"],
        tailnetAddress: "100.90.1.2",
        certificate: true,
      }),
    ).toEqual({ kind: "tailnet", address: "100.90.1.2" });
  });
});

describe("the public address a person types for their own front", () => {
  it("takes an https origin with a DNS name and derives its relay route", () => {
    expect(publicFrontOrigin("  https://Octant.Example.com/  ")).toBe("https://octant.example.com");
    expect(publicFrontOrigin("https://hub.example.com:8443")).toBe("https://hub.example.com:8443");
    expect(relayUrlForPublicOrigin("https://hub.example.com:8443")).toBe(
      "wss://hub.example.com:8443/relay/v1",
    );
  });

  it("refuses anything but a bare https origin with a DNS name", () => {
    for (const text of [
      "http://hub.example.com",
      "https://user:secret@hub.example.com",
      "https://hub.example.com/path",
      "https://hub.example.com?query=1",
      "https://hub.example.com#part",
      "https://100.101.104.1",
      "https://localhost",
      "hub.example.com",
      "",
    ]) {
      expect(publicFrontOrigin(text), text).toBeUndefined();
    }
  });
});
