import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { DeviceId, RemoteCommandId, RemoteSessionId, StableHostId } from "./remoteAccess";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const uuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedBase64Url = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maxLength),
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
  );
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const positiveInteger = Schema.Int.pipe(Schema.positive());
const publicKey = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_096),
  Schema.filter((value) => !value.includes("PRIVATE KEY")),
);

export const RemoteChallengeId = uuid("RemoteChallengeId");
export type RemoteChallengeId = typeof RemoteChallengeId.Type;

export const RemoteRequestMethod = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9-]{0,15}$/));
export type RemoteRequestMethod = typeof RemoteRequestMethod.Type;

export const RemoteCanonicalPathQuery = Schema.String.pipe(
  Schema.maxLength(4_096),
  Schema.pattern(/^\/[^\s#]*$/),
  Schema.filter((value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint !== 0x7f;
    }),
  ),
);
export type RemoteCanonicalPathQuery = typeof RemoteCanonicalPathQuery.Type;

export const RemoteRequestProofV1 = Schema.Struct({
  method: RemoteRequestMethod,
  canonicalPathQuery: RemoteCanonicalPathQuery,
  bodyDigest: digest,
  csrfDigest: Schema.optional(digest),
  timestamp: UtcTimestamp,
  nonce: boundedBase64Url(128),
  signature: boundedBase64Url(512),
}).annotations(strict);
export type RemoteRequestProofV1 = typeof RemoteRequestProofV1.Type;

export const RemoteRequestFactsV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  origin: Schema.String.pipe(Schema.maxLength(2_048)),
  protocolVersion: positiveInteger,
  proof: RemoteRequestProofV1,
}).annotations(strict);
export type RemoteRequestFactsV1 = typeof RemoteRequestFactsV1.Type;

export const RemoteAuthChallengeV1 = Schema.Struct({
  challengeId: RemoteChallengeId,
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
  nonce: boundedBase64Url(128),
  issuedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
}).annotations(strict);
export type RemoteAuthChallengeV1 = typeof RemoteAuthChallengeV1.Type;

export const RemoteSessionIssuedV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  origin: Schema.String.pipe(Schema.maxLength(2_048)),
  protocolVersion: positiveInteger,
  authenticationVersion: positiveInteger,
  capabilityDigest: digest,
  issuedAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  csrfToken: boundedBase64Url(128),
}).annotations(strict);
export type RemoteSessionIssuedV1 = typeof RemoteSessionIssuedV1.Type;

export const RemoteAuthenticatedRequestResultV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  protocolVersion: positiveInteger,
  origin: Schema.String.pipe(Schema.maxLength(2_048)),
  freshness: Schema.Literal("current", "rotation-due"),
}).annotations(strict);
export type RemoteAuthenticatedRequestResultV1 = typeof RemoteAuthenticatedRequestResultV1.Type;

export const RemoteChallengeRequestV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  credentialGeneration: positiveInteger,
}).annotations(strict);
export type RemoteChallengeRequestV1 = typeof RemoteChallengeRequestV1.Type;

export const RemoteSessionRequestV1 = Schema.Struct({
  ...RemoteAuthChallengeV1.fields,
  signature: boundedBase64Url(512),
}).annotations(strict);
export type RemoteSessionRequestV1 = typeof RemoteSessionRequestV1.Type;

export const RemoteSessionResponseV1 = Schema.Struct({
  hostId: StableHostId,
  deviceId: DeviceId,
  /** Session id is required: browsers forbid reading `Set-Cookie` from the fetch API. */
  sessionId: RemoteSessionId,
  credentialGeneration: positiveInteger,
  origin: Schema.String.pipe(Schema.maxLength(2_048)),
  protocolVersion: positiveInteger,
  authenticationVersion: positiveInteger,
  capabilityDigest: digest,
  issuedAt: UtcTimestamp,
  idleExpiresAt: UtcTimestamp,
  absoluteExpiresAt: UtcTimestamp,
  csrfToken: boundedBase64Url(128),
  negotiationSignature: boundedBase64Url(512),
}).annotations(strict);
export type RemoteSessionResponseV1 = typeof RemoteSessionResponseV1.Type;

