// Pure rules of the hub's public entrance: what a webhook delivery's headers
// say, whether a delivery may start its routine, and whether a visitor link
// opens. The crypto runs on the server; these rules take its answers, so the
// order of the checks (signature before timestamp before dedupe) is fixed here.

import {
  VISITOR_LINK_MAX_LIFETIME_MS,
  WEBHOOK_TIMESTAMP_WINDOW_MS,
  type VisitorLinkGrant,
  type VisitorLinkRefusalKind,
  type WebhookRefusalKind,
  type WebhookSignatureScheme,
} from "@octant/contracts";
import { tailscaleAddressKey } from "./remoteAccessPolicy";
import { redactSecretsAndPrivateKeys } from "./secretShapedTextPolicy";

export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export type WebhookHeaderReading =
  | {
      readonly status: "read";
      /**
       * Absent for Stripe, whose event id is inside the signed body and is
       * read only once the signature passes ({@link stripeEventId}).
       */
      readonly deliveryId?: string;
      /** Present only for a scheme that signs a timestamp. */
      readonly timestampMs?: number;
      /** The signatures to compare: base64 for Standard Webhooks, hex for GitHub and Stripe. */
      readonly signatures: ReadonlyArray<string>;
      readonly event?: string;
    }
  | { readonly status: "refused"; readonly kind: "missing-signature" };

const MISSING = { status: "refused", kind: "missing-signature" } as const;
const MAX_DELIVERY_ID = 256;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" || trimmed.length > MAX_DELIVERY_ID
    ? undefined
    : trimmed;
}

/**
 * Reads the headers a scheme signs or names. A missing or malformed header is
 * one refusal: a sender learns nothing about which part was wrong.
 */
export function readWebhookHeaders(
  scheme: WebhookSignatureScheme,
  headers: WebhookHeaders,
): WebhookHeaderReading {
  if (scheme === "standard-webhooks") {
    const deliveryId = nonEmpty(headers["webhook-id"]);
    const timestamp = headers["webhook-timestamp"]?.trim() ?? "";
    if (deliveryId === undefined || !/^\d{1,12}$/.test(timestamp)) return MISSING;
    // A header may list several signatures, space-separated, each `version,base64`;
    // only v1 (HMAC-SHA256) is understood.
    const signatures = (headers["webhook-signature"] ?? "")
      .split(" ")
      .filter((entry) => entry.startsWith("v1,"))
      .map((entry) => entry.slice(3))
      .filter((value) => /^[A-Za-z0-9+/]+=*$/.test(value));
    if (signatures.length === 0) return MISSING;
    return {
      status: "read",
      deliveryId,
      timestampMs: Number(timestamp) * 1000,
      signatures,
    };
  }
  if (scheme === "stripe") {
    // `t=<seconds>,v1=<hex>[,v1=<hex>...]`; `v0` and any other scheme are ignored.
    let timestamp: string | undefined;
    const signatures: string[] = [];
    for (const entry of (headers["stripe-signature"] ?? "").split(",")) {
      const [name, value = ""] = entry.trim().split("=", 2);
      if (name === "t" && timestamp === undefined) timestamp = value;
      if (name === "v1" && /^[0-9a-f]{64}$/i.test(value)) signatures.push(value.toLowerCase());
    }
    if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0) {
      return MISSING;
    }
    return { status: "read", timestampMs: Number(timestamp) * 1000, signatures };
  }
  const deliveryId = nonEmpty(headers["x-github-delivery"]);
  const header = headers["x-hub-signature-256"]?.trim() ?? "";
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header);
  if (deliveryId === undefined || match?.[1] === undefined) return MISSING;
  const event = nonEmpty(headers["x-github-event"]);
  return {
    status: "read",
    deliveryId,
    signatures: [match[1].toLowerCase()],
    ...(event === undefined ? {} : { event }),
  };
}

/**
 * The event id of a Stripe delivery, from its body. Read only after the
 * signature passed, so an unsigned body can never name a claim.
 */
export function stripeEventId(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) return undefined;
  return typeof parsed.id === "string" ? nonEmpty(parsed.id) : undefined;
}

/**
 * The keys a spoke claims for one delivery. GitHub's delivery id is not under
 * its signature, so a captured body could come back under a fresh id; the body's
 * digest is a second key, and either one already claimed makes it a duplicate.
 */
export function webhookDedupeKeys(
  input:
    | { readonly scheme: "standard-webhooks" | "stripe"; readonly deliveryId: string }
    | { readonly scheme: "github"; readonly deliveryId: string; readonly bodyDigest: string },
): ReadonlyArray<string> {
  return input.scheme === "github"
    ? [`id:${input.deliveryId}`, `body:${input.bodyDigest}`]
    : [`id:${input.deliveryId}`];
}

