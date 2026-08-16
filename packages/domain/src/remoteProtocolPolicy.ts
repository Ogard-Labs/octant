import { PAIRING_MAX_FAILED_ATTEMPTS } from "./remoteAccessPolicy";

export const HOST_HELLO_NONCE_TTL_MS = 60 * 1_000;
export const MAX_HOST_HELLO_NONCES = 256;
export const MAX_LIVE_PAIRING_TICKETS = 32;
export const MAX_UNDECIDED_PAIRING_CLAIMS = 16;
export const MAX_PENDING_NEGOTIATIONS = 256;

export interface HostHelloSignatureFacts {
  readonly productId: string;
  readonly hostId: string;
  readonly displayName: string;
  readonly hostKeyFingerprint: string;
  readonly serverBuildVersion: string;
  readonly supportedProtocolRange: { readonly min: number; readonly max: number };
  readonly authenticationProtocolVersions: ReadonlyArray<number>;
  readonly securityFloor: number;
  readonly remoteOrigin: string;
  readonly nonce: string;
  readonly expiresAt: string;
}

export function buildHostHelloSignaturePayload(hello: HostHelloSignatureFacts): string {
  return [
    "octant.host-hello.v1",
    hello.productId,
    hello.hostId,
    hello.displayName,
    hello.hostKeyFingerprint,
    hello.serverBuildVersion,
    String(hello.supportedProtocolRange.min),
    String(hello.supportedProtocolRange.max),
    ...hello.authenticationProtocolVersions.map(String),
    String(hello.securityFloor),
    hello.remoteOrigin,
    hello.nonce,
    hello.expiresAt,
  ].join("\n");
}

export interface NegotiatedProtocolSignatureFacts {
  readonly hostId: string;
  readonly deviceId: string;
  readonly challengeId: string;
  readonly protocolVersion: number;
  readonly authenticationVersion: number;
  readonly credentialGeneration: number;
  readonly origin: string;
  readonly capabilityDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export function buildNegotiatedProtocolPayload(record: NegotiatedProtocolSignatureFacts): string {
  return [
    "octant.negotiated-protocol.v1",
    record.hostId,
    record.deviceId,
    record.challengeId,
    String(record.protocolVersion),
    String(record.authenticationVersion),
    String(record.credentialGeneration),
    record.origin,
    record.capabilityDigest,
    record.issuedAt,
    record.expiresAt,
  ].join("\n");
}

export interface ClientHelloTranscriptFacts {
  readonly webBuildVersion: string;
  readonly supportedProtocolRange: { readonly min: number; readonly max: number };
  readonly browserCapabilities: ReadonlyArray<string>;
  readonly deviceId?: string | undefined;
}

export function buildClientHelloTranscriptPayload(hello: ClientHelloTranscriptFacts): string {
  return [
    "octant.client-hello.v1",
    JSON.stringify({
      webBuildVersion: hello.webBuildVersion,
      min: hello.supportedProtocolRange.min,
      max: hello.supportedProtocolRange.max,
      browserCapabilities: [...hello.browserCapabilities].sort(),
      deviceId: hello.deviceId ?? null,
    }),
  ].join("\n");
}

export interface PairingComparisonTranscriptFacts {
  readonly hostId: string;
  readonly ticketId: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: string;
  readonly clientHelloDigest: string;
  readonly ticketProofDigest: string;
  readonly hostHelloNonceDigest: string;
}

export function buildPairingComparisonPayload(facts: PairingComparisonTranscriptFacts): string {
  return [
    "octant.pairing-comparison.v1",
    facts.hostId,
    facts.ticketId,
    facts.deviceKeyFingerprint,
    facts.origin,
    facts.sourceClass,
    facts.clientHelloDigest,
    facts.ticketProofDigest,
    facts.hostHelloNonceDigest,
  ].join("\n");
}

export function selectAuthenticationProtocolVersion(
  versions: ReadonlyArray<number>,
): number | undefined {
  let selected: number | undefined;
  for (const version of versions) {
    if (!Number.isSafeInteger(version) || version < 1) return undefined;
    if (selected === undefined || version > selected) selected = version;
  }
  return selected;
}

export interface PairingStatusState {
  readonly state: "pending" | "approved" | "denied" | "expired";
  readonly attempts: number;
  readonly now: number;
  readonly expiresAt: number;
  readonly proofMatches: boolean;
}

export type PairingStatusDecision =
  | { readonly kind: "pending" }
  | { readonly kind: "approved" }
  | { readonly kind: "failed"; readonly attempts?: number; readonly exhausted?: boolean };

export function evaluatePairingStatus(input: PairingStatusState): PairingStatusDecision {
  if (input.now >= input.expiresAt) return { kind: "failed" };
  if (!input.proofMatches) {
    const attempts = input.attempts + 1;
    if (attempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
      return { kind: "failed", attempts, exhausted: true };
    }
    return { kind: "failed", attempts };
  }
  if (input.state === "pending") return { kind: "pending" };
  if (input.state === "approved") return { kind: "approved" };
  return { kind: "failed" };
}
