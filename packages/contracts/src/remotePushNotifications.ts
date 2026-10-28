import { Schema } from "effect";
import { DeviceId, StableHostId } from "./remoteAccess";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();
const boundedText = (maximumBytes: number) =>
  Schema.String.pipe(Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes));
const boundedNonEmptyText = (maximumBytes: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((value) => encoder.encode(value).byteLength <= maximumBytes),
  );

/** Opaque provider token; never logged by Octant hosts. */
export const RemotePushToken = boundedNonEmptyText(4_096);
export type RemotePushToken = typeof RemotePushToken.Type;

export const RemotePushPlatform = Schema.Literal("ios", "android");
export type RemotePushPlatform = typeof RemotePushPlatform.Type;

/**
 * The phone's notification public key for one host: a raw X25519 key in
 * unpadded base64url. The phone keeps the private half in its secure storage;
 * the host seals each notification's content to this key, so only that phone
 * can read it. Kept beside the token in the owner-only registration file, never
 * journaled or logged.
 */
export const RemotePushNotificationPublicKey = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9_-]{43}$/),
);
export type RemotePushNotificationPublicKey = typeof RemotePushNotificationPublicKey.Type;

/**
 * What one phone wants to hear about, per kind, and whether its lock screen may
 * show thread titles. A device sets only its own; titles are off unless the
 * person turns them on for that phone.
 */
export const RemotePushPreferencesV1 = Schema.Struct({
  approvalNeeded: Schema.Boolean,
  waiting: Schema.Boolean,
  failure: Schema.Boolean,
  completion: Schema.Boolean,
  threadTitles: Schema.Boolean,
}).annotations(strict);
export type RemotePushPreferencesV1 = typeof RemotePushPreferencesV1.Type;

export const RemotePushTokenRegistrationV1 = Schema.Struct({
  platform: RemotePushPlatform,
  token: RemotePushToken,
  notificationPublicKey: RemotePushNotificationPublicKey,
  preferences: RemotePushPreferencesV1,
}).annotations(strict);
export type RemotePushTokenRegistrationV1 = typeof RemotePushTokenRegistrationV1.Type;

export const RemotePushTokenClearV1 = Schema.Struct({}).annotations(strict);
export type RemotePushTokenClearV1 = typeof RemotePushTokenClearV1.Type;

