import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sessionExpiry } from "@octant/domain";
import { RemoteRequestProofError } from "../remoteRequestProofService";
import {
  RemoteServerProxySessions,
  proxySessionEndReasonForCredentialChange,
  type RemoteServerProxyProofPort,
  type RemoteServerProxySessionEnded,
} from "./remoteServerProxySessions";

const hostId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const origin = "https://192.168.1.20:9443";
const issuedAtMs = Date.parse("2026-10-15T09:00:00.000Z");

function harness(
  options: {
    readonly noncesPerSession?: number;
    readonly sessionsPerHost?: number;
    readonly holdsOpenSockets?: () => boolean;
  } = {},
) {
  let now = issuedAtMs;
  let standing: "current" | "revoked" | "credential-expired" | "credential-rotated" = "current";
  const ended: RemoteServerProxySessionEnded[] = [];
  const proofs: RemoteServerProxyProofPort = {
    issueServerProxySessionFacts: (input) => ({
      hostId,
      deviceId: input.deviceId,
      credentialGeneration: 1,
      origin,
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest: "c".repeat(64),
      ...sessionExpiry(now),
    }),
    deviceStanding: () => standing,
    verifyDeviceRequestSignature: () => true,
  };
  const sessions = new RemoteServerProxySessions({
    proofs,
    onSessionEnded: (session) => ended.push(session),
    ...(options.holdsOpenSockets === undefined
      ? {}
      : { holdsOpenSockets: options.holdsOpenSockets }),
    now: () => now,
    uuid: randomUUID,
    limits: {
      ...(options.noncesPerSession === undefined
        ? {}
        : { noncesPerSession: options.noncesPerSession }),
      ...(options.sessionsPerHost === undefined
        ? {}
        : { sessionsPerHost: options.sessionsPerHost }),
    },
  });
  const issue = (device = deviceId) =>
    sessions.issue({
      challengeId: randomUUID(),
      hostId,
      deviceId: device,
      credentialGeneration: 1,
      nonce: "n".repeat(43),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      signature: "s".repeat(86),
    } as Parameters<RemoteServerProxySessions["issue"]>[0]);
  const verify = (sessionId: string, csrfToken: string, nonce: string) =>
    sessions.verifyRequest({
      hostId,
      deviceId,
      sessionId,
      credentialGeneration: 1,
      origin,
      protocolVersion: 1,
      proof: {
        method: "POST",
        canonicalPathQuery: "/api/server-proxy/grants",
        bodyDigest: "d".repeat(64),
        csrfDigest: createHash("sha256").update(csrfToken, "utf8").digest("hex"),
        timestamp: new Date(now).toISOString(),
        nonce,
        signature: "s".repeat(86),
      },
    });
  return {
    sessions,
    ended,
    issue,
    verify,
    advance: (ms: number) => {
      now += ms;
    },
    revokeDevice: (next: typeof standing = "revoked") => {
      standing = next;
    },
  };
}

function refusal(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof RemoteRequestProofError ? error.category : "thrown";
  }
}

