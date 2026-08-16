import { describe, expect, it } from "vitest";
import {
  buildRemoteKeyRotationProofPayload,
  buildRemoteRequestProofPayload,
  buildRemoteSessionMetadataPayload,
  canonicalizeRemotePathQuery,
  evaluateRemoteRequestFreshness,
  REMOTE_REQUEST_NONCE_RETENTION_MS,
  sessionExpiry,
} from "./remoteRequestProofPolicy";

const session = {
  issuedAt: "2026-07-29T09:00:00.000Z",
  idleExpiresAt: "2026-07-29T09:15:00.000Z",
  absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
} as const;

describe("remote request proof policy", () => {
  it("canonicalizes only relative path/query targets deterministically", () => {
    expect(canonicalizeRemotePathQuery("/api/chat?b=2&a=1&a=0")).toBe("/api/chat?a=0&a=1&b=2");
    expect(canonicalizeRemotePathQuery("https://elsewhere.test/api")).toBeUndefined();
    expect(canonicalizeRemotePathQuery("/api#fragment")).toBeUndefined();
    expect(canonicalizeRemotePathQuery("/api\\escape")).toBeUndefined();
  });

  it("binds every proof fact into one domain-separated payload", () => {
    const base = {
      sessionId: "33333333-3333-4333-8333-333333333333",
      proof: {
        method: "POST" as const,
        canonicalPathQuery: "/api/chat?prompt=1",
        bodyDigest: "a".repeat(64),
        timestamp: "2026-07-29T09:00:00.000Z",
        nonce: "nonce_1234567890",
      },
    };
    expect(buildRemoteRequestProofPayload(base)).toContain("octant.remote-request-proof.v1");
    expect(buildRemoteRequestProofPayload(base)).not.toBe(
      buildRemoteRequestProofPayload({
        ...base,
        proof: { ...base.proof, method: "GET" },
      }),
    );
  });

  it("rejects stale/future request timestamps and reports session rotation", () => {
    expect(
      evaluateRemoteRequestFreshness({
        nowMs: Date.parse("2026-07-29T09:00:00.000Z"),
        proofTimestamp: "2026-07-29T08:59:30.001Z",
        session,
      }),
    ).toEqual({ kind: "active", rotate: false });
    expect(
      evaluateRemoteRequestFreshness({
        nowMs: Date.parse("2026-07-29T09:00:00.000Z"),
        proofTimestamp: "2026-07-29T08:59:29.998Z",
        session,
      }),
    ).toEqual({ kind: "rejected", reason: "clock-skew" });
    expect(
      evaluateRemoteRequestFreshness({
        nowMs: Date.parse("2026-07-29T09:00:00.000Z"),
        proofTimestamp: "2026-07-29T09:00:00.000Z",
        session: { ...session, issuedAt: "2026-07-29T08:44:59.000Z" },
      }),
    ).toEqual({ kind: "active", rotate: true });
  });

  it("keeps session expiry bounded and nonce retention short", () => {
    expect(sessionExpiry(Date.parse("2026-07-29T09:00:00.000Z"))).toEqual({
      issuedAt: "2026-07-29T09:00:00.000Z",
      idleExpiresAt: "2026-07-29T09:15:00.000Z",
      absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
    });
    expect(REMOTE_REQUEST_NONCE_RETENTION_MS).toBe(60_000);
  });

  it("binds dual-key rotation transcripts without raw session identifiers", () => {
    const rotation = {
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 3,
      newDeviceKeyFingerprint: "d".repeat(64),
      newDevicePublicKey: "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----",
    } as const;
    const payload = buildRemoteKeyRotationProofPayload(rotation);
    expect(payload).toContain("octant.remote-key-rotation.v1");
    expect(payload).toContain(rotation.hostId);
    expect(payload).toContain(rotation.newDeviceKeyFingerprint);
    expect(payload).not.toMatch(/sessionId|csrf|cookie/i);
    expect(payload).not.toBe(
      buildRemoteKeyRotationProofPayload({ ...rotation, credentialGeneration: 4 }),
    );
    expect(payload).not.toBe(
      buildRemoteKeyRotationProofPayload({
        ...rotation,
        newDeviceKeyFingerprint: "e".repeat(64),
      }),
    );
  });

  it("binds public session metadata without session or CSRF secrets", () => {
    const metadata = {
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId: "22222222-2222-4222-8222-222222222222",
      credentialGeneration: 3,
      origin: "https://mac.example.test",
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest: "c".repeat(64),
      ...session,
    } as const;
    const payload = buildRemoteSessionMetadataPayload(metadata);
    expect(payload).toContain("octant.remote-session-metadata.v1");
    expect(payload).toContain(metadata.hostId);
    expect(payload).not.toMatch(/sessionId|csrf/i);
    expect(payload).not.toBe(
      buildRemoteSessionMetadataPayload({ ...metadata, credentialGeneration: 4 }),
    );
    expect(payload).not.toBe(
      buildRemoteSessionMetadataPayload({ ...metadata, authenticationVersion: 2 }),
    );
    expect(payload).not.toBe(
      buildRemoteSessionMetadataPayload({ ...metadata, origin: "https://evil.example.test" }),
    );
  });
});
