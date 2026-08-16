import { Schema } from "effect";
import { UtcTimestamp, CorrelationId } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const uuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedString = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));
const base64Url = Schema.NonEmptyTrimmedString.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/));
const fingerprint = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const publicKey = boundedString(4_096).pipe(
  Schema.filter((value) => !value.includes("PRIVATE KEY")),
);
const redactedCode = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]*$/),
  Schema.maxLength(128),
);
const deviceLabel = boundedString(128).pipe(
  Schema.filter((value) => !value.includes("/") && !value.includes("\\")),
);
const origin = Schema.String.pipe(
  Schema.filter((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
    } catch {
      return false;
    }
  }),
);
const positiveInteger = Schema.Int.pipe(Schema.positive());

export const StableHostId = uuid("StableHostId");
export type StableHostId = typeof StableHostId.Type;
export const DeviceId = uuid("DeviceId");
export type DeviceId = typeof DeviceId.Type;
export const PairingTicketId = uuid("PairingTicketId");
export type PairingTicketId = typeof PairingTicketId.Type;
export const RemoteSessionId = uuid("RemoteSessionId");
export type RemoteSessionId = typeof RemoteSessionId.Type;
export const RemoteCommandId = uuid("RemoteCommandId");
export type RemoteCommandId = typeof RemoteCommandId.Type;

export const REMOTE_ACCESS_PROTOCOL_VERSION = 1 as const;
export const REMOTE_AUTHENTICATION_PROTOCOL_VERSION = 1 as const;
export const REMOTE_SECURITY_FLOOR = 1 as const;
// Identity-only capability vector; product capabilities are negotiated separately.
export const REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR =
  "remote-authentication-only:v1" as const;

export const ProtocolRange = Schema.Struct({
  min: positiveInteger,
  max: positiveInteger,
})
  .pipe(Schema.filter((value) => value.min <= value.max))
  .annotations(strict);
export type ProtocolRange = typeof ProtocolRange.Type;

export const ClientHelloV1 = Schema.Struct({
  webBuildVersion: boundedString(128),
  supportedProtocolRange: ProtocolRange,
  browserCapabilities: Schema.Array(boundedString(64)),
  deviceId: Schema.optional(DeviceId),
}).annotations(strict);
export type ClientHelloV1 = typeof ClientHelloV1.Type;

export const HostHelloV1 = Schema.Struct({
  productId: Schema.Literal("octant"),
  hostId: StableHostId,
  displayName: boundedString(128),
  hostKeyFingerprint: fingerprint,
  serverBuildVersion: boundedString(128),
  supportedProtocolRange: ProtocolRange,
  authenticationProtocolVersions: Schema.NonEmptyArray(positiveInteger),
  securityFloor: positiveInteger,
  remoteOrigin: origin,
  nonce: base64Url,
  expiresAt: UtcTimestamp,
  signature: base64Url,
}).annotations(strict);
export type HostHelloV1 = typeof HostHelloV1.Type;

export const PairingRequestV1 = Schema.Struct({
  ticketId: PairingTicketId,
  ticketProof: base64Url,
  hostHelloNonce: base64Url,
  devicePublicKey: publicKey,
  deviceKeyFingerprint: fingerprint,
  deviceLabel,
  origin,
  clientHello: ClientHelloV1,
}).annotations(strict);
export type PairingRequestV1 = typeof PairingRequestV1.Type;

export const DeviceRegistrationV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  deviceKeyFingerprint: fingerprint,
  devicePublicKey: publicKey,
  deviceLabel,
  origin,
  protocolFloor: positiveInteger,
  credentialGeneration: positiveInteger,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  state: Schema.Literal("active", "revoked", "expired"),
  revokedAt: Schema.optional(UtcTimestamp),
  revokedReason: Schema.optional(boundedString(128)),
}).annotations(strict);
export type DeviceRegistrationV1 = typeof DeviceRegistrationV1.Type;

export const NegotiatedSessionV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  protocolVersion: positiveInteger,
  authenticationVersion: positiveInteger,
  credentialGeneration: positiveInteger,
  origin,
  capabilityDigest: fingerprint,
  issuedAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  hostSignature: base64Url,
}).annotations(strict);
export type NegotiatedSessionV1 = typeof NegotiatedSessionV1.Type;

