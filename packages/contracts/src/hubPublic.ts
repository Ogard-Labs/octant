import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { HubMemberId } from "./hubAndSpokes";

// The hub's public entrance: visitor links, webhook deliveries, and the device
// relay. A spoke owns every link and endpoint; the hub holds only what these
// shapes carry, which never names a thread, a Project, or a routine.

const base64Url = (min: number, max: number) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^[A-Za-z0-9_-]{${min},${max}}$`)));
const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const millis = NonNegativeInt;

/** Sixteen random bytes as base64url: the public half of a visitor link. */
export const VisitorLinkId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  Schema.brand("VisitorLinkId"),
);
export type VisitorLinkId = typeof VisitorLinkId.Type;

/** Thirty-two random bytes as base64url. It travels only in a link's URL fragment. */
export const VisitorLinkSecret = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export type VisitorLinkSecret = typeof VisitorLinkSecret.Type;

export const VisitorLinkScope = Schema.Literals(["read", "comment"]);
export type VisitorLinkScope = typeof VisitorLinkScope.Type;

export const VISITOR_LINK_DEFAULT_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const VISITOR_LINK_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const VISITOR_COMMENT_MAX_CHARACTERS = 4_000;
/**
 * The most a visitor projection takes as JSON. The spoke keeps the newest
 * messages that fit, so the answer crosses the pinned private link, and a
 * member's forward, whole.
 */
export const VISITOR_PROJECTION_MAX_BYTES = 384 * 1024;
/** What a spoke's answer to a visitor fetch may take on the private link, the projection and its wrapper. */
export const VISITOR_FETCH_ANSWER_MAX_BYTES = 448 * 1024;
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
  revision: PositiveInt,
  secretHash: base64Url(43, 43),
});
export type VisitorLinkGrant = typeof VisitorLinkGrant.Type;

/** A grant with the spoke's host identity key and its P-256 IEEE-P1363 signature. */
export const SignedVisitorLinkGrant = Schema.Struct({
  grant: VisitorLinkGrant,
  signerPublicKey: base64Url(80, 512),
  signature: base64Url(86, 86),
});
export type SignedVisitorLinkGrant = typeof SignedVisitorLinkGrant.Type;
export const decodeSignedVisitorLinkGrant = Schema.decodeUnknownSync(
  SignedVisitorLinkGrant,
  STRICT_DECODE_OPTIONS,
);

export const VISITOR_LINK_REFUSAL_KINDS = [
  "unknown-signer",
  "bad-signature",
  "secret-mismatch",
  "expired",
  "lifetime-too-long",
  "revoked",
  "bound-elsewhere",
] as const;
export const VisitorLinkRefusalKind = Schema.Literals(VISITOR_LINK_REFUSAL_KINDS);
export type VisitorLinkRefusalKind = typeof VisitorLinkRefusalKind.Type;

/** Sixteen random bytes as base64url: the path segment of a webhook URL. */
export const WebhookEndpointId = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  Schema.brand("WebhookEndpointId"),
);
export type WebhookEndpointId = typeof WebhookEndpointId.Type;

/**
 * How a sender signs. Standard Webhooks signs an id and a timestamp with the
 * body; GitHub signs the body alone; Stripe signs a timestamp with the body
 * and puts the event id inside it. Stripe mints its own secret, so a Stripe
 * endpoint's secret is pasted in rather than minted.
 */
export const WebhookSignatureScheme = Schema.Literals(["standard-webhooks", "github", "stripe"]);
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
});
export type SealedWebhookSecret = typeof SealedWebhookSecret.Type;

/** What the hub and standbys hold of one endpoint: never the routine it starts. */
export const HubWebhookEndpoint = Schema.Struct({
  endpointId: WebhookEndpointId,
  spokeMemberId: HubMemberId,
  scheme: WebhookSignatureScheme,
  /**
   * One copy per recipient, current secret first. A Stripe endpoint whose
   * person pasted a new secret within the last day also carries, after it,
   * each replaced secret still taken, sealed to the same recipient with its
   * own end time inside the seal; a holder that opens only the first copy for
   * its member id keeps working unchanged.
   */
  sealedSecrets: Schema.Array(SealedWebhookSecret).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
});
export type HubWebhookEndpoint = typeof HubWebhookEndpoint.Type;
export const decodeHubWebhookEndpoint = Schema.decodeUnknownSync(
  HubWebhookEndpoint,
  STRICT_DECODE_OPTIONS,
);

/** The headers a delivery keeps on its way to the spoke: the ones its scheme signs or names. */
export const WEBHOOK_FORWARDED_HEADERS = [
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
  "x-hub-signature-256",
  "x-github-delivery",
  "x-github-event",
  "stripe-signature",
  "content-type",
] as const;

/**
 * One delivery as the hub queues and forwards it: the original bytes and the
 * headers the spoke needs to check them again. `deliveryId` is the sender's
 * own id; the spoke's dedupe keys come from it and, for GitHub, the body.
 */
export const WebhookDeliveryEnvelope = Schema.Struct({
  endpointId: WebhookEndpointId,
  deliveryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  receivedAt: millis,
  headers: Schema.Record(
    Schema.String.check(
      Schema.makeFilter((name) =>
        (WEBHOOK_FORWARDED_HEADERS as ReadonlyArray<string>).includes(name),
      ),
    ),
    Schema.String.check(Schema.isMaxLength(4096)),
  ),
  /** The original body as base64; a 256 KiB body is at most this long. */
  body: Schema.String.check(
    Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
    Schema.isMaxLength(Math.ceil(WEBHOOK_BODY_MAX_BYTES / 3) * 4),
  ),
});
export type WebhookDeliveryEnvelope = typeof WebhookDeliveryEnvelope.Type;
export const decodeWebhookDeliveryEnvelope = Schema.decodeUnknownSync(
  WebhookDeliveryEnvelope,
  STRICT_DECODE_OPTIONS,
);

export const WEBHOOK_REFUSAL_KINDS = [
  "endpoint-off",
  "missing-signature",
  "bad-signature",
  "stale-timestamp",
  "too-large",
  "rate-limited",
  "queue-full",
] as const;
export const WebhookRefusalKind = Schema.Literals(WEBHOOK_REFUSAL_KINDS);
export type WebhookRefusalKind = typeof WebhookRefusalKind.Type;

/** A body digest as the spoke remembers it beside a delivery id. */
export const WebhookBodyDigest = digest;

/** The public ports Tailscale Funnel listens on; nothing else can be asked for. */
export const PUBLIC_FUNNEL_PORTS = [443, 8443, 10000] as const;
export const PublicFunnelPort = Schema.Literals(PUBLIC_FUNNEL_PORTS);
export type PublicFunnelPort = typeof PublicFunnelPort.Type;

/** A window turns this host's public entrance on or off. */
export const HubPublicEntranceSwitchRequest = Schema.Struct({
  enabled: Schema.Boolean,
});
export const decodeHubPublicEntranceSwitchRequest = Schema.decodeUnknownSync(
  HubPublicEntranceSwitchRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window turns the built-in Funnel front on (on one public port) or off. */
export const HubPublicFunnelRequest = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optional(PublicFunnelPort),
});
export const decodeHubPublicFunnelRequest = Schema.decodeUnknownSync(
  HubPublicFunnelRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * The Tailscale addresses of the person's own proxy on another machine. While
 * any is listed, the entrance binds the hub's Tailscale address with its
 * Tailscale certificate and serves only them; an empty list goes back to
 * loopback. The host refuses any address that is not a Tailscale one.
 */
export const HubPublicFrontsRequest = Schema.Struct({
  addresses: Schema.Array(Schema.String.check(Schema.isMaxLength(64))).check(Schema.isMaxLength(8)),
});
export const decodeHubPublicFrontsRequest = Schema.decodeUnknownSync(
  HubPublicFrontsRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * A standby's own choice to serve the public entrance while it stands in for
 * the hub (decision H30). Off by default; without it a standing-in standby's
 * entrance keeps forwarding and serves nothing itself.
 */
export const HubPublicStandbyServeRequest = Schema.Struct({ enabled: Schema.Boolean });
export const decodeHubPublicStandbyServeRequest = Schema.decodeUnknownSync(
  HubPublicStandbyServeRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * One delivery a standing-in standby still holds when the hub returns, handed
 * back with its dedupe keys so the hub queues it once. The spoke's own claims
 * stay the final word on whether it runs.
 */
export const HubWebhookHandback = Schema.Struct({
  spokeMemberId: HubMemberId,
  keys: Schema.Array(Schema.String.check(Schema.isMaxLength(320))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
  bytes: NonNegativeInt,
  envelope: WebhookDeliveryEnvelope,
});
export type HubWebhookHandback = typeof HubWebhookHandback.Type;
export const decodeHubWebhookHandback = Schema.decodeUnknownSync(
  HubWebhookHandback,
  STRICT_DECODE_OPTIONS,
);

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
  method: Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
export type PublicForwardEnvelope = typeof PublicForwardEnvelope.Type;
export const decodePublicForwardEnvelope = Schema.decodeUnknownSync(
  PublicForwardEnvelope,
  STRICT_DECODE_OPTIONS,
);

/** The acting hub's answer to a forwarded request, carried back unchanged. */
export const PublicForwardAnswer = Schema.Struct({
  // An interim 1xx answer has no place in a forwarded reply.
  status: Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 599 })),
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.String,
});
export type PublicForwardAnswer = typeof PublicForwardAnswer.Type;
export const decodePublicForwardAnswer = Schema.decodeUnknownSync(
  PublicForwardAnswer,
  STRICT_DECODE_OPTIONS,
);

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
});
export type HubSealingKey = typeof HubSealingKey.Type;
export const decodeHubSealingKey = Schema.decodeUnknownSync(HubSealingKey, STRICT_DECODE_OPTIONS);

export const HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE = 64;

/** Everything one spoke lets the hub hold for webhooks: it replaces what the hub held for it. */
export const HubWebhookEndpointsUpdate = Schema.Struct({
  endpoints: Schema.Array(HubWebhookEndpoint).check(
    Schema.isMaxLength(HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE),
  ),
});
export type HubWebhookEndpointsUpdate = typeof HubWebhookEndpointsUpdate.Type;
export const decodeHubWebhookEndpointsUpdate = Schema.decodeUnknownSync(
  HubWebhookEndpointsUpdate,
  STRICT_DECODE_OPTIONS,
);

/**
 * What a spoke answers a forwarded delivery. Every answer takes it off the
 * hub's queue except `busy`, which leaves it for a later look within the hold.
 */
export const WebhookDeliveryAnswer = Schema.Union([
  Schema.Struct({ status: Schema.Literals(["accepted", "duplicate"]) }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    kind: Schema.Literals([
      ...WEBHOOK_REFUSAL_KINDS,
      "public-not-granted",
      "unknown-endpoint",
      "busy",
      "paused",
    ]),
  }),
]);
export type WebhookDeliveryAnswer = typeof WebhookDeliveryAnswer.Type;
export const decodeWebhookDeliveryAnswer = Schema.decodeUnknownSync(
  WebhookDeliveryAnswer,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke mints a webhook endpoint for its routines. */
export const HubWebhookCreateRequest = Schema.Struct({
  scheme: WebhookSignatureScheme,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
});
export const decodeHubWebhookCreateRequest = Schema.decodeUnknownSync(
  HubWebhookCreateRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke pastes the secret Stripe minted for one of its Stripe endpoints. */
export const HubWebhookSecretRequest = Schema.Struct({
  endpointId: WebhookEndpointId,
  secret: Schema.String.check(Schema.isMaxLength(256)),
});
export const decodeHubWebhookSecretRequest = Schema.decodeUnknownSync(
  HubWebhookSecretRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke rotates or removes one of its endpoints. */
export const HubWebhookEndpointRequest = Schema.Struct({
  endpointId: WebhookEndpointId,
});
export const decodeHubWebhookEndpointRequest = Schema.decodeUnknownSync(
  HubWebhookEndpointRequest,
  STRICT_DECODE_OPTIONS,
);

/** A thread a visitor link shares, as only the spoke that owns it knows it. */
export const VisitorThreadMode = Schema.Literals(["chat", "code", "work"]);
export type VisitorThreadMode = typeof VisitorThreadMode.Type;

/** Everything one spoke lets the hub hold for visitor links: it replaces what the hub held for it. */
export const HubVisitorGrantsUpdate = Schema.Struct({
  grants: Schema.Array(SignedVisitorLinkGrant).check(Schema.isMaxLength(256)),
});
export type HubVisitorGrantsUpdate = typeof HubVisitorGrantsUpdate.Type;
export const decodeHubVisitorGrantsUpdate = Schema.decodeUnknownSync(
  HubVisitorGrantsUpdate,
  STRICT_DECODE_OPTIONS,
);

/**
 * The hub's own public address as an `https` origin: no path, credentials or
 * query. A spoke puts a visitor link's path behind it.
 */
export const HubPublicOrigin = Schema.String.check(
  Schema.isMaxLength(300),
  Schema.isPattern(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
);
export type HubPublicOrigin = typeof HubPublicOrigin.Type;

/**
 * The hub's answer to a spoke's grant list. The acting hub names its public
 * origin while visitor links and its entrance are on and it knows that
 * address, so it reaches each spoke over the pinned, signed hub link and never
 * through the public entrance.
 */
export const HubVisitorGrantsReceipt = Schema.Struct({
  status: Schema.Literal("recorded"),
  count: NonNegativeInt,
  publicOrigin: Schema.optional(HubPublicOrigin),
});
export type HubVisitorGrantsReceipt = typeof HubVisitorGrantsReceipt.Type;
export const decodeHubVisitorGrantsReceipt = Schema.decodeUnknownSync(
  HubVisitorGrantsReceipt,
  STRICT_DECODE_OPTIONS,
);

/**
 * What a visitor sees of a thread: its title, whether the owner is deciding
 * something, and the messages. Never a tool's input or output, a diff, a file,
 * an attachment, a path, or what an approval asks.
 */
export const VisitorProjection = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(256)),
  state: Schema.Literals(["working", "idle", "owner-deciding"]),
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["person", "agent", "visitor"]),
      text: Schema.String.check(Schema.isMaxLength(32_000)),
    }),
  ).check(Schema.isMaxLength(200)),
});
export type VisitorProjection = typeof VisitorProjection.Type;

/**
 * The hub asks the spoke on every visitor request. `binding` is the SHA-256 of
 * the browser's key: `open` binds the first one, and every later request must
 * name the same.
 */
export const VisitorFetchRequest = Schema.Struct({
  linkId: VisitorLinkId,
  revision: PositiveInt,
  binding: digest,
  kind: Schema.Literals(["open", "read", "comment"]),
  comment: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000))),
  /** On `open` only: the secret from the link's fragment, so the spoke itself checks it before it binds. */
  secret: Schema.optional(base64Url(43, 43)),
});
export type VisitorFetchRequest = typeof VisitorFetchRequest.Type;
export const decodeVisitorFetchRequest = Schema.decodeUnknownSync(
  VisitorFetchRequest,
  STRICT_DECODE_OPTIONS,
);

export const VISITOR_FETCH_REFUSAL_KINDS = [
  "public-not-granted",
  "unknown-link",
  "revoked",
  "expired",
  "ended",
  "not-bound",
  "bound-elsewhere",
  "comment-not-allowed",
  "comments-full",
  // The spoke's person paused remote access.
  "paused",
] as const;
export const VisitorFetchRefusalKind = Schema.Literals(VISITOR_FETCH_REFUSAL_KINDS);
export type VisitorFetchRefusalKind = typeof VisitorFetchRefusalKind.Type;

export const VisitorFetchAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    scope: VisitorLinkScope,
    expiresAt: millis,
    projection: Schema.optional(VisitorProjection),
  }),
  Schema.Struct({ status: Schema.Literal("refused"), kind: VisitorFetchRefusalKind }),
]);
export type VisitorFetchAnswer = typeof VisitorFetchAnswer.Type;
export const decodeVisitorFetchAnswer = Schema.decodeUnknownSync(
  VisitorFetchAnswer,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke shares one thread with a visitor. */
export const HubVisitorShareRequest = Schema.Struct({
  mode: VisitorThreadMode,
  threadId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  scope: VisitorLinkScope,
  /** Absent means a day; never more than seven. */
  lifetimeMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: VISITOR_LINK_MAX_LIFETIME_MS })),
  ),
});
export type HubVisitorShareRequest = typeof HubVisitorShareRequest.Type;
export const decodeHubVisitorShareRequest = Schema.decodeUnknownSync(
  HubVisitorShareRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke stops sharing a link. */
export const HubVisitorLinkRequest = Schema.Struct({ linkId: VisitorLinkId });
export const decodeHubVisitorLinkRequest = Schema.decodeUnknownSync(
  HubVisitorLinkRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on a spoke sends or dismisses a visitor's comment. */
export const HubVisitorCommentRequest = Schema.Struct({
  commentId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)),
  action: Schema.Literals(["send", "dismiss"]),
});
export type HubVisitorCommentRequest = typeof HubVisitorCommentRequest.Type;
export const decodeHubVisitorCommentRequest = Schema.decodeUnknownSync(
  HubVisitorCommentRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on the hub turns visitor links on or off; off, their routes answer 404. */
export const HubVisitorSwitchRequest = Schema.Struct({ enabled: Schema.Boolean });
export const decodeHubVisitorSwitchRequest = Schema.decodeUnknownSync(
  HubVisitorSwitchRequest,
  STRICT_DECODE_OPTIONS,
);

/** The header a viewer signs each request with, and the one that names its key. */
export const VISITOR_PROOF_HEADER = "octant-visitor-proof";
export const VISITOR_KEY_HEADER = "octant-visitor-key";
/** How far a proof's time may stray from the hub's clock. */
export const VISITOR_PROOF_SKEW_MS = 60_000;
// The device relay (decision H36). The hub carries a paired device's bytes to
// one host and reads none of them: inside, the device runs its ordinary TLS to
// that host's listener and checks the pin it stored at pairing.

/** The hub's first message on a relay: a fresh challenge and who is asking. */
export const RelayChallenge = Schema.Struct({
  challenge: base64Url(43, 43),
  hubMemberId: HubMemberId,
});
export type RelayChallenge = typeof RelayChallenge.Type;
export const decodeRelayChallenge = Schema.decodeUnknownSync(RelayChallenge, STRICT_DECODE_OPTIONS);

/** The device's answer: the host it wants and its device key's signature over the challenge. */
export const RelayAdmission = Schema.Struct({
  targetMemberId: HubMemberId,
  deviceSpki: base64Url(80, 512),
  signature: base64Url(86, 86),
});
export type RelayAdmission = typeof RelayAdmission.Type;
export const decodeRelayAdmission = Schema.decodeUnknownSync(RelayAdmission, STRICT_DECODE_OPTIONS);

/** The text a device key signs to open a relay to one host through one hub. */
export const relayAdmissionPayload = (input: {
  readonly challenge: string;
  readonly targetMemberId: string;
  readonly hubMemberId: string;
}): string => `octant/relay/v1|${input.challenge}|${input.targetMemberId}|${input.hubMemberId}`;

/** What the hub sends once it admitted the device; binary frames follow. */
export const RELAY_OPENED_MESSAGE = "opened";
/** The close code a refused admission ends with. */
export const RELAY_REFUSED_CLOSE_CODE = 4401;
/** The close code when the host behind the relay cannot be reached or refuses the tunnel. */
export const RELAY_UNAVAILABLE_CLOSE_CODE = 4503;

/**
 * A host whose person ticked Relay tells the hub which of its paired devices'
 * keys may open a relay to it, by fingerprint. An empty list withdraws them all.
 */
export const HubRelayDevicesUpdate = Schema.Struct({
  fingerprints: Schema.Array(digest).check(Schema.isMaxLength(256)),
});
export type HubRelayDevicesUpdate = typeof HubRelayDevicesUpdate.Type;
export const decodeHubRelayDevicesUpdate = Schema.decodeUnknownSync(
  HubRelayDevicesUpdate,
  STRICT_DECODE_OPTIONS,
);

/** A window on the hub turns the device relay on or off; off, `/relay/v1` answers 404. */
export const HubRelaySwitchRequest = Schema.Struct({ enabled: Schema.Boolean });
export const decodeHubRelaySwitchRequest = Schema.decodeUnknownSync(
  HubRelaySwitchRequest,
  STRICT_DECODE_OPTIONS,
);

/** A window on a host lets one of its paired devices through the hub, or stops letting it. */
export const HubRelayDeviceRequest = Schema.Struct({
  deviceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  allowed: Schema.Boolean,
});
export type HubRelayDeviceRequest = typeof HubRelayDeviceRequest.Type;
export const decodeHubRelayDeviceRequest = Schema.decodeUnknownSync(
  HubRelayDeviceRequest,
  STRICT_DECODE_OPTIONS,
);

/** A relayed connection asked for a route only a connection on the private network may use. */
export const RELAYED_ADMIN_REFUSED = "relayed-admin-refused";

/**
 * The relay route a device opens: `wss://<the hub's public address>/relay/v1`.
 * Devices and spokes refuse any other address, an unencrypted one included.
 */