export const RemotePushTokenReceiptV1 = Schema.Struct({
  result: Schema.Literal("registered", "already-registered", "cleared", "already-cleared"),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushTokenReceiptV1 = typeof RemotePushTokenReceiptV1.Type;

/**
 * The journal records that a device's push registration was added, changed,
 * or cleared, and never the token: the token lives only in the host's
 * owner-only registration file.
 */
export const REMOTE_PUSH_REGISTRATION_EVENT_NAMES = {
  recorded: "remote.push-registration-recorded@1",
  cleared: "remote.push-registration-cleared@1",
} as const;

export const RemotePushRegistrationRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  platform: RemotePushPlatform,
  change: Schema.Literal("added", "changed"),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushRegistrationRecordedV1 = typeof RemotePushRegistrationRecordedV1.Type;

/**
 * Why a registration went: the phone cleared it, its session signed out, the
 * device lost its standing (revoked by the host or by itself, abandoned
 * mid-pairing, expired, or found without an active device record at startup),
 * or the delivery path refused the destination as gone.
 */
export const RemotePushRegistrationClearReason = Schema.Literal(
  "device-cleared",
  "signed-out",
  "self-revoked",
  "device-revoked",
  "pairing-abandoned",
  "credential-expired",
  "device-without-standing",
  "destination-gone",
);
export type RemotePushRegistrationClearReason = typeof RemotePushRegistrationClearReason.Type;

export const RemotePushRegistrationClearedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  reason: RemotePushRegistrationClearReason,
  clearedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushRegistrationClearedV1 = typeof RemotePushRegistrationClearedV1.Type;

export const RemotePushNotificationKind = Schema.Literal(
  "completion",
  "waiting",
  "failure",
  "approval-needed",
);
export type RemotePushNotificationKind = typeof RemotePushNotificationKind.Type;

export const RemotePushNotificationMode = Schema.Literal("chat", "work", "code");
export type RemotePushNotificationMode = typeof RemotePushNotificationMode.Type;

/**
 * Redacted lock-screen payload. Hosts must build this via domain policy —
 * never paste prompts, diffs, paths, or secrets into title/body.
 */
export const RemotePushNotificationPayloadV1 = Schema.Struct({
  kind: RemotePushNotificationKind,
  hostId: StableHostId,
  threadId: boundedNonEmptyText(64),
  mode: Schema.optional(RemotePushNotificationMode),
  title: boundedNonEmptyText(80),
  body: boundedText(120),
}).annotations(strict);
export type RemotePushNotificationPayloadV1 = typeof RemotePushNotificationPayloadV1.Type;

/** The most content a notification seals for the phone, before encryption. */
export const REMOTE_PUSH_SEALED_CONTENT_MAX_BYTES = 2_048;

/**
 * The only alert the delivery path, Apple or Google, and the operating system
 * see. The phone replaces it with the sealed content once it opens it.
 */
export const REMOTE_PUSH_PLACEHOLDER_ALERT = {
  title: "Octant",
  body: "A paired computer has an update",
} as const;

const unpaddedBase64Url = (minimum: number, maximum: number) =>
  Schema.String.pipe(
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
    Schema.minLength(minimum),
    Schema.maxLength(maximum),
  );

/**
 * HPKE output for one phone: the sender's encapsulated X25519 key and the
 * AES-256-GCM ciphertext (the content padded to its bound, plus the 16-byte
 * tag), both unpadded base64url.
 */
export const RemotePushSealedContentV1 = Schema.Struct({
  encapsulatedKey: unpaddedBase64Url(43, 43),
  ciphertext: unpaddedBase64Url(
    22,
    Math.ceil(((REMOTE_PUSH_SEALED_CONTENT_MAX_BYTES + 16) * 4) / 3),
  ),
}).annotations(strict);
export type RemotePushSealedContentV1 = typeof RemotePushSealedContentV1.Type;

/**
 * What leaves the host for the delivery path. It names no host, thread, title,
 * or kind: a fixed placeholder, an opaque collapse id keyed per destination and
 * thread, an urgency, and the sealed content.
 */
export const RemotePushEnvelopeV1 = Schema.Struct({
  alert: Schema.Struct({
    title: Schema.Literal(REMOTE_PUSH_PLACEHOLDER_ALERT.title),
    body: Schema.Literal(REMOTE_PUSH_PLACEHOLDER_ALERT.body),
  }).annotations(strict),
  collapseId: unpaddedBase64Url(22, 22),
  urgency: Schema.Literal("high", "normal"),
  sealed: RemotePushSealedContentV1,
}).annotations(strict);
export type RemotePushEnvelopeV1 = typeof RemotePushEnvelopeV1.Type;

/**
 * One receipt per notification to one device. The journal holds what was
 * tried and how it ended, never the notification text, token, or key.
 */
export const REMOTE_PUSH_DELIVERY_EVENT_NAMES = {
  recorded: "remote.push-delivery-recorded@1",
} as const;

export const RemotePushDeliveryOutcome = Schema.Literal(
  "delivered",
  "failed",
  "rate-limited",
  "destination-gone",
);
export type RemotePushDeliveryOutcome = typeof RemotePushDeliveryOutcome.Type;

export const RemotePushDeliveryRecordedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  threadId: boundedNonEmptyText(64),
  kind: RemotePushNotificationKind,
  outcome: RemotePushDeliveryOutcome,
  /** A bounded slug such as `provider-unavailable`; never a provider's message. */
  failureCategory: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z0-9-]{1,64}$/))),
  recordedAt: UtcTimestamp,
}).annotations(strict);
export type RemotePushDeliveryRecordedV1 = typeof RemotePushDeliveryRecordedV1.Type;