export const PairingStatusRequestV1 = Schema.Struct({
  ticketId: PairingTicketId,
  ticketProof: base64Url.pipe(Schema.maxLength(128)),
}).annotations(strict);
export type PairingStatusRequestV1 = typeof PairingStatusRequestV1.Type;

export const PairingStatusResultV1 = Schema.Union(
  Schema.Struct({ status: Schema.Literal("pending") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("approved"),
    deviceId: DeviceId,
    credentialGeneration: positiveInteger,
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("failed") }).annotations(strict),
);
export type PairingStatusResultV1 = typeof PairingStatusResultV1.Type;

export const NegotiationRequestV1 = Schema.Struct({
  hostHelloNonce: base64Url.pipe(Schema.maxLength(128)),
  challengeId: uuid("RemoteChallengeId"),
  deviceId: DeviceId,
  origin,
  clientHello: ClientHelloV1,
}).annotations(strict);
export type NegotiationRequestV1 = typeof NegotiationRequestV1.Type;

export const NegotiatedProtocolV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  challengeId: uuid("RemoteChallengeId"),
  protocolVersion: positiveInteger,
  authenticationVersion: positiveInteger,
  credentialGeneration: positiveInteger,
  origin,
  capabilityDigest: fingerprint,
  issuedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  hostSignature: base64Url,
}).annotations(strict);
export type NegotiatedProtocolV1 = typeof NegotiatedProtocolV1.Type;

export const SecurityAuditRecordV1 = Schema.Struct({
  eventKind: redactedCode,
  hostId: StableHostId,
  deviceId: Schema.optional(DeviceId),
  protocolVersion: positiveInteger,
  credentialGeneration: positiveInteger,
  sourceClass: Schema.Literal("loopback", "lan-private", "tailscale", "unknown"),
  resultCategory: redactedCode,
  reasonCode: redactedCode,
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type SecurityAuditRecordV1 = typeof SecurityAuditRecordV1.Type;

export const PairingTicketV1 = Schema.Struct({
  ticketId: PairingTicketId,
  hostId: StableHostId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  failedAttempts: Schema.Int.pipe(Schema.nonNegative()),
  state: Schema.Literal("pending", "approved", "denied", "expired"),
  sourceClass: Schema.Literal("loopback", "lan-private", "tailscale", "unknown"),
}).annotations(strict);
export type PairingTicketV1 = typeof PairingTicketV1.Type;

export const PairingDecisionV1 = Schema.Struct({
  ticketId: PairingTicketId,
  hostId: StableHostId,
  decision: Schema.Literal("approved", "denied"),
  decidedAt: UtcTimestamp,
  reasonCode: redactedCode,
}).annotations(strict);
export type PairingDecisionV1 = typeof PairingDecisionV1.Type;

export const CredentialGenerationV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  generation: positiveInteger,
  deviceKeyFingerprint: fingerprint,
  createdAt: UtcTimestamp,
  graceExpiresAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type CredentialGenerationV1 = typeof CredentialGenerationV1.Type;

export const RemoteSessionStateV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  state: Schema.Literal("active", "expired", "revoked"),
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
}).annotations(strict);
export type RemoteSessionStateV1 = typeof RemoteSessionStateV1.Type;

export const HostIdentityInitializedV1 = Schema.Struct({
  hostId: StableHostId,
  displayName: boundedString(128),
  hostKeyFingerprint: fingerprint,
  keyGeneration: positiveInteger,
  createdAt: UtcTimestamp,
  rotatedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type HostIdentityInitializedV1 = typeof HostIdentityInitializedV1.Type;

export const DeviceRegisteredV1 = Schema.Struct({
  device: DeviceRegistrationV1,
}).annotations(strict);
export type DeviceRegisteredV1 = typeof DeviceRegisteredV1.Type;

export const DeviceKeyRotatedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  previousGeneration: positiveInteger,
  credentialGeneration: positiveInteger,
  deviceKeyFingerprint: fingerprint,
  devicePublicKey: publicKey,
  rotatedAt: UtcTimestamp,
  graceExpiresAt: UtcTimestamp,
}).annotations(strict);
export type DeviceKeyRotatedV1 = typeof DeviceKeyRotatedV1.Type;