export type WebhookDeliveryDecision =
  | { readonly status: "accept"; readonly claimKeys: ReadonlyArray<string> }
  | { readonly status: "duplicate" }
  | { readonly status: "refused"; readonly kind: WebhookRefusalKind };

/**
 * Whether a delivery may start its routine. The hub runs it before it queues,
 * and the spoke runs it again on the original bytes before it claims; only the
 * spoke's `claimed` is the record that decides a duplicate.
 */
export function decideWebhookDelivery(input: {
  readonly endpointEnabled: boolean;
  readonly signatureMatches: boolean;
  /** Absent for a scheme that signs no timestamp. */
  readonly timestampMs?: number;
  /**
   * When the delivery reached the public entrance. The hub passes its clock;
   * a spoke judging a delivery the hub held passes the hub's receipt time, so
   * a hold of up to a day does not make a signature taken on time stale.
   */
  readonly nowMs: number;
  readonly dedupeKeys: ReadonlyArray<string>;
  readonly claimed: (key: string) => boolean;
}): WebhookDeliveryDecision {
  if (!input.endpointEnabled) return { status: "refused", kind: "endpoint-off" };
  if (!input.signatureMatches) return { status: "refused", kind: "bad-signature" };
  if (
    input.timestampMs !== undefined &&
    Math.abs(input.nowMs - input.timestampMs) > WEBHOOK_TIMESTAMP_WINDOW_MS
  ) {
    return { status: "refused", kind: "stale-timestamp" };
  }
  if (input.dedupeKeys.some((key) => input.claimed(key))) return { status: "duplicate" };
  return { status: "accept", claimKeys: input.dedupeKeys };
}

/** The text a hub signs for its sealing key. */
export function hubSealingKeyPayload(memberId: string, sealingPublicKey: string): string {
  return `octant/sealing-key/v1|${memberId}|${sealingPublicKey}`;
}

/** The text a viewer's key signs for one request. */
export function visitorProofPayload(input: {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
}): string {
  return `octant/visitor-proof/v1|${input.method}|${input.path}|${input.timestamp}|${input.nonce}`;
}

const VISITOR_LINK_DOMAIN = "octant/visitor-link/v1";

