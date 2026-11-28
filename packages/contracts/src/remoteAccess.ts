import { Schema } from "effect";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp, CorrelationId } from "./events";

const uuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));
const boundedString = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
const base64Url = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isPattern(/^[A-Za-z0-9_-]+$/));
const fingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const publicKey = boundedString(4_096).check(
  Schema.makeFilter((value) => !value.includes("PRIVATE KEY")),
);
const redactedCode = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
  Schema.isMaxLength(128),
);
const deviceLabel = boundedString(128).check(
  Schema.makeFilter((value) => !value.includes("/") && !value.includes("\\")),
);
const origin = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
    } catch {
      return false;
    }
  }),
);
const positiveInteger = PositiveInt;

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

/**
 * The query parameter a client names its hello nonce with:
 * `GET /api/remote/hello?clientNonce=<base64url>`. A host that answers it
 * echoes the nonce in `HostHelloV1.clientNonce` and signs it, so the hello
 * proves the key holder answered this request rather than an earlier one.
 */
export const HOST_HELLO_CLIENT_NONCE_PARAMETER = "clientNonce" as const;
/** Base64url of 16 to 96 random bytes; clients send 32. */
export const HostHelloClientNonce = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{22,128}$/),
);

export const ProtocolRange = Schema.Struct({
  min: positiveInteger,
  max: positiveInteger,
}).check(Schema.makeFilter((value) => value.min <= value.max));
export type ProtocolRange = typeof ProtocolRange.Type;

export const ClientHelloV1 = Schema.Struct({
  webBuildVersion: boundedString(128),
  supportedProtocolRange: ProtocolRange,
  browserCapabilities: Schema.Array(boundedString(64)),
  deviceId: Schema.optional(DeviceId),
});
export type ClientHelloV1 = typeof ClientHelloV1.Type;

export const HostHelloV1 = Schema.Struct({
  productId: Schema.Literal("octant"),
  hostId: StableHostId,
  displayName: boundedString(128),
  hostKeyFingerprint: fingerprint,
  // Unpadded base64url of the host identity key's DER SubjectPublicKeyInfo;
  // `hostKeyFingerprint` is its SHA-256. A client checks `signature` against
  // it. Optional only because hosts built before clients verified the hello
  // sent none; a client refuses a hello without it.
  hostPublicKey: Schema.optional(base64Url.check(Schema.isMaxLength(512))),
  serverBuildVersion: boundedString(128),
  supportedProtocolRange: ProtocolRange,
  authenticationProtocolVersions: Schema.NonEmptyArray(positiveInteger),
  securityFloor: positiveInteger,
  remoteOrigin: origin,
  nonce: base64Url,
  // The nonce the client sent with this hello request. Present only when the
  // client sent one; the hello is then signed as version 2. A client that
  // sent a nonce refuses a hello without it or with another one.
  clientNonce: Schema.optional(HostHelloClientNonce),
  expiresAt: UtcTimestamp,
  signature: base64Url,
});
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
});
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
  state: Schema.Literals(["active", "revoked", "expired"]),
  revokedAt: Schema.optional(UtcTimestamp),
  revokedReason: Schema.optional(boundedString(128)),
});
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
});
export type NegotiatedSessionV1 = typeof NegotiatedSessionV1.Type;

export const PairingStatusRequestV1 = Schema.Struct({
  ticketId: PairingTicketId,
  ticketProof: base64Url.check(Schema.isMaxLength(128)),
});
export type PairingStatusRequestV1 = typeof PairingStatusRequestV1.Type;

export const PairingStatusResultV1 = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("approved"),
    deviceId: DeviceId,
    credentialGeneration: positiveInteger,
  }),
  Schema.Struct({ status: Schema.Literal("failed") }),
]);
export type PairingStatusResultV1 = typeof PairingStatusResultV1.Type;

