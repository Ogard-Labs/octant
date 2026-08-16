import { describe, expect, it } from "vitest";
import {
  decodeClientHelloV1,
  decodeDeviceRegistrationV1,
  decodeHostHelloV1,
  decodeNegotiatedProtocolV1,
  decodeNegotiatedSessionV1,
  decodeNegotiationRequestV1,
  decodePairingDecisionV1,
  decodePairingRequestV1,
  decodePairingStatusRequestV1,
  decodePairingStatusResultV1,
  decodeDeviceKeyRotatedV1,
  decodeRemoteSessionInvalidatedV1,
  decodeRemoteCommandReceiptRecordedV1,
  decodePairingTicketV1,
  decodeSecurityAuditRecordV1,
  decodeRemoteCommandResultV1,
  decodeRemoteClockGuardV1,
  decodeRemoteTimePostureV1,
  REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR,
} from "./remoteAccess";

const ids = {
  host: "11111111-1111-4111-8111-111111111111",
  device: "22222222-2222-4222-8222-222222222222",
  session: "33333333-3333-4333-8333-333333333333",
  command: "55555555-5555-4555-8555-555555555555",
  nonce: "nonce_1234567890",
} as const;

const now = "2026-07-28T20:00:00.000Z";

describe("remote-access contracts", () => {
  it("decodes a strict, non-sensitive host hello", () => {
    expect(
      decodeHostHelloV1({
        productId: "octant",
        hostId: ids.host,
        displayName: "This Mac",
        hostKeyFingerprint: "a".repeat(64),
        serverBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        authenticationProtocolVersions: [1],
        securityFloor: 1,
        remoteOrigin: "https://mac.example.test",
        nonce: ids.nonce,
        expiresAt: now,
        signature: "sig_123",
      }),
    ).toMatchObject({ hostId: ids.host, securityFloor: 1 });
  });

  it("rejects secret-bearing or excess host-hello fields", () => {
    expect(() =>
      decodeHostHelloV1({
        productId: "octant",
        hostId: ids.host,
        displayName: "This Mac",
        hostKeyFingerprint: "a".repeat(64),
        serverBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        authenticationProtocolVersions: [1],
        securityFloor: 1,
        remoteOrigin: "https://mac.example.test",
        nonce: ids.nonce,
        expiresAt: now,
        signature: "sig_123",
        sessionSecret: "must-not-cross",
      }),
    ).toThrow();
  });

  it("requires pairing requests to carry a device key and no raw address", () => {
    const request = decodePairingRequestV1({
      ticketId: ids.session,
      ticketProof: "proof_123",
      hostHelloNonce: ids.nonce,
      devicePublicKey: "-----BEGIN PUBLIC KEY-----",
      deviceKeyFingerprint: "b".repeat(64),
      deviceLabel: "Ada's Safari",
      origin: "https://mac.example.test",
      clientHello: {
        webBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        browserCapabilities: ["webcrypto"],
      },
    });
    expect(request.ticketId).toBe(ids.session);
    expect("sourceAddress" in request).toBe(false);
  });

  it("keeps negotiated sessions and devices free of credentials", () => {
    const device = decodeDeviceRegistrationV1({
      hostId: ids.host,
      deviceId: ids.device,
      deviceKeyFingerprint: "b".repeat(64),
      devicePublicKey: "public-key",
      deviceLabel: "Safari",
      origin: "https://mac.example.test",
      protocolFloor: 1,
      credentialGeneration: 1,
      createdAt: now,
      expiresAt: "2026-10-26T20:00:00.000Z",
      lastSeenAt: now,
      state: "active",
    });
    const session = decodeNegotiatedSessionV1({
      hostId: ids.host,
      deviceId: ids.device,
      sessionId: ids.session,
      protocolVersion: 1,
      authenticationVersion: 1,
      credentialGeneration: 1,
      origin: "https://mac.example.test",
      capabilityDigest: "c".repeat(64),
      issuedAt: now,
      idleExpiresAt: "2026-07-28T20:15:00.000Z",
      absoluteExpiresAt: "2026-07-29T08:00:00.000Z",
      hostSignature: "sig_123",
    });
    expect(device.state).toBe("active");
    expect(session.sessionId).toBe(ids.session);
    expect(JSON.stringify({ device, session })).not.toMatch(/secret|cookie|csrf|private/i);
  });

  it("accepts only redacted audit facts", () => {
    expect(
      decodeSecurityAuditRecordV1({
        eventKind: "device-approved",
        hostId: ids.host,
        deviceId: ids.device,
        protocolVersion: 1,
        credentialGeneration: 1,
        sourceClass: "lan-private",
        resultCategory: "approved",
        reasonCode: "user-approved",
        correlationId: ids.session,
        occurredAt: now,
      }),
    ).toMatchObject({ eventKind: "device-approved" });
    expect(() =>
      decodeSecurityAuditRecordV1({
        eventKind: "device-approved",
        hostId: ids.host,
        deviceId: ids.device,
        protocolVersion: 1,
        credentialGeneration: 1,
        sourceClass: "lan-private",
        resultCategory: "approved",
        reasonCode: "user-approved",
        correlationId: ids.session,
        occurredAt: now,
        authorizationHeader: "Bearer secret",
      }),
    ).toThrow();
  });

  it("keeps lifecycle receipts bounded and free of credential material", () => {
    const invalidation = decodeRemoteSessionInvalidatedV1({
      hostId: ids.host,
      deviceId: ids.device,
      sessionIdDigest: "d".repeat(64),
      credentialGeneration: 1,
      invalidatedAt: now,
      reasonCode: "credential-rotated",
      receiptId: ids.command,
    });
    const receipt = decodeRemoteCommandReceiptRecordedV1({
      commandId: ids.command,
      hostId: ids.host,
      deviceId: ids.device,
      operationKind: "rotate-device",
      operationDigest: "a".repeat(64),
      resultCategory: "applied",
      createdAt: now,
      expiresAt: "2026-08-05T20:00:00.000Z",
    });
    expect(JSON.stringify({ invalidation, receipt })).not.toMatch(
      /private|proof|cookie|csrf|authorization|path|address/i,
    );
    expect(JSON.stringify({ invalidation, receipt })).not.toContain(ids.session);
    expect(() =>
      decodeRemoteSessionInvalidatedV1({ ...invalidation, sessionId: ids.session }),
    ).toThrow();
    expect(() => decodeRemoteSessionInvalidatedV1({ ...invalidation, proof: "secret" })).toThrow();
  });

  it("binds rotation to the bounded replacement public key", () => {
    expect(
      decodeDeviceKeyRotatedV1({
        hostId: ids.host,
        deviceId: ids.device,
        previousGeneration: 1,
        credentialGeneration: 2,
        deviceKeyFingerprint: "c".repeat(64),
        devicePublicKey: "replacement-public-key",
        rotatedAt: now,
        graceExpiresAt: now,
      }),
    ).toMatchObject({ devicePublicKey: "replacement-public-key" });
  });

  it("decodes bounded pairing tickets and decisions without secret material", () => {
    const ticket = decodePairingTicketV1({
      ticketId: ids.session,
      hostId: ids.host,
      createdAt: now,
      expiresAt: "2026-07-28T20:05:00.000Z",
      failedAttempts: 0,
      state: "pending",
      sourceClass: "lan-private",
    });
    const decision = decodePairingDecisionV1({
      ticketId: ids.session,
      hostId: ids.host,
      decision: "approved",
      decidedAt: now,
      reasonCode: "user-approved",
    });
    expect(ticket.state).toBe("pending");
    expect(decision.decision).toBe("approved");
    expect(JSON.stringify({ ticket, decision })).not.toMatch(/proof|secret|cookie|csrf/i);
    expect(() =>
      decodePairingTicketV1({
        ticketId: ids.session,
        hostId: ids.host,
        createdAt: now,
        expiresAt: "2026-07-28T20:05:00.000Z",
        failedAttempts: 0,
        state: "pending",
        sourceClass: "lan-private",
        ticketProof: "must-not-persist",
      }),
    ).toThrow();
  });

  it("rejects a client hello with no safe protocol overlap", () => {
    expect(() =>
      decodeClientHelloV1({
        webBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 2, max: 3 },
        browserCapabilities: [],
      }),
    ).not.toThrow();
  });

  it("pins the identity-only capability vector until product capabilities land", () => {
    expect(REMOTE_AUTHENTICATION_ONLY_CAPABILITY_VECTOR).toBe("remote-authentication-only:v1");
  });

  it("bounds pairing status polling to a body-carried ticket id and proof", () => {
    const request = decodePairingStatusRequestV1({
      ticketId: ids.session,
      ticketProof: "proof_123",
    });
    expect(request.ticketId).toBe(ids.session);
    expect(JSON.stringify(request)).not.toMatch(/secret|cookie|csrf|nonce/i);
    expect(() =>
      decodePairingStatusRequestV1({
        ticketId: ids.session,
        ticketProof: "proof_123",
        origin: "https://mac.example.test",
      }),
    ).toThrow();
    expect(() =>
      decodePairingStatusRequestV1({ ticketId: "not-a-uuid", ticketProof: "proof_123" }),
    ).toThrow();
    expect(() =>
      decodePairingStatusRequestV1({ ticketId: ids.session, ticketProof: "" }),
    ).toThrow();
    expect(() =>
      decodePairingStatusRequestV1({ ticketId: ids.session, ticketProof: `proof?in=query` }),
    ).toThrow();
  });

  it("keeps pairing status results generic pending/approved/failed", () => {
    expect(decodePairingStatusResultV1({ status: "pending" })).toMatchObject({
      status: "pending",
    });
    expect(decodePairingStatusResultV1({ status: "failed" })).toMatchObject({ status: "failed" });
    const approved = decodePairingStatusResultV1({
      status: "approved",
      deviceId: ids.device,
      credentialGeneration: 1,
    });
    expect(approved).toMatchObject({ status: "approved", deviceId: ids.device });
    expect(() => decodePairingStatusResultV1({ status: "denied" })).toThrow();
    expect(() => decodePairingStatusResultV1({ status: "expired" })).toThrow();
    expect(() =>
      decodePairingStatusResultV1({ status: "approved", deviceId: ids.device }),
    ).toThrow();
    expect(() =>
      decodePairingStatusResultV1({
        status: "approved",
        deviceId: ids.device,
        credentialGeneration: 1,
        reasonCode: "user-denied",
      }),
    ).toThrow();
    expect(() =>
      decodePairingStatusResultV1({ status: "failed", reasonCode: "expired" }),
    ).toThrow();
  });

  it("binds negotiation requests to nonce, challenge, device, origin, and client hello", () => {
    const request = decodeNegotiationRequestV1({
      hostHelloNonce: ids.nonce,
      challengeId: ids.command,
      deviceId: ids.device,
      origin: "https://mac.example.test",
      clientHello: {
        webBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        browserCapabilities: ["webcrypto"],
      },
    });
    expect(request.deviceId).toBe(ids.device);
    expect(() =>
      decodeNegotiationRequestV1({
        hostHelloNonce: ids.nonce,
        challengeId: ids.command,
        deviceId: ids.device,
        origin: "http://mac.example.test",
        clientHello: {
          webBuildVersion: "0.1.0",
          supportedProtocolRange: { min: 1, max: 1 },
          browserCapabilities: ["webcrypto"],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeNegotiationRequestV1({
        hostHelloNonce: ids.nonce,
        challengeId: ids.command,
        deviceId: ids.device,
        origin: "https://mac.example.test",
        clientHello: {
          webBuildVersion: "0.1.0",
          supportedProtocolRange: { min: 1, max: 1 },
          browserCapabilities: ["webcrypto"],
        },
        sessionId: ids.session,
      }),
    ).toThrow();
  });

  it("bounds command result lookup to applied/pending/failed/not-found/ambiguous", () => {
    const applied = decodeRemoteCommandResultV1({
      kind: "applied",
      commandId: ids.command,
      operationKind: "chat-send-turn",
      occurredAt: now,
      expiresAt: "2026-08-05T20:00:00.000Z",
    });
    expect(applied).toMatchObject({ kind: "applied", commandId: ids.command });

    const failed = decodeRemoteCommandResultV1({
      kind: "failed",
      commandId: ids.command,
      operationKind: "chat-send-turn",
      reasonCode: "stale-version",
      occurredAt: now,
      expiresAt: "2026-08-05T20:00:00.000Z",
    });
    expect(failed).toMatchObject({ kind: "failed", reasonCode: "stale-version" });

    const pending = decodeRemoteCommandResultV1({
      kind: "pending",
      commandId: ids.command,
      operationKind: "chat-send-turn",
      createdAt: now,
      expiresAt: "2026-08-05T20:00:00.000Z",
    });
    expect(pending).toMatchObject({ kind: "pending", commandId: ids.command });

    const notFound = decodeRemoteCommandResultV1({ kind: "not-found", commandId: ids.command });
    expect(notFound).toMatchObject({ kind: "not-found", commandId: ids.command });

    const ambiguous = decodeRemoteCommandResultV1({
      kind: "ambiguous",
      commandId: ids.command,
      reason: "in-flight",
    });
    expect(ambiguous).toMatchObject({ kind: "ambiguous", reason: "in-flight" });

    expect(() =>
      decodeRemoteCommandResultV1({ kind: "unknown", commandId: ids.command }),
    ).toThrow();
    expect(() =>
      decodeRemoteCommandResultV1({
        kind: "applied",
        commandId: ids.command,
        operationKind: "chat-send-turn",
        occurredAt: now,
        expiresAt: "2026-08-05T20:00:00.000Z",
        secret: "must-not-cross",
      }),
    ).toThrow();
  });

  it("keeps negotiated protocol receipts signed, bounded, and credential-free", () => {
    const negotiated = decodeNegotiatedProtocolV1({
      hostId: ids.host,
      deviceId: ids.device,
      challengeId: ids.command,
      protocolVersion: 1,
      authenticationVersion: 1,
      credentialGeneration: 1,
      origin: "https://mac.example.test",
      capabilityDigest: "c".repeat(64),
      issuedAt: now,
      expiresAt: "2026-07-28T20:01:00.000Z",
      hostSignature: "sig_123",
    });
    expect(negotiated.protocolVersion).toBe(1);
    expect(JSON.stringify(negotiated)).not.toMatch(/secret|cookie|csrf|private|proof/i);
    expect(() => decodeNegotiatedProtocolV1({ ...negotiated, sessionId: ids.session })).toThrow();
    expect(() =>
      decodeNegotiatedProtocolV1({ ...negotiated, capabilityDigest: "not-a-digest" }),
    ).toThrow();
  });

  it("decodes a non-sensitive monotonic clock guard record", () => {
    const guard = decodeRemoteClockGuardV1({
      hostId: ids.host,
      highWaterMarkMs: 1_722_196_800_000,
      observedAt: now,
      posture: "ok",
    });
    expect(guard).toMatchObject({ hostId: ids.host, posture: "ok" });
    expect(JSON.stringify(guard)).not.toMatch(/secret|cookie|csrf|private|proof|token/i);
    expect(() =>
      decodeRemoteClockGuardV1({
        hostId: ids.host,
        highWaterMarkMs: -1,
        observedAt: now,
        posture: "ok",
      }),
    ).toThrow();
    expect(() =>
      decodeRemoteClockGuardV1({
        hostId: ids.host,
        highWaterMarkMs: 1,
        observedAt: now,
        posture: "unknown",
      }),
    ).toThrow();
  });

  it("bounds the time-posture diagnostic to ok/recovery-required with a coarse reason", () => {
    const ok = decodeRemoteTimePostureV1({
      posture: "ok",
      highWaterMarkMs: 1_000,
      effectiveNowMs: 1_000,
    });
    expect(ok).toMatchObject({ posture: "ok" });

    const recovery = decodeRemoteTimePostureV1({
      posture: "recovery-required",
      reason: "clock-rollback",
      highWaterMarkMs: 2_000,
      effectiveNowMs: 2_000,
      correlationId: ids.command,
    });
    expect(recovery).toMatchObject({ posture: "recovery-required", reason: "clock-rollback" });

    const forwardJump = decodeRemoteTimePostureV1({
      posture: "recovery-required",
      reason: "forward-jump",
      highWaterMarkMs: 3_000,
      effectiveNowMs: 3_000,
      correlationId: ids.command,
    });
    expect(forwardJump).toMatchObject({ posture: "recovery-required", reason: "forward-jump" });

    // Recovery diagnostics never carry raw request material.
    expect(() =>
      decodeRemoteTimePostureV1({
        posture: "recovery-required",
        reason: "clock-rollback",
        highWaterMarkMs: 2_000,
        effectiveNowMs: 2_000,
        correlationId: ids.command,
        rawClock: "leak",
      }),
    ).toThrow();
    expect(() =>
      decodeRemoteTimePostureV1({
        posture: "recovery-required",
        reason: "unknown",
        highWaterMarkMs: 2_000,
        effectiveNowMs: 2_000,
        correlationId: ids.command,
      }),
    ).toThrow();
  });
});
