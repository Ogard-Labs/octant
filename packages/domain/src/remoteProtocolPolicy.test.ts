import { describe, expect, it } from "vitest";
import { PAIRING_MAX_FAILED_ATTEMPTS } from "./remoteAccessPolicy";
import {
  buildClientHelloTranscriptPayload,
  buildHostHelloSignaturePayload,
  buildNegotiatedProtocolPayload,
  buildPairingComparisonPayload,
  evaluatePairingStatus,
  HOST_HELLO_NONCE_TTL_MS,
  MAX_HOST_HELLO_NONCES,
  MAX_LIVE_PAIRING_TICKETS,
  MAX_PENDING_NEGOTIATIONS,
  MAX_UNDECIDED_PAIRING_CLAIMS,
  selectAuthenticationProtocolVersion,
} from "./remoteProtocolPolicy";

const hello = {
  productId: "octant" as const,
  hostId: "11111111-1111-4111-8111-111111111111",
  displayName: "This Mac",
  hostKeyFingerprint: "a".repeat(64),
  serverBuildVersion: "0.1.0",
  supportedProtocolRange: { min: 1, max: 1 },
  authenticationProtocolVersions: [1],
  securityFloor: 1,
  remoteOrigin: "https://mac.example.test",
  nonce: "nonce_1234567890",
  expiresAt: "2026-07-28T20:01:00.000Z",
};

const negotiated = {
  hostId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  challengeId: "55555555-5555-4555-8555-555555555555",
  protocolVersion: 1,
  authenticationVersion: 1,
  credentialGeneration: 1,
  origin: "https://mac.example.test",
  capabilityDigest: "c".repeat(64),
  issuedAt: "2026-07-28T20:00:00.000Z",
  expiresAt: "2026-07-28T20:01:00.000Z",
};

describe("remote protocol policy constants", () => {
  it("pins the approved bounded ephemeral policy", () => {
    expect(HOST_HELLO_NONCE_TTL_MS).toBe(60_000);
    expect(MAX_HOST_HELLO_NONCES).toBe(256);
    expect(MAX_LIVE_PAIRING_TICKETS).toBe(32);
    expect(MAX_UNDECIDED_PAIRING_CLAIMS).toBe(16);
    expect(MAX_PENDING_NEGOTIATIONS).toBe(256);
  });
});

describe("buildHostHelloSignaturePayload", () => {
  it("is deterministic and domain-separated", () => {
    const payload = buildHostHelloSignaturePayload(hello);
    expect(payload).toBe(buildHostHelloSignaturePayload({ ...hello }));
    expect(payload.startsWith("octant.host-hello.v1\n")).toBe(true);
  });

  it("binds every host-hello fact into the signed payload", () => {
    const baseline = buildHostHelloSignaturePayload(hello);
    const mutations: ReadonlyArray<Partial<typeof hello>> = [
      { hostId: "11111111-1111-4111-8111-111111111112" },
      { displayName: "Other Mac" },
      { hostKeyFingerprint: "b".repeat(64) },
      { serverBuildVersion: "0.1.1" },
      { supportedProtocolRange: { min: 1, max: 2 } },
      { authenticationProtocolVersions: [1, 2] },
      { securityFloor: 2 },
      { remoteOrigin: "https://other.example.test" },
      { nonce: "nonce_abcdefghij" },
      { expiresAt: "2026-07-28T20:02:00.000Z" },
    ];
    for (const mutation of mutations) {
      expect(buildHostHelloSignaturePayload({ ...hello, ...mutation })).not.toBe(baseline);
    }
  });
});

describe("buildNegotiatedProtocolPayload", () => {
  it("is deterministic, domain-separated, and binds every negotiated fact", () => {
    const baseline = buildNegotiatedProtocolPayload(negotiated);
    expect(baseline).toBe(buildNegotiatedProtocolPayload({ ...negotiated }));
    expect(baseline.startsWith("octant.negotiated-protocol.v1\n")).toBe(true);
    const mutations: ReadonlyArray<Partial<typeof negotiated>> = [
      { hostId: "11111111-1111-4111-8111-111111111112" },
      { deviceId: "22222222-2222-4222-8222-222222222223" },
      { challengeId: "55555555-5555-4555-8555-555555555556" },
      { protocolVersion: 2 },
      { authenticationVersion: 2 },
      { credentialGeneration: 2 },
      { origin: "https://other.example.test" },
      { capabilityDigest: "d".repeat(64) },
      { issuedAt: "2026-07-28T20:00:01.000Z" },
      { expiresAt: "2026-07-28T20:02:00.000Z" },
    ];
    for (const mutation of mutations) {
      expect(buildNegotiatedProtocolPayload({ ...negotiated, ...mutation })).not.toBe(baseline);
    }
  });

  it("cannot be confused with a host-hello payload", () => {
    expect(buildNegotiatedProtocolPayload(negotiated)).not.toBe(
      buildHostHelloSignaturePayload(hello),
    );
  });
});

describe("selectAuthenticationProtocolVersion", () => {
  it("selects the highest configured version", () => {
    expect(selectAuthenticationProtocolVersion([1])).toBe(1);
    expect(selectAuthenticationProtocolVersion([2, 1, 3])).toBe(3);
  });

  it("fails closed on empty or unsafe versions", () => {
    expect(selectAuthenticationProtocolVersion([])).toBeUndefined();
    expect(selectAuthenticationProtocolVersion([0])).toBeUndefined();
    expect(selectAuthenticationProtocolVersion([1.5])).toBeUndefined();
    expect(selectAuthenticationProtocolVersion([Number.MAX_SAFE_INTEGER + 1])).toBeUndefined();
  });
});