export const NegotiationRequestV1 = Schema.Struct({
  hostHelloNonce: base64Url.check(Schema.isMaxLength(128)),
  challengeId: uuid("RemoteChallengeId"),
  deviceId: DeviceId,
  origin,
  clientHello: ClientHelloV1,
});
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
});
export type NegotiatedProtocolV1 = typeof NegotiatedProtocolV1.Type;

/**
 * How much a device the host's own person paired may do there, chosen when the
 * person approves the pairing and changed later in Settings (maintainer
 * decision, 2026-11-22). `full` is the person, as a local window is;
 * `approve-and-steer` is held to the remote action catalogue, as a device the
 * hub's roster introduced is; `read-only` reaches only the catalogue's reads.
 * The host stores it and never takes it from the client.
 */
export const DEVICE_ACCESS_LEVELS = ["full", "approve-and-steer", "read-only"] as const;
export const DeviceAccessLevel = Schema.Literals(DEVICE_ACCESS_LEVELS);
export type DeviceAccessLevel = typeof DeviceAccessLevel.Type;
/** The level a pairing takes unless the person picks another, and the level of every older record. */
export const DEFAULT_DEVICE_ACCESS_LEVEL: DeviceAccessLevel = "full";
export const DEVICE_ACCESS_LEVEL_LABELS: Readonly<Record<DeviceAccessLevel, string>> = {
  full: "Full",
  "approve-and-steer": "Approve and steer",
  "read-only": "Read only",
};
export function isDeviceAccessLevel(value: unknown): value is DeviceAccessLevel {
  return (DEVICE_ACCESS_LEVELS as ReadonlyArray<unknown>).includes(value);
}
/**
 * The reason the private listener gives every paired request while the person
 * has paused remote access. It is not a credential failure, so a client keeps
 * its pairing and says why.
 */
export const REMOTE_ACCESS_PAUSED_REASON = "remote-access-paused" as const;
/** The reason a product route gives a device whose access level does not reach the action. */
export const DEVICE_ACCESS_LEVEL_REFUSED_REASON = "device-access-level" as const;

export const SecurityAuditRecordV1 = Schema.Struct({
  eventKind: redactedCode,
  hostId: StableHostId,
  deviceId: Schema.optional(DeviceId),
  protocolVersion: positiveInteger,
  credentialGeneration: positiveInteger,
  sourceClass: Schema.Literals(["loopback", "lan-private", "tailscale", "unknown"]),
  resultCategory: redactedCode,
  reasonCode: redactedCode,
  correlationId: CorrelationId,
  occurredAt: UtcTimestamp,
  /**
   * On a `device-approved` record the person wrote: the level they chose for
   * the device. Absent on every other record and on approvals made before
   * levels existed, which read as `full`.
   */
  accessLevel: Schema.optional(DeviceAccessLevel),
});
export type SecurityAuditRecordV1 = typeof SecurityAuditRecordV1.Type;

export const PairingTicketV1 = Schema.Struct({
  ticketId: PairingTicketId,
  hostId: StableHostId,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  failedAttempts: NonNegativeInt,
  state: Schema.Literals(["pending", "approved", "denied", "expired"]),
  sourceClass: Schema.Literals(["loopback", "lan-private", "tailscale", "unknown"]),
});
export type PairingTicketV1 = typeof PairingTicketV1.Type;

export const PairingDecisionV1 = Schema.Struct({
  ticketId: PairingTicketId,
  hostId: StableHostId,
  decision: Schema.Literals(["approved", "denied"]),
  decidedAt: UtcTimestamp,
  reasonCode: redactedCode,
});
export type PairingDecisionV1 = typeof PairingDecisionV1.Type;

export const CredentialGenerationV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  generation: positiveInteger,
  deviceKeyFingerprint: fingerprint,
  createdAt: UtcTimestamp,
  graceExpiresAt: Schema.optional(UtcTimestamp),
});
export type CredentialGenerationV1 = typeof CredentialGenerationV1.Type;

