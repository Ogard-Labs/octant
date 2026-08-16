import type {
  RemoteAuthChallengeV1,
  RemoteRequestProofV1,
} from "@octant/contracts/remote-request-proof";
import {
  REMOTE_REQUEST_CLOCK_SKEW_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  SESSION_ROTATION_INTERVAL_MS,
  evaluateSession,
} from "./remoteAccessPolicy";

export const REMOTE_REQUEST_NONCE_RETENTION_MS = 2 * REMOTE_REQUEST_CLOCK_SKEW_MS;

export type RemoteRequestFreshness =
  | { readonly kind: "active"; readonly rotate: boolean }
  | {
      readonly kind: "rejected";
      readonly reason: "malformed-timestamp" | "clock-skew" | "idle-expiry" | "absolute-expiry";
    };

export function canonicalizeRemotePathQuery(pathQuery: string): string | undefined {
  if (!pathQuery.startsWith("/") || pathQuery.includes("#") || pathQuery.includes("\\")) {
    return undefined;
  }
  if (/%(?![0-9a-fA-F]{2})/.test(pathQuery)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(pathQuery, "https://octant.invalid");
  } catch {
    return undefined;
  }
  if (parsed.origin !== "https://octant.invalid") {
    return undefined;
  }
  const entries = [...parsed.searchParams.entries()].sort(
    ([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = compareCodePoints(leftKey, rightKey);
      return keyOrder === 0 ? compareCodePoints(leftValue, rightValue) : keyOrder;
    },
  );
  const query = new URLSearchParams(entries).toString();
  return `${parsed.pathname}${query === "" ? "" : `?${query}`}`;
}

export function buildRemoteRequestProofPayload(input: {
  readonly sessionId: string;
  readonly proof: Pick<
    RemoteRequestProofV1,
    "method" | "canonicalPathQuery" | "bodyDigest" | "csrfDigest" | "nonce"
  > & { readonly timestamp: string };
}): string {
  return [
    "octant.remote-request-proof.v1",
    input.sessionId,
    input.proof.method,
    input.proof.canonicalPathQuery,
    input.proof.bodyDigest,
    input.proof.csrfDigest ?? "",
    input.proof.timestamp,
    input.proof.nonce,
  ].join("\n");
}

export function buildRemoteSessionMetadataPayload(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly protocolVersion: number;
  readonly authenticationVersion: number;
  readonly capabilityDigest: string;
  readonly issuedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
}): string {
  return [
    "octant.remote-session-metadata.v1",
    input.hostId,
    input.deviceId,
    input.credentialGeneration,
    input.origin,
    input.protocolVersion,
    input.authenticationVersion,
    input.capabilityDigest,
    input.issuedAt,
    input.idleExpiresAt,
    input.absoluteExpiresAt,
  ].join("\n");
}

export function buildRemoteChallengeProofPayload(input: {
  readonly challenge: Pick<
    RemoteAuthChallengeV1,
    | "challengeId"
    | "hostId"
    | "deviceId"
    | "credentialGeneration"
    | "nonce"
    | "issuedAt"
    | "expiresAt"
  >;
  readonly sessionFacts: {
    readonly origin: string;
    readonly protocolVersion: number;
    readonly authenticationVersion: number;
    readonly capabilityDigest: string;
    readonly issuedAt: string;
    readonly idleExpiresAt: string;
    readonly absoluteExpiresAt: string;
  };
}): string {
  return [
    "octant.remote-session-challenge.v1",
    input.challenge.challengeId,
    input.challenge.hostId,
    input.challenge.deviceId,
    input.challenge.credentialGeneration,
    input.challenge.nonce,
    input.challenge.issuedAt,
    input.challenge.expiresAt,
    input.sessionFacts.origin,
    input.sessionFacts.protocolVersion,
    input.sessionFacts.authenticationVersion,
    input.sessionFacts.capabilityDigest,
    input.sessionFacts.issuedAt,
    input.sessionFacts.idleExpiresAt,
    input.sessionFacts.absoluteExpiresAt,
  ].join("\n");
}

/**
 * Canonical transcript signed by the proposed new device key during self-rotation.
 * Old-key possession is proven separately by the authenticated request proof.
 * Never includes a raw session identifier.
 */
export function buildRemoteKeyRotationProofPayload(input: {
  readonly hostId: string;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly newDeviceKeyFingerprint: string;
  readonly newDevicePublicKey: string;
}): string {
  return [
    "octant.remote-key-rotation.v1",
    input.hostId,
    input.deviceId,
    input.credentialGeneration,
    input.newDeviceKeyFingerprint,
    input.newDevicePublicKey,
  ].join("\n");
}

export function evaluateRemoteRequestFreshness(input: {
  readonly nowMs: number;
  readonly proofTimestamp: string;
  readonly session: {
    readonly issuedAt: string;
    readonly idleExpiresAt: string;
    readonly absoluteExpiresAt: string;
  };
}): RemoteRequestFreshness {
  const timestampMs = Date.parse(input.proofTimestamp);
  const issuedAtMs = Date.parse(input.session.issuedAt);
  const idleExpiresAtMs = Date.parse(input.session.idleExpiresAt);
  const absoluteExpiresAtMs = Date.parse(input.session.absoluteExpiresAt);
  if (![timestampMs, issuedAtMs, idleExpiresAtMs, absoluteExpiresAtMs].every(Number.isFinite)) {
    return { kind: "rejected", reason: "malformed-timestamp" };
  }
  if (Math.abs(input.nowMs - timestampMs) > REMOTE_REQUEST_CLOCK_SKEW_MS) {
    return { kind: "rejected", reason: "clock-skew" };
  }
  const session = evaluateSession({
    now: input.nowMs,
    issuedAt: issuedAtMs,
    idleExpiresAt: idleExpiresAtMs,
    absoluteExpiresAt: absoluteExpiresAtMs,
  });
  if (session.kind === "expired") {
    return {
      kind: "rejected",
      reason: session.reason === "clock-skew" ? "clock-skew" : session.reason,
    };
  }
  return { kind: "active", rotate: session.rotate };
}

export function sessionExpiry(nowMs: number): {
  readonly issuedAt: string;
  readonly idleExpiresAt: string;
  readonly absoluteExpiresAt: string;
} {
  const issuedAt = new Date(nowMs).toISOString();
  return {
    issuedAt,
    idleExpiresAt: new Date(nowMs + SESSION_IDLE_TTL_MS).toISOString(),
    absoluteExpiresAt: new Date(nowMs + SESSION_ABSOLUTE_TTL_MS).toISOString(),
  };
}

export function shouldRotateSession(issuedAt: string, nowMs: number): boolean {
  const issuedAtMs = Date.parse(issuedAt);
  return Number.isFinite(issuedAtMs) && nowMs - issuedAtMs >= SESSION_ROTATION_INTERVAL_MS;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