export const DeviceRevokedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  revokedAt: UtcTimestamp,
  reasonCode: boundedString(128),
}).annotations(strict);
export type DeviceRevokedV1 = typeof DeviceRevokedV1.Type;

export const RemoteSessionInvalidatedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionIdDigest: fingerprint,
  credentialGeneration: positiveInteger,
  invalidatedAt: UtcTimestamp,
  reasonCode: redactedCode,
  receiptId: RemoteCommandId,
}).annotations(strict);
export type RemoteSessionInvalidatedV1 = typeof RemoteSessionInvalidatedV1.Type;

export const DeviceCredentialExpiredV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  expiredAt: UtcTimestamp,
  reasonCode: redactedCode,
}).annotations(strict);
export type DeviceCredentialExpiredV1 = typeof DeviceCredentialExpiredV1.Type;

export const HostKeyRotatedV1 = Schema.Struct({
  hostId: StableHostId,
  previousKeyGeneration: positiveInteger,
  keyGeneration: positiveInteger,
  hostKeyFingerprint: fingerprint,
  rotatedAt: UtcTimestamp,
}).annotations(strict);
export type HostKeyRotatedV1 = typeof HostKeyRotatedV1.Type;

export const RemoteCommandReceiptRecordedV1 = Schema.Struct({
  commandId: RemoteCommandId,
  hostId: StableHostId,
  deviceId: Schema.optional(DeviceId),
  operationKind: redactedCode,
  operationDigest: fingerprint,
  resultCategory: redactedCode,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type RemoteCommandReceiptRecordedV1 = typeof RemoteCommandReceiptRecordedV1.Type;

/** Wire response for a bounded remote command result lookup. */
export const RemoteCommandResultV1 = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("applied"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    occurredAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    reasonCode: redactedCode,
    occurredAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    createdAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-found"),
    commandId: RemoteCommandId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    commandId: RemoteCommandId,
    reason: Schema.Literal("in-flight", "unconfirmed", "stale-session"),
  }).annotations(strict),
);
export type RemoteCommandResultV1 = typeof RemoteCommandResultV1.Type;

export const SecurityAuditRecordedV1 = Schema.Struct({
  record: SecurityAuditRecordV1,
}).annotations(strict);
export type SecurityAuditRecordedV1 = typeof SecurityAuditRecordedV1.Type;

const nonNegativeInteger = Schema.Int.pipe(Schema.nonNegative());

/**
 * Server-owned monotonic epoch guard. `highWaterMarkMs` is the greatest
 * wall-clock time ever observed by the host; effective expiry never uses a
 * "now" below it, so a clock rollback (NTP, DST/timezone misconfiguration,
 * restart, restore) cannot revive expired authority. The record is
 * non-sensitive: it carries only a coarse epoch bound and the derived posture.
 */
export const RemoteClockGuardV1 = Schema.Struct({
  hostId: StableHostId,
  highWaterMarkMs: nonNegativeInteger,
  observedAt: UtcTimestamp,
  posture: Schema.Literal("ok", "recovery-required"),
}).annotations(strict);
export type RemoteClockGuardV1 = typeof RemoteClockGuardV1.Type;

/**
 * Typed, redacted time-posture diagnostic. `recovery-required` is surfaced when
 * the host wall clock is unsafe for issuing new trust; it carries only a coarse
 * reason and correlation id, never raw times beyond the monotonic bound.
 */
export const RemoteTimePostureV1 = Schema.Union(
  Schema.Struct({
    posture: Schema.Literal("ok"),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
  }).annotations(strict),
  Schema.Struct({
    posture: Schema.Literal("recovery-required"),
    reason: Schema.Literal("clock-rollback", "malformed-clock", "forward-jump"),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
    correlationId: CorrelationId,
  }).annotations(strict),
);
export type RemoteTimePostureV1 = typeof RemoteTimePostureV1.Type;