export const RemoteSessionStateV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  state: Schema.Literals(["active", "expired", "revoked"]),
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
});
export type RemoteSessionStateV1 = typeof RemoteSessionStateV1.Type;

export const HostIdentityInitializedV1 = Schema.Struct({
  hostId: StableHostId,
  displayName: boundedString(128),
  hostKeyFingerprint: fingerprint,
  keyGeneration: positiveInteger,
  createdAt: UtcTimestamp,
  rotatedAt: Schema.optional(UtcTimestamp),
});
export type HostIdentityInitializedV1 = typeof HostIdentityInitializedV1.Type;

export const DeviceRegisteredV1 = Schema.Struct({
  device: DeviceRegistrationV1,
});
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
});
export type DeviceKeyRotatedV1 = typeof DeviceKeyRotatedV1.Type;

export const DeviceRevokedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  revokedAt: UtcTimestamp,
  reasonCode: boundedString(128),
});
export type DeviceRevokedV1 = typeof DeviceRevokedV1.Type;

export const RemoteSessionInvalidatedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionIdDigest: fingerprint,
  credentialGeneration: positiveInteger,
  invalidatedAt: UtcTimestamp,
  reasonCode: redactedCode,
  receiptId: RemoteCommandId,
});
export type RemoteSessionInvalidatedV1 = typeof RemoteSessionInvalidatedV1.Type;

export const DeviceCredentialExpiredV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  expiredAt: UtcTimestamp,
  reasonCode: redactedCode,
});
export type DeviceCredentialExpiredV1 = typeof DeviceCredentialExpiredV1.Type;

/**
 * How long a paired device stays paired, counted from its pairing: a host
 * setting the person chooses (maintainer decision, 2026-11-13). `never` keeps
 * a pairing until it is revoked.
 */
export const PAIRED_DEVICE_LIFETIMES = ["7-days", "30-days", "90-days", "1-year", "never"] as const;
export const PairedDeviceLifetime = Schema.Literals(PAIRED_DEVICE_LIFETIMES);
export type PairedDeviceLifetime = typeof PairedDeviceLifetime.Type;
/** The deadline every registration was given before the setting existed. */
export const DEFAULT_PAIRED_DEVICE_LIFETIME: PairedDeviceLifetime = "30-days";

/**
 * A paired device's registration deadline, moved when the person changes how
 * long a paired device stays paired. A registration that never expires
 * records the latest representable instant, so every reader that compares
 * the deadline with the clock keeps working unchanged.
 */
export const DeviceRegistrationDeadlineChangedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  expiresAt: UtcTimestamp,
  lifetime: PairedDeviceLifetime,
  changedAt: UtcTimestamp,
});
export type DeviceRegistrationDeadlineChangedV1 = typeof DeviceRegistrationDeadlineChangedV1.Type;

/**
 * A host raised the alert that a device paired directly with it, or a window
 * cleared it. Every device connected to the host is told; the alert keeps the
 * device's private address, the journal never does (maintainer decision,
 * 2026-11-19).
 */
export const DeviceAlertChangedV1 = Schema.Struct({
  change: Schema.Literals(["raised", "dismissed"]),
  alertId: GuidString,
  deviceId: DeviceId,
  changedAt: UtcTimestamp,
});
export type DeviceAlertChangedV1 = typeof DeviceAlertChangedV1.Type;

/** A person changed a paired device's access level; the envelope's actor is who changed it. */
export const DeviceAccessLevelChangedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  previousLevel: DeviceAccessLevel,
  accessLevel: DeviceAccessLevel,
  changedAt: UtcTimestamp,
});
export type DeviceAccessLevelChangedV1 = typeof DeviceAccessLevelChangedV1.Type;

/**
 * A person paused or resumed remote access; the envelope's actor is who did.
 * While paused the private listener refuses every paired device and keeps
 * every record and key.
 */
