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

/** The public ports Tailscale Funnel listens on; nothing else can be asked for. */
export const PUBLIC_FUNNEL_PORTS = [443, 8443, 10000] as const;
export const PublicFunnelPort = Schema.Literal(...PUBLIC_FUNNEL_PORTS);
export type PublicFunnelPort = typeof PublicFunnelPort.Type;

/** A window turns this host's public entrance on or off. */
export const HubPublicEntranceSwitchRequest = Schema.Struct({
  enabled: Schema.Boolean,
}).annotations(strict);
export const decodeHubPublicEntranceSwitchRequest = Schema.decodeUnknownSync(
  HubPublicEntranceSwitchRequest,
);

/** A window turns the built-in Funnel front on (on one public port) or off. */
export const HubPublicFunnelRequest = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optional(PublicFunnelPort),
}).annotations(strict);
export const decodeHubPublicFunnelRequest = Schema.decodeUnknownSync(HubPublicFunnelRequest);

/** The most raw bytes a forwarded request or its answer carries, before base64. */
export const PUBLIC_FORWARD_MAX_BODY_BYTES = 512 * 1024;

/**
 * The most bytes a forwarded request or answer takes on the private link: the
 * largest body as base64 inside its JSON envelope, with room for headers. The
 * route policy and the pinned transport both hold to it, so neither cuts off
 * an answer the other let through.
 */
export const PUBLIC_FORWARD_MAX_WIRE_BYTES = 768 * 1024;

/**
 * A request a member's entrance admitted and hands to the acting hub over the
 * pinned private transport, unchanged except for the headers the entrance
 * never passes on (cookies, credentials, and forwarding claims).
 */
export const PublicForwardEnvelope = Schema.Struct({
  method: Schema.Literal("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"),
  path: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2048)),
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.String,
}).annotations(strict);
export type PublicForwardEnvelope = typeof PublicForwardEnvelope.Type;
export const decodePublicForwardEnvelope = Schema.decodeUnknownSync(PublicForwardEnvelope);

/** The acting hub's answer to a forwarded request, carried back unchanged. */
export const PublicForwardAnswer = Schema.Struct({
  // An interim 1xx answer has no place in a forwarded reply.
  status: Schema.Int.pipe(Schema.between(200, 599)),
  headers: Schema.Record({ key: Schema.String, value: Schema.String }),
  body: Schema.String,
}).annotations(strict);
export type PublicForwardAnswer = typeof PublicForwardAnswer.Type;
export const decodePublicForwardAnswer = Schema.decodeUnknownSync(PublicForwardAnswer);

/**
 * A hub's or standby's key for opening sealed webhook secrets, signed with its
 * host identity key. A spoke takes it only when the signer's fingerprint is
 * the one the roster lists for `memberId`, so the identity key itself is never
 * used for key agreement.
 */
export const HubSealingKey = Schema.Struct({
  memberId: HubMemberId,
  sealingPublicKey: base64Url(80, 128),
  signerPublicKey: base64Url(80, 512),
  signature: base64Url(86, 86),
}).annotations(strict);
export type HubSealingKey = typeof HubSealingKey.Type;
export const decodeHubSealingKey = Schema.decodeUnknownSync(HubSealingKey);

export const HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE = 64;

/** Everything one spoke lets the hub hold for webhooks: it replaces what the hub held for it. */
export const HubWebhookEndpointsUpdate = Schema.Struct({
  endpoints: Schema.Array(HubWebhookEndpoint).pipe(
    Schema.maxItems(HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE),
  ),
}).annotations(strict);
export type HubWebhookEndpointsUpdate = typeof HubWebhookEndpointsUpdate.Type;
export const decodeHubWebhookEndpointsUpdate = Schema.decodeUnknownSync(HubWebhookEndpointsUpdate);

/**
 * What a spoke answers a forwarded delivery. Every answer takes it off the
 * hub's queue except `busy`, which leaves it for a later look within the hold.
 */
export const WebhookDeliveryAnswer = Schema.Union(
  Schema.Struct({ status: Schema.Literal("accepted", "duplicate") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    kind: Schema.Literal(
      ...WEBHOOK_REFUSAL_KINDS,
      "public-not-granted",
      "unknown-endpoint",
      "busy",
      // The spoke's person paused remote access; the hub keeps the delivery.
      "paused",
    ),
  }).annotations(strict),
);
export type WebhookDeliveryAnswer = typeof WebhookDeliveryAnswer.Type;
export const decodeWebhookDeliveryAnswer = Schema.decodeUnknownSync(WebhookDeliveryAnswer);

/** A window on a spoke mints a webhook endpoint for its routines. */
export const HubWebhookCreateRequest = Schema.Struct({
  scheme: WebhookSignatureScheme,
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
}).annotations(strict);
export const decodeHubWebhookCreateRequest = Schema.decodeUnknownSync(HubWebhookCreateRequest);

/** A window on a spoke rotates or removes one of its endpoints. */
export const HubWebhookEndpointRequest = Schema.Struct({
  endpointId: WebhookEndpointId,
}).annotations(strict);
export const decodeHubWebhookEndpointRequest = Schema.decodeUnknownSync(HubWebhookEndpointRequest);