export const RelayUrl = Schema.String.check(
  Schema.isMaxLength(300),
  Schema.isPattern(/^wss:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/relay\/v1$/),
);
export type RelayUrl = typeof RelayUrl.Type;
export const isRelayUrl = Schema.is(RelayUrl);

/** Where a host's paired devices reach it through the hub, and which hub that is. */
export const RelayAddress = Schema.Struct({
  hubMemberId: HubMemberId,
  relayUrl: RelayUrl,
});
export type RelayAddress = typeof RelayAddress.Type;
export const decodeRelayAddress = Schema.decodeUnknownSync(RelayAddress, STRICT_DECODE_OPTIONS);

/**
 * The hub's answer to a host's device list. The hub names its relay address
 * while its relay switch is on and it knows its own public address, so the
 * address reaches each host over the pinned, signed hub link and never through
 * the public entrance.
 */
export const HubRelayDevicesReceipt = Schema.Struct({
  status: Schema.Literal("recorded"),
  count: NonNegativeInt,
  relay: Schema.optional(RelayAddress),
});
export type HubRelayDevicesReceipt = typeof HubRelayDevicesReceipt.Type;
export const decodeHubRelayDevicesReceipt = Schema.decodeUnknownSync(
  HubRelayDevicesReceipt,
  STRICT_DECODE_OPTIONS,
);

/**
 * The device route that tells a paired device its host's relay address. It
 * answers only on the private network; through the relay it is refused, so a
 * device learns the address only while it is at home.
 */
export const REMOTE_RELAY_ADDRESS_PATH = "/api/remote/relay-address";

export const RemoteRelayAddressAnswer = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("available"),
    hubMemberId: HubMemberId,
    relayUrl: RelayUrl,
  }),
  Schema.Struct({ status: Schema.Literal("unavailable") }),
]);
export type RemoteRelayAddressAnswer = typeof RemoteRelayAddressAnswer.Type;
export const decodeRemoteRelayAddressAnswer = Schema.decodeUnknownSync(
  RemoteRelayAddressAnswer,
  STRICT_DECODE_OPTIONS,
);

/** The address the person's own front answers on, typed on the hub; absent clears it. */
export const HubPublicAddressRequest = Schema.Struct({
  url: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});
export type HubPublicAddressRequest = typeof HubPublicAddressRequest.Type;
export const decodeHubPublicAddressRequest = Schema.decodeUnknownSync(
  HubPublicAddressRequest,
  STRICT_DECODE_OPTIONS,
);