export const RemoteAccessPauseChangedV1 = Schema.Struct({
  hostId: StableHostId,
  paused: Schema.Boolean,
  changedAt: UtcTimestamp,
});
export type RemoteAccessPauseChangedV1 = typeof RemoteAccessPauseChangedV1.Type;

export const HostKeyRotatedV1 = Schema.Struct({
  hostId: StableHostId,
  previousKeyGeneration: positiveInteger,
  keyGeneration: positiveInteger,
  hostKeyFingerprint: fingerprint,
  rotatedAt: UtcTimestamp,
});
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
});
export type RemoteCommandReceiptRecordedV1 = typeof RemoteCommandReceiptRecordedV1.Type;

/** Wire response for a bounded remote command result lookup. */
export const RemoteCommandResultV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("applied"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    occurredAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    reasonCode: redactedCode,
    occurredAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("pending"),
    commandId: RemoteCommandId,
    operationKind: redactedCode,
    createdAt: UtcTimestamp,
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("not-found"),
    commandId: RemoteCommandId,
  }),
  Schema.Struct({
    kind: Schema.Literal("ambiguous"),
    commandId: RemoteCommandId,
    reason: Schema.Literals(["in-flight", "unconfirmed", "stale-session"]),
  }),
]);
export type RemoteCommandResultV1 = typeof RemoteCommandResultV1.Type;

export const SecurityAuditRecordedV1 = Schema.Struct({
  record: SecurityAuditRecordV1,
});
export type SecurityAuditRecordedV1 = typeof SecurityAuditRecordedV1.Type;

const nonNegativeInteger = NonNegativeInt;

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
  posture: Schema.Literals(["ok", "recovery-required"]),
});
export type RemoteClockGuardV1 = typeof RemoteClockGuardV1.Type;

/**
 * Typed, redacted time-posture diagnostic. `recovery-required` is surfaced when
 * the host wall clock is unsafe for issuing new trust; it carries only a coarse
 * reason and correlation id, never raw times beyond the monotonic bound.
 */
export const RemoteTimePostureV1 = Schema.Union([
  Schema.Struct({
    posture: Schema.Literal("ok"),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
  }),
  Schema.Struct({
    posture: Schema.Literal("recovery-required"),
    reason: Schema.Literals(["clock-rollback", "malformed-clock", "forward-jump"]),
    highWaterMarkMs: nonNegativeInteger,
    effectiveNowMs: nonNegativeInteger,
    correlationId: CorrelationId,
  }),
]);
export type RemoteTimePostureV1 = typeof RemoteTimePostureV1.Type;

export const REMOTE_ACCESS_EVENT_NAMES = {
  hostIdentityInitialized: "remote.host-identity-initialized@1",
  deviceRegistered: "remote.device-registered@1",
  deviceKeyRotated: "remote.device-key-rotated@1",
  deviceRevoked: "remote.device-revoked@1",
  sessionInvalidated: "remote.session-invalidated@1",
  deviceCredentialExpired: "remote.device-credential-expired@1",
  deviceRegistrationDeadlineChanged: "remote.device-registration-deadline-changed@1",
  hostKeyRotated: "remote.host-key-rotated@1",
  commandReceiptRecorded: "remote.command-receipt-recorded@1",
  securityAuditRecorded: "remote.security-audit-recorded@1",
  deviceAlertChanged: "remote.device-alert-changed@1",
  deviceAccessLevelChanged: "remote.device-access-level-changed@1",
  remoteAccessPauseChanged: "remote.access-pause-changed@1",
} as const;