describe("RemoteServerProxySessions", () => {
  it("accepts a fresh nonce once and refuses it replayed", () => {
    const { issue, verify } = harness();
    const { sessionId, csrfToken } = issue();
    expect(verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaaa").freshness).toBe("current");
    expect(refusal(() => verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaaa"))).toBe("replayed");
  });

  it("refuses past its own nonce budget, which no other session shares", () => {
    const { issue, verify } = harness({ noncesPerSession: 2 });
    const first = issue();
    verify(first.sessionId, first.csrfToken, "nonce_aaaaaaaaaaaaaaa1");
    verify(first.sessionId, first.csrfToken, "nonce_aaaaaaaaaaaaaaa2");
    expect(refusal(() => verify(first.sessionId, first.csrfToken, "nonce_aaaaaaaaaaaaaaa3"))).toBe(
      "capacity",
    );
    const second = issue();
    expect(verify(second.sessionId, second.csrfToken, "nonce_aaaaaaaaaaaaaaa3").freshness).toBe(
      "current",
    );
  });

  it("refuses another session's CSRF token", () => {
    const { issue, verify } = harness();
    const first = issue();
    const second = issue();
    expect(refusal(() => verify(first.sessionId, second.csrfToken, "nonce_aaaaaaaaaaaaaaaa"))).toBe(
      "invalid",
    );
  });

  it("ends a session, closing its grants, once its device no longer stands", () => {
    const { issue, sessions, revokeDevice, verify, ended } = harness();
    const { sessionId, csrfToken } = issue();
    expect(sessions.describe(sessionId)).toBeDefined();
    revokeDevice();
    expect(sessions.describe(sessionId)).toBeUndefined();
    expect(refusal(() => verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaaa"))).toBe("invalid");
    expect(sessions.size()).toBe(0);
    expect(ended.map((session) => session.reason)).toEqual(["device-revoked"]);
  });

  it.each([
    ["credential-expired", "device-credential-expired"],
    ["credential-rotated", "device-credential-rotated"],
    ["revoked", "device-revoked"],
  ] as const)("sweeps a session whose device is %s as %s", (standing, reason) => {
    const { issue, sessions, revokeDevice, ended } = harness();
    issue();
    revokeDevice(standing);
    sessions.sweepExpired();
    expect(sessions.size()).toBe(0);
    expect(ended.map((session) => session.reason)).toEqual([reason]);
  });

  it("lets a device decide one grant request at a time", () => {
    const { sessions } = harness();
    const first = sessions.beginGrantRequest(deviceId);
    expect(first).toBeDefined();
    expect(sessions.beginGrantRequest(deviceId)).toBeUndefined();
    expect(sessions.beginGrantRequest("33333333-3333-4333-8333-333333333333")).toBeDefined();
    first?.();
    expect(sessions.beginGrantRequest(deviceId)).toBeDefined();
  });

  it("forgets nonces past the retention window, oldest first", () => {
    const { issue, verify, advance } = harness({ noncesPerSession: 2 });
    const { sessionId, csrfToken } = issue();
    verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaa1");
    verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaa2");
    advance(60_001);
    expect(verify(sessionId, csrfToken, "nonce_aaaaaaaaaaaaaaa3").freshness).toBe("current");
  });

  it("ends an idle session, and says so, when the sweep finds it", () => {
    const { issue, sessions, ended, advance } = harness();
    const { sessionId } = issue();
    advance(15 * 60 * 1_000);
    sessions.sweepExpired();
    expect(sessions.describe(sessionId)).toBeUndefined();
    expect(ended).toEqual([expect.objectContaining({ deviceId, reason: "proxy-session-ended" })]);
  });

  it("keeps a session with an open WebSocket from idling out, until its absolute expiry", () => {
    let socketsOpen = true;
    const { issue, sessions, ended, advance } = harness({ holdsOpenSockets: () => socketsOpen });
    const { sessionId } = issue();
    for (let minute = 0; minute < 60; minute += 1) {
      advance(60_000);
      sessions.sweepExpired();
    }
    expect(sessions.describe(sessionId)).toBeDefined();
    advance(12 * 60 * 60 * 1_000);
    sessions.sweepExpired();
    expect(sessions.describe(sessionId)).toBeUndefined();
    expect(ended).toEqual([expect.objectContaining({ reason: "proxy-session-ended" })]);

    // Once its sockets close, a session idles out as before.
    const second = issue();
    socketsOpen = false;
    advance(15 * 60 * 1_000);
    sessions.sweepExpired();
    expect(sessions.describe(second.sessionId)).toBeUndefined();
  });

  it("ends a device's oldest session when it mints a fifth", () => {
    const { issue, sessions, ended } = harness();
    const oldest = issue();
    for (let count = 0; count < 4; count += 1) issue();
    expect(sessions.size()).toBe(4);
    expect(sessions.describe(oldest.sessionId)).toBeUndefined();
    expect(ended).toHaveLength(1);
  });

  it("lets a device at its cap replace its oldest session while the host is full", () => {
    const { issue, sessions } = harness({ sessionsPerHost: 4 });
    for (let count = 0; count < 4; count += 1) issue();
    expect(issue().sessionId).toBeDefined();
    expect(sessions.size()).toBe(4);
    expect(refusal(() => issue("33333333-3333-4333-8333-333333333333"))).toBe("capacity");
  });

  it("ends every session a device holds, with the reason it is given", () => {
    const { issue, sessions, ended } = harness();
    issue();
    issue();
    issue("33333333-3333-4333-8333-333333333333");
    sessions.endDevice(deviceId, "device-revoked");
    expect(sessions.size()).toBe(1);
    expect(ended.map((session) => session.reason)).toEqual(["device-revoked", "device-revoked"]);
  });

  it("holds a device's proxy slots apart from the host's", () => {
    const { sessions } = harness();
    const held = Array.from({ length: 32 }, () => sessions.acquire(deviceId));
    expect(held.every((release) => release !== undefined)).toBe(true);
    expect(sessions.acquire(deviceId)).toBeUndefined();
    expect(sessions.acquire("33333333-3333-4333-8333-333333333333")).toBeDefined();
    held[0]?.();
    expect(sessions.acquire(deviceId)).toBeDefined();
  });

  it.each([
    ["signed-out", "device-signed-out"],
    ["credential-rotated", "device-credential-rotated"],
    ["credentials-rotated-all", "device-credential-rotated"],
    ["credential-expired", "device-credential-expired"],
    ["listener-disabled", "listener-disabled"],
    ["local-device-revoked", "device-revoked"],
    ["self-revoked", "device-revoked"],
    ["host-key-recovered", "device-revoked"],
  ] as const)("ends a session as %s → %s", (code, reason) => {
    expect(proxySessionEndReasonForCredentialChange(code)).toBe(reason);
  });
});