/**
 * The push gateway: the one sender that holds the platform push credential.
 * The phone trades its platform token for a delivery capability there, and
 * the host sends sealed envelopes with that capability, signing each request
 * with its listener identity key. The gateway sees neither content nor host
 * routes; the host's Notifications setting names it and is off by default.
 */
export const REMOTE_PUSH_GATEWAY_DEFAULT_URL = "https://push.octant.sh";

/** An https gateway address, or http on this computer's loopback address for a local gateway. */
export const RemotePushGatewayUrl = Schema.String.pipe(
  Schema.maxLength(2_048),
  Schema.filter(
    (value) => {
      try {
        const parsed = new URL(value);
        if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") return false;
        if (parsed.search !== "") return false;
        if (parsed.protocol === "https:") return true;
        return (
          parsed.protocol === "http:" &&
          (parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "localhost" ||
            parsed.hostname === "[::1]")
        );
      } catch {
        return false;
      }
    },
    {
      message: () =>
        "A push gateway address is https, or http on this computer's loopback address.",
    },
  ),
);
export type RemotePushGatewayUrl = typeof RemotePushGatewayUrl.Type;

/** Settings › Notifications › Phone notifications. Off until the person turns it on. */
export const RemotePushGatewaySettingsV1 = Schema.Struct({
  kind: Schema.Literal("remote-push-gateway-settings"),
  enabled: Schema.Boolean,
  gatewayUrl: RemotePushGatewayUrl,
  /** Bumped on every change, so a save from a stale read is refused. */
  version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
}).annotations(strict);
export type RemotePushGatewaySettingsV1 = typeof RemotePushGatewaySettingsV1.Type;

export const SetRemotePushGatewaySettingsV1 = Schema.Struct({
  enabled: Schema.Boolean,
  gatewayUrl: RemotePushGatewayUrl,
  expectedVersion: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)),
}).annotations(strict);
export type SetRemotePushGatewaySettingsV1 = typeof SetRemotePushGatewaySettingsV1.Type;

/** SHA-256 of the host listener key's SPKI DER, lowercase hex: what the phone saw at pairing. */
export const RemotePushHostKeyFingerprint = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
export type RemotePushHostKeyFingerprint = typeof RemotePushHostKeyFingerprint.Type;

/** Phone to gateway: trade a platform token for a capability bound to one host's key. */
export const RemotePushCapabilityRequestV1 = Schema.Struct({
  platform: RemotePushPlatform,
  token: RemotePushToken,
  hostKeyFingerprint: RemotePushHostKeyFingerprint,
}).annotations(strict);
export type RemotePushCapabilityRequestV1 = typeof RemotePushCapabilityRequestV1.Type;

/**
 * The capability is opaque to the phone and the host: `v1.<key id>.<sealed>`,
 * sealed under a key only the issuing gateway holds. The phone registers it
 * with the host in place of the platform token.
 */
export const RemotePushCapability = Schema.String.pipe(
  Schema.pattern(/^v1\.[a-z0-9-]{1,32}\.[A-Za-z0-9_-]{40,4000}$/),
);
export type RemotePushCapability = typeof RemotePushCapability.Type;

export const RemotePushCapabilityResponseV1 = Schema.Struct({
  capability: RemotePushCapability,
}).annotations(strict);
export type RemotePushCapabilityResponseV1 = typeof RemotePushCapabilityResponseV1.Type;

/** Host to gateway: one sealed envelope for the destination the capability names. */
export const RemotePushDeliveryRequestV1 = Schema.Struct({
  capability: RemotePushCapability,
  envelope: RemotePushEnvelopeV1,
}).annotations(strict);
export type RemotePushDeliveryRequestV1 = typeof RemotePushDeliveryRequestV1.Type;

