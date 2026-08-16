import { createHash } from "node:crypto";
import { buildPairingComparisonPayload } from "@octant/domain/remote-protocol-policy";

/**
 * Public, non-secret claim facts retained on a pairing ticket after a
 * successful claim. Raw ticket proofs, raw host-hello nonces, comparison
 * codes, and full client requests are never retained — only public
 * registration facts and SHA-256 digests.
 */
export interface RetainedClaimFacts {
  readonly devicePublicKey: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly clientHelloDigest: string;
  readonly hostHelloNonceDigest: string;
  readonly claimedAt: number;
}

export function sanitizeClaimRecord(input: RetainedClaimFacts): RetainedClaimFacts {
  return Object.freeze({
    devicePublicKey: input.devicePublicKey,
    deviceKeyFingerprint: input.deviceKeyFingerprint,
    deviceLabel: input.deviceLabel,
    origin: input.origin,
    clientHelloDigest: input.clientHelloDigest,
    hostHelloNonceDigest: input.hostHelloNonceDigest,
    claimedAt: input.claimedAt,
  });
}

export function sha256DigestHex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Derives the six-digit comparison code from retained digests and public
 * facts. The code itself is computed transiently for the claim response and
 * the host approval display; it is never stored.
 */
export function derivePairingComparisonCode(input: {
  readonly hostId: string;
  readonly ticketId: string;
  readonly sourceClass: string;
  readonly ticketProofDigest: string;
  readonly claim: RetainedClaimFacts;
}): string {
  const digest = createHash("sha256")
    .update(
      buildPairingComparisonPayload({
        hostId: input.hostId,
        ticketId: input.ticketId,
        deviceKeyFingerprint: input.claim.deviceKeyFingerprint,
        origin: input.claim.origin,
        sourceClass: input.sourceClass,
        clientHelloDigest: input.claim.clientHelloDigest,
        ticketProofDigest: input.ticketProofDigest,
        hostHelloNonceDigest: input.claim.hostHelloNonceDigest,
      }),
    )
    .digest();
  const value = digest.readUInt32BE(0) % 1_000_000;
  return String(value).padStart(6, "0");
}