export const decodeClientHelloV1 = Schema.decodeUnknownSync(ClientHelloV1, STRICT_DECODE_OPTIONS);
export const decodeDeviceAlertChangedV1 = Schema.decodeUnknownSync(
  DeviceAlertChangedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostHelloV1 = Schema.decodeUnknownSync(HostHelloV1, STRICT_DECODE_OPTIONS);
export const decodeStableHostId = Schema.decodeUnknownSync(StableHostId, STRICT_DECODE_OPTIONS);
export const decodePairingRequestV1 = Schema.decodeUnknownSync(
  PairingRequestV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceRegistrationV1 = Schema.decodeUnknownSync(
  DeviceRegistrationV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeNegotiatedSessionV1 = Schema.decodeUnknownSync(
  NegotiatedSessionV1,
  STRICT_DECODE_OPTIONS,
);
export const decodePairingStatusRequestV1 = Schema.decodeUnknownSync(
  PairingStatusRequestV1,
  STRICT_DECODE_OPTIONS,
);
export const decodePairingStatusResultV1 = Schema.decodeUnknownSync(
  PairingStatusResultV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeNegotiationRequestV1 = Schema.decodeUnknownSync(
  NegotiationRequestV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeNegotiatedProtocolV1 = Schema.decodeUnknownSync(
  NegotiatedProtocolV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecurityAuditRecordV1 = Schema.decodeUnknownSync(
  SecurityAuditRecordV1,
  STRICT_DECODE_OPTIONS,
);
export const decodePairingTicketV1 = Schema.decodeUnknownSync(
  PairingTicketV1,
  STRICT_DECODE_OPTIONS,
);
export const decodePairingDecisionV1 = Schema.decodeUnknownSync(
  PairingDecisionV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeCredentialGenerationV1 = Schema.decodeUnknownSync(
  CredentialGenerationV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteSessionStateV1 = Schema.decodeUnknownSync(
  RemoteSessionStateV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostIdentityInitializedV1 = Schema.decodeUnknownSync(
  HostIdentityInitializedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceRegisteredV1 = Schema.decodeUnknownSync(
  DeviceRegisteredV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceKeyRotatedV1 = Schema.decodeUnknownSync(
  DeviceKeyRotatedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceRevokedV1 = Schema.decodeUnknownSync(
  DeviceRevokedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteSessionInvalidatedV1 = Schema.decodeUnknownSync(
  RemoteSessionInvalidatedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceCredentialExpiredV1 = Schema.decodeUnknownSync(
  DeviceCredentialExpiredV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceRegistrationDeadlineChangedV1 = Schema.decodeUnknownSync(
  DeviceRegistrationDeadlineChangedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeHostKeyRotatedV1 = Schema.decodeUnknownSync(
  HostKeyRotatedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDeviceAccessLevelChangedV1 = Schema.decodeUnknownSync(
  DeviceAccessLevelChangedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteAccessPauseChangedV1 = Schema.decodeUnknownSync(
  RemoteAccessPauseChangedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteCommandReceiptRecordedV1 = Schema.decodeUnknownSync(
  RemoteCommandReceiptRecordedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteCommandResultV1 = Schema.decodeUnknownSync(
  RemoteCommandResultV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeSecurityAuditRecordedV1 = Schema.decodeUnknownSync(
  SecurityAuditRecordedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteClockGuardV1 = Schema.decodeUnknownSync(
  RemoteClockGuardV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteTimePostureV1 = Schema.decodeUnknownSync(
  RemoteTimePostureV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeRemoteCommandId = Schema.decodeUnknownSync(
  RemoteCommandId,
  STRICT_DECODE_OPTIONS,
);

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
      /**
       * Who let this device onto the host. `host-person` is a pairing the
       * host's own person approved, and such a device is that person. A device
       * the hub's roster introduced, an agent grant's session, and any
       * principal built without the proof carry `hub-roster` or nothing, and
       * stay held to the remote action catalogue.
       */
      readonly admittedBy?: "host-person" | "hub-roster";
      /**
       * The level the person chose for a device they paired, set only when it
       * is narrower than `full`. Such a device is not the host's person: it is
       * held to the remote action catalogue, and to its reads at `read-only`.
       */
      readonly accessLevel?: Exclude<DeviceAccessLevel, "full">;
    };