/**
 * The headers that sign a delivery request. The signature is ECDSA P-256 with
 * SHA-256 (IEEE P1363, unpadded base64url) over the signing text below, made
 * with the host's listener identity key; the key header carries that key's
 * SPKI DER so the gateway can check it against the capability's fingerprint.
 */
export const REMOTE_PUSH_DELIVERY_HEADERS = {
  hostKey: "x-octant-host-key",
  timestamp: "x-octant-timestamp",
  signature: "x-octant-signature",
} as const;

/** How far a signed request's timestamp may stray from the gateway's clock. */
export const REMOTE_PUSH_DELIVERY_SKEW_MS = 300_000;

/** `octant-push-delivery-v1`, the timestamp, and the body's SHA-256 (unpadded base64url), one per line. */
export function remotePushDeliverySigningText(input: {
  readonly timestamp: string;
  readonly bodySha256: string;
}): string {
  return `octant-push-delivery-v1\n${input.timestamp}\n${input.bodySha256}`;
}

/** Why a gateway refused a request; never a platform's own message. */
export const RemotePushGatewayRefusalCode = Schema.Literal(
  "malformed",
  "capability-not-issued-here",
  "host-key-mismatch",
  "signature-invalid",
  "rate-limited",
  "destination-gone",
  "platform-failed",
  "unavailable",
);
export type RemotePushGatewayRefusalCode = typeof RemotePushGatewayRefusalCode.Type;

export const RemotePushGatewayRefusalV1 = Schema.Struct({
  code: RemotePushGatewayRefusalCode,
}).annotations(strict);
export type RemotePushGatewayRefusalV1 = typeof RemotePushGatewayRefusalV1.Type;

export const decodeRemotePushTokenRegistrationV1 = Schema.decodeUnknownSync(
  RemotePushTokenRegistrationV1,
);
export const decodeRemotePushTokenClearV1 = Schema.decodeUnknownSync(RemotePushTokenClearV1);
export const decodeRemotePushTokenReceiptV1 = Schema.decodeUnknownSync(RemotePushTokenReceiptV1);
export const decodeRemotePushRegistrationRecordedV1 = Schema.decodeUnknownSync(
  RemotePushRegistrationRecordedV1,
);
export const decodeRemotePushRegistrationClearedV1 = Schema.decodeUnknownSync(
  RemotePushRegistrationClearedV1,
);
export const decodeRemotePushNotificationPayloadV1 = Schema.decodeUnknownSync(
  RemotePushNotificationPayloadV1,
);
export const decodeRemotePushEnvelopeV1 = Schema.decodeUnknownSync(RemotePushEnvelopeV1);
export const decodeRemotePushDeliveryRecordedV1 = Schema.decodeUnknownSync(
  RemotePushDeliveryRecordedV1,
);
export const decodeRemotePushGatewaySettingsV1 = Schema.decodeUnknownSync(
  RemotePushGatewaySettingsV1,
);
export const decodeSetRemotePushGatewaySettingsV1 = Schema.decodeUnknownSync(
  SetRemotePushGatewaySettingsV1,
);
export const decodeRemotePushCapabilityRequestV1 = Schema.decodeUnknownSync(
  RemotePushCapabilityRequestV1,
);
export const decodeRemotePushCapabilityResponseV1 = Schema.decodeUnknownSync(
  RemotePushCapabilityResponseV1,
);
export const decodeRemotePushDeliveryRequestV1 = Schema.decodeUnknownSync(
  RemotePushDeliveryRequestV1,
);
export const decodeRemotePushGatewayRefusalV1 = Schema.decodeUnknownSync(
  RemotePushGatewayRefusalV1,
);

// Re-export DeviceId usage for registration stores (host-scoped).
export type { DeviceId };