/**
 * Empty body for sign-out and self-revoke. Rejects any property so callers cannot
 * supply a device/session target; identity comes only from the authenticated principal.
 */
export const RemoteSelfServiceEmptyBodyV1 = Schema.Unknown.pipe(
  Schema.filter(
    (value): value is Record<string, never> =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value as object).length === 0,
  ),
);
export type RemoteSelfServiceEmptyBodyV1 = Record<string, never>;

/**
 * Authenticated self-rotation body. Old-key possession is proven by the request
 * proof; new-key possession is the signature over the canonical rotation transcript.
 * Device identity is never accepted from the body — only from the authenticated principal.
 */
export const RemoteKeyRotationRequestV1 = Schema.Struct({
  newDeviceKeyFingerprint: digest,
  newDevicePublicKey: publicKey,
  newKeyProof: boundedBase64Url(512),
}).annotations(strict);
export type RemoteKeyRotationRequestV1 = typeof RemoteKeyRotationRequestV1.Type;

/** Wire receipt for credential self-service; never carries a raw session ID. */
export const RemoteSelfServiceReceiptV1 = Schema.Struct({
  commandId: RemoteCommandId,
  result: Schema.Literal("applied", "already-applied"),
  occurredAt: UtcTimestamp,
}).annotations(strict);
export type RemoteSelfServiceReceiptV1 = typeof RemoteSelfServiceReceiptV1.Type;

/** Bounded own-device metadata for remote self-service; never lists other devices. */
export const RemoteOwnDeviceMetadataV1 = Schema.Struct({
  deviceId: DeviceId,
  deviceLabel: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  origin: Schema.String.pipe(Schema.maxLength(2_048)),
  credentialGeneration: positiveInteger,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  lastSeenAt: UtcTimestamp,
  state: Schema.Literal("active", "revoked", "expired"),
  sessionIdleExpiresAt: Schema.optional(UtcTimestamp),
  sessionAbsoluteExpiresAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type RemoteOwnDeviceMetadataV1 = typeof RemoteOwnDeviceMetadataV1.Type;

export const decodeRemoteRequestProofV1 = Schema.decodeUnknownSync(RemoteRequestProofV1);
export const decodeRemoteRequestFactsV1 = Schema.decodeUnknownSync(RemoteRequestFactsV1);
export const decodeRemoteAuthChallengeV1 = Schema.decodeUnknownSync(RemoteAuthChallengeV1);
export const decodeRemoteSessionIssuedV1 = Schema.decodeUnknownSync(RemoteSessionIssuedV1);
export const decodeRemoteAuthenticatedRequestResultV1 = Schema.decodeUnknownSync(
  RemoteAuthenticatedRequestResultV1,
);
export const decodeRemoteChallengeRequestV1 = Schema.decodeUnknownSync(RemoteChallengeRequestV1);
export const decodeRemoteSessionRequestV1 = Schema.decodeUnknownSync(RemoteSessionRequestV1);
export const decodeRemoteSessionResponseV1 = Schema.decodeUnknownSync(RemoteSessionResponseV1);
export const decodeRemoteSelfServiceEmptyBodyV1 = Schema.decodeUnknownSync(
  RemoteSelfServiceEmptyBodyV1,
);
export const decodeRemoteKeyRotationRequestV1 = Schema.decodeUnknownSync(
  RemoteKeyRotationRequestV1,
);
export const decodeRemoteSelfServiceReceiptV1 = Schema.decodeUnknownSync(
  RemoteSelfServiceReceiptV1,
);
export const decodeRemoteOwnDeviceMetadataV1 = Schema.decodeUnknownSync(RemoteOwnDeviceMetadataV1);
