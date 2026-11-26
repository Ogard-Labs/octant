import { Schema } from "effect";
import { HubMemberId } from "./hubAndSpokes";

// The hub's public entrance: visitor links, webhook deliveries, and the device
// relay. A spoke owns every link and endpoint; the hub holds only what these
// shapes carry, which never names a thread, a Project, or a routine.

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const base64Url = (min: number, max: number) =>
  Schema.String.pipe(Schema.pattern(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`)));
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const millis = Schema.Int.pipe(Schema.nonNegative());

/** Sixteen random bytes as base64url: the public half of a visitor link. */
export const VisitorLinkId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{22}$/),
  Schema.brand("VisitorLinkId"),
);
export type VisitorLinkId = typeof VisitorLinkId.Type;

/** Thirty-two random bytes as base64url. It travels only in a link's URL fragment. */
export const VisitorLinkSecret = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/));
export type VisitorLinkSecret = typeof VisitorLinkSecret.Type;

export const VisitorLinkScope = Schema.Literal("read", "comment");
export type VisitorLinkScope = typeof VisitorLinkScope.Type;

export const VISITOR_LINK_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const VISITOR_LINK_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const VISITOR_COMMENT_MAX_CHARACTERS = 4_000;
export const VISITOR_LINK_MAX_PENDING_COMMENTS = 20;
export const VISITOR_LINK_REQUESTS_PER_MINUTE = 120;
export const VISITOR_LINK_COMMENTS_PER_MINUTE = 10;

/**
 * What the spoke that owns a thread signs for one visitor link, and what the
 * hub and standbys keep. It carries no thread id: the spoke maps the link to
 * its thread, so the hub learns which spoke shares something and nothing more
 * (maintainer decision, 2026-11-26). `secretHash` lets the hub turn away a
 * wrong secret before it asks the spoke anything.
 */
export const VisitorLinkGrant = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("visitor-link"),
  linkId: VisitorLinkId,
  spokeMemberId: HubMemberId,
  scope: VisitorLinkScope,
  issuedAt: millis,
  expiresAt: millis,
  revision: Schema.Int.pipe(Schema.positive()),
  secretHash: base64Url(43, 43),
}).annotations(strict);
export type VisitorLinkGrant = typeof VisitorLinkGrant.Type;

/** A grant with the spoke's host identity key and its P-256 IEEE-P1363 signature. */
export const SignedVisitorLinkGrant = Schema.Struct({
  grant: VisitorLinkGrant,
  signerPublicKey: base64Url(80, 512),
  signature: base64Url(86, 86),
}).annotations(strict);
export type SignedVisitorLinkGrant = typeof SignedVisitorLinkGrant.Type;
export const decodeSignedVisitorLinkGrant = Schema.decodeUnknownSync(SignedVisitorLinkGrant);

export const VISITOR_LINK_REFUSAL_KINDS = [
  "unknown-signer",
  "bad-signature",
  "secret-mismatch",
  "expired",
  "lifetime-too-long",
  "revoked",
  "bound-elsewhere",
] as const;
export const VisitorLinkRefusalKind = Schema.Literal(...VISITOR_LINK_REFUSAL_KINDS);
export type VisitorLinkRefusalKind = typeof VisitorLinkRefusalKind.Type;

/** Sixteen random bytes as base64url: the path segment of a webhook URL. */
export const WebhookEndpointId = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{22}$/),
  Schema.brand("WebhookEndpointId"),
);
export type WebhookEndpointId = typeof WebhookEndpointId.Type;

/**
 * How a sender signs. Standard Webhooks signs an id and a timestamp with the
 * body; GitHub signs the body alone. Stripe's format comes later (maintainer
 * decision, 2026-11-26).
 */
export const WebhookSignatureScheme = Schema.Literal("standard-webhooks", "github");
export type WebhookSignatureScheme = typeof WebhookSignatureScheme.Type;

export const WEBHOOK_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
export const WEBHOOK_BODY_MAX_BYTES = 256 * 1024;
export const WEBHOOK_REQUESTS_PER_MINUTE = 60;
export const WEBHOOK_QUEUE_MAX_DELIVERIES = 500;
export const WEBHOOK_QUEUE_MAX_BYTES = 32 * 1024 * 1024;
export const WEBHOOK_HOLD_MS = 24 * 60 * 60 * 1000;
/** How long a spoke remembers a delivery's dedupe keys; GitHub signs no timestamp. */
export const WEBHOOK_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** The whole entrance, across every link, endpoint and device. */
export const PUBLIC_ENTRANCE_REQUESTS_PER_MINUTE = 600;
export const PUBLIC_ENTRANCE_MAX_VISITOR_STREAMS = 64;
export const PUBLIC_ENTRANCE_MAX_RELAY_TUNNELS = 32;
export const PUBLIC_ENTRANCE_MAX_HEADER_BYTES = 16 * 1024;

/**
 * A webhook secret sealed to one hub or standby: an ephemeral P-256 key, the
 * AES-256-GCM nonce, and the ciphertext with its tag. Only the recipient's
 * sealing key opens it; the recipient's host identity key is never used for it.
 */
export const SealedWebhookSecret = Schema.Struct({
  recipientMemberId: HubMemberId,
  ephemeralPublicKey: base64Url(80, 256),
  nonce: base64Url(16, 16),
  // A full 16-byte GCM tag plus at least one byte of secret.
  ciphertext: base64Url(23, 512),
}).annotations(strict);
export type SealedWebhookSecret = typeof SealedWebhookSecret.Type;

/** What the hub and standbys hold of one endpoint: never the routine it starts. */
export const HubWebhookEndpoint = Schema.Struct({
  endpointId: WebhookEndpointId,
  spokeMemberId: HubMemberId,
  scheme: WebhookSignatureScheme,
  sealedSecrets: Schema.Array(SealedWebhookSecret).pipe(Schema.minItems(1), Schema.maxItems(16)),
}).annotations(strict);
export type HubWebhookEndpoint = typeof HubWebhookEndpoint.Type;
export const decodeHubWebhookEndpoint = Schema.decodeUnknownSync(HubWebhookEndpoint);

/** The headers a delivery keeps on its way to the spoke: the ones its scheme signs or names. */
export const WEBHOOK_FORWARDED_HEADERS = [
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "x-hub-signature-256",
  "x-github-delivery",
  "x-github-event",
  "content-type",
] as const;

/**
 * One delivery as the hub queues and forwards it: the original bytes and the
 * headers the spoke needs to check them again. `deliveryId` is the sender's
 * own id; the spoke's dedupe keys come from it and, for GitHub, the body.
 */
export const WebhookDeliveryEnvelope = Schema.Struct({
  endpointId: WebhookEndpointId,
  deliveryId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  receivedAt: millis,
  headers: Schema.Record({
    key: Schema.String.pipe(
      Schema.filter((name) => (WEBHOOK_FORWARDED_HEADERS as ReadonlyArray<string>).includes(name)),
    ),
    value: Schema.String.pipe(Schema.maxLength(4096)),
  }),
  /** The original body as base64; a 256 KiB body is at most this long. */
  body: Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/),
    Schema.maxLength(Math.ceil(WEBHOOK_BODY_MAX_BYTES / 3) * 4),
  ),
}).annotations(strict);
export type WebhookDeliveryEnvelope = typeof WebhookDeliveryEnvelope.Type;
export const decodeWebhookDeliveryEnvelope = Schema.decodeUnknownSync(WebhookDeliveryEnvelope);

export const WEBHOOK_REFUSAL_KINDS = [
  "endpoint-off",
  "missing-signature",
  "bad-signature",
  "stale-timestamp",
  "too-large",
  "rate-limited",
  "queue-full",
] as const;
export const WebhookRefusalKind = Schema.Literal(...WEBHOOK_REFUSAL_KINDS);
export type WebhookRefusalKind = typeof WebhookRefusalKind.Type;

/** A body digest as the spoke remembers it beside a delivery id. */
export const WebhookBodyDigest = digest;