describe("evaluatePairingStatus", () => {
  const base = {
    state: "pending" as const,
    attempts: 0,
    now: 1_000,
    expiresAt: 2_000,
    proofMatches: true,
  };

  it("reports pending and approved only for a matching proof", () => {
    expect(evaluatePairingStatus(base)).toEqual({ kind: "pending" });
    expect(evaluatePairingStatus({ ...base, state: "approved" })).toEqual({ kind: "approved" });
  });

  it("returns generic failure for denied or expired tickets even with a matching proof", () => {
    expect(evaluatePairingStatus({ ...base, state: "denied" })).toEqual({ kind: "failed" });
    expect(evaluatePairingStatus({ ...base, state: "expired" })).toEqual({ kind: "failed" });
    expect(evaluatePairingStatus({ ...base, now: 2_000 })).toEqual({ kind: "failed" });
  });

  it("counts mismatched proofs toward the shared attempt budget", () => {
    const first = evaluatePairingStatus({ ...base, proofMatches: false });
    expect(first).toEqual({ kind: "failed", attempts: 1 });
    const last = evaluatePairingStatus({
      ...base,
      proofMatches: false,
      attempts: PAIRING_MAX_FAILED_ATTEMPTS - 1,
    });
    expect(last).toEqual({
      kind: "failed",
      attempts: PAIRING_MAX_FAILED_ATTEMPTS,
      exhausted: true,
    });
  });

  it("never reveals approval without a matching proof", () => {
    expect(evaluatePairingStatus({ ...base, state: "approved", proofMatches: false }).kind).toBe(
      "failed",
    );
  });
});

describe("buildClientHelloTranscriptPayload", () => {
  const clientHello = {
    webBuildVersion: "0.1.0",
    supportedProtocolRange: { min: 1, max: 1 },
    browserCapabilities: ["webcrypto", "indexeddb"],
  };

  it("is deterministic, domain-separated, and capability-order independent", () => {
    const baseline = buildClientHelloTranscriptPayload(clientHello);
    expect(baseline.startsWith("octant.client-hello.v1\n")).toBe(true);
    expect(
      buildClientHelloTranscriptPayload({
        ...clientHello,
        browserCapabilities: ["indexeddb", "webcrypto"],
      }),
    ).toBe(baseline);
  });

  it("changes when range, build, capabilities, or optional deviceId change", () => {
    const baseline = buildClientHelloTranscriptPayload(clientHello);
    const mutations = [
      { webBuildVersion: "0.2.0" },
      { supportedProtocolRange: { min: 1, max: 2 } },
      { supportedProtocolRange: { min: 2, max: 2 } },
      { browserCapabilities: ["webcrypto"] },
      { browserCapabilities: ["webcrypto", "indexeddb", "streams"] },
      { deviceId: "22222222-2222-4222-8222-222222222222" },
    ];
    for (const mutation of mutations) {
      expect(buildClientHelloTranscriptPayload({ ...clientHello, ...mutation })).not.toBe(baseline);
    }
    expect(
      buildClientHelloTranscriptPayload({
        ...clientHello,
        deviceId: "22222222-2222-4222-8222-222222222222",
      }),
    ).not.toBe(
      buildClientHelloTranscriptPayload({
        ...clientHello,
        deviceId: "33333333-3333-4333-8333-333333333333",
      }),
    );
  });

  it("is unambiguous for capabilities containing separators", () => {
    expect(
      buildClientHelloTranscriptPayload({ ...clientHello, browserCapabilities: ["a\nb", "c"] }),
    ).not.toBe(
      buildClientHelloTranscriptPayload({ ...clientHello, browserCapabilities: ["a", "b\nc"] }),
    );
  });
});

describe("buildPairingComparisonPayload", () => {
  const transcript = {
    hostId: "11111111-1111-4111-8111-111111111111",
    ticketId: "22222222-2222-4222-8222-222222222222",
    deviceKeyFingerprint: "b".repeat(64),
    origin: "https://mac.example.test",
    sourceClass: "lan-private",
    clientHelloDigest: "c".repeat(64),
    ticketProofDigest: "d".repeat(64),
    hostHelloNonceDigest: "e".repeat(64),
  };

  it("is deterministic, domain-separated, and binds every transcript fact", () => {
    const baseline = buildPairingComparisonPayload(transcript);
    expect(baseline).toBe(buildPairingComparisonPayload({ ...transcript }));
    expect(baseline.startsWith("octant.pairing-comparison.v1\n")).toBe(true);
    const mutations: ReadonlyArray<Partial<typeof transcript>> = [
      { hostId: "11111111-1111-4111-8111-111111111112" },
      { ticketId: "22222222-2222-4222-8222-222222222223" },
      { deviceKeyFingerprint: "f".repeat(64) },
      { origin: "https://other.example.test" },
      { sourceClass: "tailscale" },
      { clientHelloDigest: "1".repeat(64) },
      { ticketProofDigest: "2".repeat(64) },
      { hostHelloNonceDigest: "3".repeat(64) },
    ];
    for (const mutation of mutations) {
      expect(buildPairingComparisonPayload({ ...transcript, ...mutation })).not.toBe(baseline);
    }
  });

  it("cannot be confused with hello, negotiated, or client-hello payloads", () => {
    const payload = buildPairingComparisonPayload(transcript);
    expect(payload).not.toBe(buildHostHelloSignaturePayload(hello));
    expect(payload).not.toBe(buildNegotiatedProtocolPayload(negotiated));
    expect(payload).not.toBe(
      buildClientHelloTranscriptPayload({
        webBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        browserCapabilities: [],
      }),
    );
  });
});