export const REMOTE_ACCESS_EVENT_NAMES = {
  hostIdentityInitialized: "remote.host-identity-initialized@1",
  deviceRegistered: "remote.device-registered@1",
  deviceKeyRotated: "remote.device-key-rotated@1",
  deviceRevoked: "remote.device-revoked@1",
  sessionInvalidated: "remote.session-invalidated@1",
  deviceCredentialExpired: "remote.device-credential-expired@1",
  hostKeyRotated: "remote.host-key-rotated@1",
  commandReceiptRecorded: "remote.command-receipt-recorded@1",
  securityAuditRecorded: "remote.security-audit-recorded@1",
} as const;

export const decodeClientHelloV1 = Schema.decodeUnknownSync(ClientHelloV1);
export const decodeHostHelloV1 = Schema.decodeUnknownSync(HostHelloV1);
export const decodeStableHostId = Schema.decodeUnknownSync(StableHostId);
export const decodePairingRequestV1 = Schema.decodeUnknownSync(PairingRequestV1);
export const decodeDeviceRegistrationV1 = Schema.decodeUnknownSync(DeviceRegistrationV1);
export const decodeNegotiatedSessionV1 = Schema.decodeUnknownSync(NegotiatedSessionV1);
export const decodePairingStatusRequestV1 = Schema.decodeUnknownSync(PairingStatusRequestV1);
export const decodePairingStatusResultV1 = Schema.decodeUnknownSync(PairingStatusResultV1);
export const decodeNegotiationRequestV1 = Schema.decodeUnknownSync(NegotiationRequestV1);
export const decodeNegotiatedProtocolV1 = Schema.decodeUnknownSync(NegotiatedProtocolV1);
export const decodeSecurityAuditRecordV1 = Schema.decodeUnknownSync(SecurityAuditRecordV1);
export const decodePairingTicketV1 = Schema.decodeUnknownSync(PairingTicketV1);
export const decodePairingDecisionV1 = Schema.decodeUnknownSync(PairingDecisionV1);
export const decodeCredentialGenerationV1 = Schema.decodeUnknownSync(CredentialGenerationV1);
export const decodeRemoteSessionStateV1 = Schema.decodeUnknownSync(RemoteSessionStateV1);
export const decodeHostIdentityInitializedV1 = Schema.decodeUnknownSync(HostIdentityInitializedV1);
export const decodeDeviceRegisteredV1 = Schema.decodeUnknownSync(DeviceRegisteredV1);
export const decodeDeviceKeyRotatedV1 = Schema.decodeUnknownSync(DeviceKeyRotatedV1);
export const decodeDeviceRevokedV1 = Schema.decodeUnknownSync(DeviceRevokedV1);
export const decodeRemoteSessionInvalidatedV1 = Schema.decodeUnknownSync(
  RemoteSessionInvalidatedV1,
);
export const decodeDeviceCredentialExpiredV1 = Schema.decodeUnknownSync(DeviceCredentialExpiredV1);
export const decodeHostKeyRotatedV1 = Schema.decodeUnknownSync(HostKeyRotatedV1);
export const decodeRemoteCommandReceiptRecordedV1 = Schema.decodeUnknownSync(
  RemoteCommandReceiptRecordedV1,
);
export const decodeRemoteCommandResultV1 = Schema.decodeUnknownSync(RemoteCommandResultV1);
export const decodeSecurityAuditRecordedV1 = Schema.decodeUnknownSync(SecurityAuditRecordedV1);
export const decodeRemoteClockGuardV1 = Schema.decodeUnknownSync(RemoteClockGuardV1);
export const decodeRemoteTimePostureV1 = Schema.decodeUnknownSync(RemoteTimePostureV1);
export const decodeRemoteCommandId = Schema.decodeUnknownSync(RemoteCommandId);

export type RemoteClientPrincipal =
  | {
      readonly kind: "local-window";
      readonly windowId: string;
      readonly capabilityGeneration: number;
    }
  | {
      readonly kind: "remote-device";
      readonly hostId: StableHostId;
      readonly deviceId: DeviceId;
      readonly credentialGeneration: number;
      readonly origin: string;
      readonly protocolVersion: number;
      readonly capabilityDigest: string;
      readonly sessionId: RemoteSessionId;
    };
