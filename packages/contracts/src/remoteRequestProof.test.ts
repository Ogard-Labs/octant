import { describe, expect, it } from "vitest";
import {
  decodeRemoteAuthenticatedRequestResultV1,
  decodeRemoteChallengeRequestV1,
  decodeRemoteKeyRotationRequestV1,
  decodeRemoteRequestFactsV1,
  decodeRemoteSelfServiceEmptyBodyV1,
  decodeRemoteSelfServiceReceiptV1,
  decodeRemoteSessionIssuedV1,
  decodeRemoteSessionRequestV1,
  decodeRemoteSessionResponseV1,
} from "./remoteRequestProof";

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const now = "2026-07-29T09:00:00.000Z";
const digest = "a".repeat(64);

describe("remote request proof contracts", () => {
  it("accepts bounded proof facts without raw transport headers", () => {
    const facts = decodeRemoteRequestFactsV1({
      hostId,
      deviceId,
      sessionId,
      credentialGeneration: 3,
      origin: "https://mac.example.test",
      protocolVersion: 1,
      proof: {
        method: "POST",
        canonicalPathQuery: "/api/chat/threads?b=2&a=1",
        bodyDigest: digest,
        csrfDigest: "b".repeat(64),
        timestamp: now,
        nonce: "nonce_1234567890",
        signature: "signature_123",
      },
    });
    expect(facts.proof.method).toBe("POST");
    expect("authorization" in facts).toBe(false);
    expect("cookie" in facts).toBe(false);
  });

  it("rejects malformed proof fields and secret-bearing extras", () => {
    expect(() =>
      decodeRemoteRequestFactsV1({
        hostId,
        deviceId,
        sessionId,
        credentialGeneration: 3,
        origin: "https://mac.example.test",
        protocolVersion: 1,
        proof: {
          method: "post",
          canonicalPathQuery: "https://elsewhere.test/api",
          bodyDigest: digest,
          timestamp: now,
          nonce: "nonce_1234567890",
          signature: "signature_123",
          authorization: "Bearer secret",
        },
      }),
    ).toThrow();
  });

  it("keeps issued sessions and authenticated results identity-only", () => {
    const issued = decodeRemoteSessionIssuedV1({
      hostId,
      deviceId,
      sessionId,
      credentialGeneration: 3,
      origin: "https://mac.example.test",
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest: digest,
      issuedAt: now,
      idleExpiresAt: "2026-07-29T09:15:00.000Z",
      absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
      csrfToken: "csrf_1234567890",
    });
    const result = decodeRemoteAuthenticatedRequestResultV1({
      hostId,
      deviceId,
      sessionId,
      credentialGeneration: 3,
      protocolVersion: issued.protocolVersion,
      origin: issued.origin,
      freshness: "current",
    });
    expect(result).toMatchObject({ hostId, deviceId, sessionId, credentialGeneration: 3 });
    expect(JSON.stringify(result)).not.toMatch(/cookie|authorization|private key/i);
  });

  it("accepts only strict bounded challenge and session request bodies", () => {
    const challengeRequest = decodeRemoteChallengeRequestV1({
      hostId,
      deviceId,
      credentialGeneration: 3,
    });
    expect(challengeRequest).toEqual({ hostId, deviceId, credentialGeneration: 3 });
    expect(() =>
      decodeRemoteChallengeRequestV1({ hostId, deviceId, credentialGeneration: 3, extra: true }),
    ).toThrow();
    expect(() => decodeRemoteChallengeRequestV1({ hostId, deviceId })).toThrow();
    expect(() =>
      decodeRemoteChallengeRequestV1({ hostId: "not-a-uuid", deviceId, credentialGeneration: 3 }),
    ).toThrow();

    const sessionRequest = decodeRemoteSessionRequestV1({
      challengeId: "44444444-4444-4444-8444-444444444444",
      hostId,
      deviceId,
      credentialGeneration: 3,
      nonce: "challenge_nonce_1234567890",
      issuedAt: now,
      expiresAt: "2026-07-29T09:01:00.000Z",
      signature: "signature_123",
    });
    expect(sessionRequest.signature).toBe("signature_123");
    expect(() =>
      decodeRemoteSessionRequestV1({
        challengeId: "44444444-4444-4444-8444-444444444444",
        hostId,
        deviceId,
        credentialGeneration: 3,
        nonce: "challenge_nonce_1234567890",
        issuedAt: now,
        expiresAt: "2026-07-29T09:01:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      decodeRemoteSessionRequestV1({
        challengeId: "44444444-4444-4444-8444-444444444444",
        hostId,
        deviceId,
        credentialGeneration: 3,
        nonce: "challenge nonce with spaces",
        issuedAt: now,
        expiresAt: "2026-07-29T09:01:00.000Z",
        signature: "signature_123",
        ticketProof: "secret",
      }),
    ).toThrow();
  });

  it("accepts dual-key rotation bodies and rejects device targeting or secrets", () => {
    const rotation = decodeRemoteKeyRotationRequestV1({
      newDeviceKeyFingerprint: digest,
      newDevicePublicKey: "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----",
      newKeyProof: "new_key_signature_123",
    });
    expect(rotation.newKeyProof).toBe("new_key_signature_123");
    expect("deviceId" in rotation).toBe(false);
    expect("sessionId" in rotation).toBe(false);
    expect(() =>
      decodeRemoteKeyRotationRequestV1({
        newDeviceKeyFingerprint: digest,
        newDevicePublicKey: "-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----",
        newKeyProof: "new_key_signature_123",
        deviceId,
      }),
    ).toThrow();
    expect(() =>
      decodeRemoteKeyRotationRequestV1({
        newDeviceKeyFingerprint: digest,
        newDevicePublicKey: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        newKeyProof: "new_key_signature_123",
      }),
    ).toThrow();
    expect(decodeRemoteSelfServiceEmptyBodyV1({})).toEqual({});
    expect(() => decodeRemoteSelfServiceEmptyBodyV1({ deviceId })).toThrow();
    const receipt = decodeRemoteSelfServiceReceiptV1({
      commandId: "66666666-6666-4666-8666-666666666666",
      result: "applied",
      occurredAt: now,
    });
    expect(receipt.result).toBe("applied");
    expect("sessionId" in receipt).toBe(false);
    expect(() =>
      decodeRemoteSelfServiceReceiptV1({
        commandId: "66666666-6666-4666-8666-666666666666",
        result: "applied",
        occurredAt: now,
        sessionId,
      }),
    ).toThrow();
  });

  it("carries the session id in the wire session response (browsers cannot read Set-Cookie)", () => {
    // Browsers forbid reading `Set-Cookie` from the fetch API, so the wire
    // session response must carry the session id in the body. The session id
    // alone grants nothing without the device key proof.
    const response = decodeRemoteSessionResponseV1({
      hostId,
      deviceId,
      sessionId,
      credentialGeneration: 3,
      origin: "https://mac.example.test",
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest: digest,
      issuedAt: now,
      idleExpiresAt: "2026-07-29T09:15:00.000Z",
      absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
      csrfToken: "csrf_1234567890",
      negotiationSignature: "host_signature_123",
    });
    expect(response.sessionId).toBe(sessionId);
    expect(response.negotiationSignature).toBe("host_signature_123");
    expect(response.authenticationVersion).toBe(1);
    expect(() =>
      decodeRemoteSessionResponseV1({
        hostId,
        deviceId,
        credentialGeneration: 3,
        origin: "https://mac.example.test",
        protocolVersion: 1,
        authenticationVersion: 1,
        capabilityDigest: digest,
        issuedAt: now,
        idleExpiresAt: "2026-07-29T09:15:00.000Z",
        absoluteExpiresAt: "2026-07-29T21:00:00.000Z",
        csrfToken: "csrf_1234567890",
        negotiationSignature: "host_signature_123",
      }),
    ).toThrow();
  });
});
