import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  derivePairingComparisonCode,
  sanitizeClaimRecord,
  type RetainedClaimFacts,
} from "./pairingClaimRecord";

const RAW_PROOF = "raw_ticket_proof_9f8e7d6c5b";
const RAW_NONCE = "raw_host_hello_nonce_1a2b3c4d";
const RAW_COMPARISON = "482910";

function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function claimInput() {
  return {
    devicePublicKey: "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0\n-----END PUBLIC KEY-----",
    deviceKeyFingerprint: "b".repeat(64),
    deviceLabel: "Ada's Safari",
    origin: "https://mac.example.test",
    clientHelloDigest: sha256hex("client-hello-payload"),
    hostHelloNonceDigest: sha256hex(RAW_NONCE),
    claimedAt: 1_785_000_000_000,
  };
}

describe("sanitizeClaimRecord", () => {
  it("retains only public registration facts and digests", () => {
    const claim = sanitizeClaimRecord(claimInput());
    expect(claim).toEqual(claimInput());
    expect(Object.keys(claim).sort()).toEqual(
      [
        "devicePublicKey",
        "deviceKeyFingerprint",
        "deviceLabel",
        "origin",
        "clientHelloDigest",
        "hostHelloNonceDigest",
        "claimedAt",
      ].sort(),
    );
  });

  it("never retains raw ticket proof, raw hello nonce, or a comparison code", () => {
    const claim = sanitizeClaimRecord(claimInput());
    const serialized = JSON.stringify(claim);
    expect(serialized).not.toContain(RAW_PROOF);
    expect(serialized).not.toContain(RAW_NONCE);
    expect(serialized).not.toContain(RAW_COMPARISON);
    expect(serialized).not.toMatch(/ticketProof|comparisonCode|clientHello":/);
    expect(claim.clientHelloDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.hostHelloNonceDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("derivePairingComparisonCode", () => {
  const base = () => ({
    hostId: "11111111-1111-4111-8111-111111111111",
    ticketId: "22222222-2222-4222-8222-222222222222",
    sourceClass: "lan-private",
    ticketProofDigest: sha256hex(RAW_PROOF),
    claim: sanitizeClaimRecord(claimInput()) as RetainedClaimFacts,
  });

  it("returns a deterministic six-digit code re-derivable from retained facts", () => {
    const input = base();
    const first = derivePairingComparisonCode(input);
    expect(first).toMatch(/^\d{6}$/);
    expect(derivePairingComparisonCode(base())).toBe(first);
  });

  it("changes when any bound fact changes", () => {
    const baseline = derivePairingComparisonCode(base());
    const variants = [
      { ...base(), hostId: "11111111-1111-4111-8111-111111111112" },
      { ...base(), ticketId: "22222222-2222-4222-8222-222222222223" },
      { ...base(), sourceClass: "tailscale" },
      { ...base(), ticketProofDigest: sha256hex("other-proof") },
      {
        ...base(),
        claim: { ...base().claim, clientHelloDigest: sha256hex("other-hello") },
      },
      {
        ...base(),
        claim: { ...base().claim, hostHelloNonceDigest: sha256hex("other-nonce") },
      },
      {
        ...base(),
        claim: { ...base().claim, deviceKeyFingerprint: "9".repeat(64) },
      },
      {
        ...base(),
        claim: { ...base().claim, origin: "https://other.example.test" },
      },
    ];
    for (const variant of variants) {
      expect(derivePairingComparisonCode(variant)).not.toBe(baseline);
    }
  });
});