/** The text a spoke signs for a grant: a domain line, then the grant as JSON with sorted keys. */
export function visitorLinkSigningPayload(grant: VisitorLinkGrant): string {
  const sorted = Object.fromEntries(
    Object.entries(grant).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return `${VISITOR_LINK_DOMAIN}\n${JSON.stringify(sorted)}`;
}

/** The text whose SHA-256 a grant carries as `secretHash`. */
export function visitorLinkSecretHashInput(linkId: string, secret: string): string {
  return `${VISITOR_LINK_DOMAIN}|${linkId}|${secret}`;
}

export type VisitorLinkDecision =
  | { readonly status: "valid" }
  | { readonly status: "refused"; readonly kind: VisitorLinkRefusalKind };

/**
 * Whether the hub may carry a visitor's request for this grant to its spoke.
 * The spoke still checks revocation, archive state and the browser binding on
 * every fetch; this is what the hub can rule on alone.
 */
export function decideVisitorLink(input: {
  readonly grant: VisitorLinkGrant;
  readonly nowMs: number;
  /** The signer's key fingerprint is the roster's key for `grant.spokeMemberId`. */
  readonly signerListed: boolean;
  readonly signatureValid: boolean;
  readonly secretMatches: boolean;
}): VisitorLinkDecision {
  if (!input.signerListed) return { status: "refused", kind: "unknown-signer" };
  if (!input.signatureValid) return { status: "refused", kind: "bad-signature" };
  if (input.grant.expiresAt - input.grant.issuedAt > VISITOR_LINK_MAX_LIFETIME_MS) {
    return { status: "refused", kind: "lifetime-too-long" };
  }
  // The secret is checked before expiry so that someone holding only a link id
  // cannot tell an expired link from a live one.
  if (!input.secretMatches) return { status: "refused", kind: "secret-mismatch" };
  if (input.nowMs >= input.grant.expiresAt) return { status: "refused", kind: "expired" };
  return { status: "valid" };
}

// A path names the person's folders and account; a visitor reads none of them.
// Any absolute path of two or more parts is one, whatever its first folder,
// since a fixed list of roots let `/workspace/...` and `/data/...` through.
// Web addresses are left alone, including any path inside one: a login link's
// `?next=/docs/start` names a page on that site, not a folder on the person's
// computer. A `file:` URL is a path and goes. The address ends at a bracket,
// comma or semicolon, so a path right after it, as in a Markdown link
// `[https://example.com](/home/...)`, is still redacted; a web address that
// really holds one of those loses only its tail to the path check.
const WEB_URL = /(?<![\w.+-])(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()[\],;]*/gi;
const FILE_URL = /(^|[\s("'`=:,;])file:\/\/[^\s"'`)<>,;]*/gi;
const UNIX_PATH = /(^|[\s("'`=:,;])(?:~|\/[\w.@+-]+)\/[^\s"'`)<>,;]*/g;
const WINDOWS_PATH = /(^|[\s("'`=:,;])[A-Za-z]:[\\/][^\s"'`)<>,;]*/g;
const NETWORK_SHARE = /(^|[\s("'`=:,;])\\\\[^\s\\"'`)<>,;]+\\[^\s"'`)<>,;]*/g;

/** Message text as a visitor may read it: no secret-shaped value and no file-system path. */
export function redactForVisitor(text: string): string {
  const redacted = redactSecretsAndPrivateKeys(text);
  let out = "";
  let last = 0;
  for (const match of redacted.matchAll(WEB_URL)) {
    out += redactPaths(redacted.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + redactPaths(redacted.slice(last));
}

function redactPaths(text: string): string {
  return text
    .replace(FILE_URL, "$1[path]")
    .replace(UNIX_PATH, "$1[path]")
    .replace(WINDOWS_PATH, "$1[path]")
    .replace(NETWORK_SHARE, "$1[path]");
}

/** How many front addresses one entrance lists. */
export const PUBLIC_FRONTS_MAX = 8;

export type PublicFrontsReading =
  | { readonly status: "read"; readonly fronts: ReadonlyArray<string> }
  | {
      readonly status: "refused";
      readonly kind: "not-a-tailscale-address";
      readonly address: string;
    }
  | { readonly status: "refused"; readonly kind: "too-many" };

/**
 * The addresses of the person's own proxy on another machine. Each is a
 * Tailscale address literal: the entrance on the hub's Tailscale address
 * answers nothing else, so a LAN, public or wildcard address, or a name that
 * could resolve to one, is refused.
 */
export function readPublicFronts(addresses: ReadonlyArray<string>): PublicFrontsReading {
  if (addresses.length > PUBLIC_FRONTS_MAX) return { status: "refused", kind: "too-many" };
  const fronts: string[] = [];
  for (const address of addresses) {
    const written = address.trim().toLowerCase();
    if (tailscaleAddressKey(written) === undefined) {
      return { status: "refused", kind: "not-a-tailscale-address", address };
    }
    if (!fronts.includes(written)) fronts.push(written);
  }
  return { status: "read", fronts };
}

/** Whether a connection's peer is one of the listed fronts. */
export function publicFrontAdmitted(
  remoteAddress: string | undefined,
  fronts: ReadonlyArray<string>,
): boolean {
  const key = remoteAddress === undefined ? undefined : tailscaleAddressKey(remoteAddress);
  return key !== undefined && fronts.some((front) => tailscaleAddressKey(front) === key);
}

export type PublicEntranceBind =
  | { readonly kind: "loopback" }
  | { readonly kind: "tailnet"; readonly address: string }
  | {
      readonly kind: "refused";
      readonly reason:
        | "no-tailnet-address"
        | "no-tailnet-certificate"
        | "no-front-in-address-family";
    };

/**
 * Where the entrance listens. With no front listed, on loopback for a front
 * on the same machine. With fronts listed, on the hub's own Tailscale address
 * with its Tailscale certificate, and nowhere else: an address that is not a
 * Tailscale one (a wildcard, LAN or public address) refuses the bind rather
 * than fall back to it. A listener on an IPv4 address takes no IPv6 peer and
 * the reverse, so a list with no front of the bound address's family, which
 * would admit nothing, is refused too.
 */
export function decidePublicEntranceBind(input: {
  readonly fronts: ReadonlyArray<string>;
  readonly tailnetAddress: string | undefined;
  readonly certificate: boolean;
}): PublicEntranceBind {
  if (input.fronts.length === 0) return { kind: "loopback" };
  const address = input.tailnetAddress?.trim().toLowerCase();
  if (address === undefined || tailscaleAddressKey(address) === undefined) {
    return { kind: "refused", reason: "no-tailnet-address" };
  }
  if (!input.certificate) return { kind: "refused", reason: "no-tailnet-certificate" };
  const ipv6 = address.includes(":");
  if (!input.fronts.some((front) => front.includes(":") === ipv6)) {
    return { kind: "refused", reason: "no-front-in-address-family" };
  }
  return { kind: "tailnet", address };
}
