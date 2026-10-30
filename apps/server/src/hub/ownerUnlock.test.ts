import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OWNER_UNLOCK_LIFETIME_MS, ownerUnlockSigningPayload } from "@octant/domain";
import { softwareAuthenticator } from "./hubOwner.test-support";
import { OwnerUnlockService } from "./ownerUnlock";

const HOST = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const PATH = "/api/hub/owner/grant";
const BODY = JSON.stringify({ items: ["roster"], actProjects: [] });

function setup() {
  const clock = { now: 1_000_000 };
  const service = new OwnerUnlockService({ now: () => clock.now, hostMemberId: () => HOST });
  const authenticator = softwareAuthenticator();
  const challenge = (body = BODY, path = PATH) => {
    const issued = service.issue({
      ownerMemberId: OWNER,
      request: {
        method: "POST",
        path,
        bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
      },
    });
    if (issued.status !== "issued") throw new Error(issued.kind);
    const payload = ownerUnlockSigningPayload({
      challengeId: issued.challenge.challengeId,
      nonce: issued.challenge.nonce,
      hostMemberId: HOST,
      ownerMemberId: OWNER,
      method: "POST",
      path,
      bodyHash: createHash("sha256").update(body, "utf8").digest("hex"),
      expiresAt: issued.challenge.expiresAt,
    });
    return { id: issued.challenge.challengeId, payload };
  };
  const verify = (
    proof: Parameters<OwnerUnlockService["verify"]>[0]["proof"],
    overrides: { readonly owner?: string; readonly body?: string; readonly key?: string } = {},
  ) =>
    service.verify({
      ownerMemberId: overrides.owner ?? OWNER,
      unlockPublicKey: overrides.key ?? authenticator.publicKey,
      proof,
      request: { method: "POST", path: PATH, body: overrides.body ?? BODY },
    });
  return { clock, authenticator, challenge, verify };
}

describe("an owner's unlock", () => {
  it("accepts a raw signature over the challenge once, and not a second time", () => {
    const { authenticator, challenge, verify } = setup();
    const { id, payload } = challenge();
    const proof = {
      shape: "raw",
      challengeId: id,
      signature: authenticator.sign(payload),
    } as const;

    expect(verify(proof)).toEqual({ status: "fresh" });
    expect(verify(proof)).toEqual({ status: "refused", kind: "no-such-challenge" });
  });

  it("accepts a passkey assertion whose challenge is the hash of the unlock text", () => {
    const { authenticator, challenge, verify } = setup();
    const { id, payload } = challenge();

    expect(
      verify({ shape: "webauthn", challengeId: id, ...authenticator.assert(payload) }),
    ).toEqual({ status: "fresh" });
  });

  it("refuses an assertion for another challenge, without user verification, or from another key", () => {
    const { authenticator, challenge, verify } = setup();
    const first = challenge();
    const second = challenge();
    const unverified = challenge();
    const stranger = challenge();

    expect(
      verify({ shape: "webauthn", challengeId: first.id, ...authenticator.assert(second.payload) }),
    ).toEqual({ status: "refused", kind: "signature-invalid" });
    expect(
      verify({
        shape: "webauthn",
        challengeId: unverified.id,
        ...authenticator.assert(unverified.payload, 0x01),
      }),
    ).toEqual({ status: "refused", kind: "user-verification-missing" });
    expect(
      verify({
        shape: "webauthn",
        challengeId: stranger.id,
        ...softwareAuthenticator().assert(stranger.payload),
      }),
    ).toEqual({ status: "refused", kind: "signature-invalid" });
  });

  it("refuses a signature after the challenge's minute, another owner's use of it, and a changed body", () => {
    const { clock, authenticator, challenge, verify } = setup();
    const late = challenge();
    const borrowed = challenge();
    const edited = challenge();
    const sign = (entry: { id: string; payload: string }) =>
      ({
        shape: "raw",
        challengeId: entry.id,
        signature: authenticator.sign(entry.payload),
      }) as const;

    expect(verify(sign(borrowed), { owner: "33333333-3333-4333-8333-333333333333" })).toEqual({
      status: "refused",
      kind: "wrong-owner",
    });
    expect(verify(sign(edited), { body: "{}" })).toEqual({
      status: "refused",
      kind: "action-mismatch",
    });
    clock.now += OWNER_UNLOCK_LIFETIME_MS + 1;
    expect(verify(sign(late))).toEqual({ status: "refused", kind: "expired" });
  });

  it("stops issuing challenges once too many are waiting, and forgets expired ones", () => {
    const { clock } = setup();
    const service = new OwnerUnlockService({ now: () => clock.now, hostMemberId: () => HOST });
    const request = { method: "POST", path: PATH, bodyHash: "0".repeat(64) } as const;
    for (let index = 0; index < 256; index += 1) {
      expect(service.issue({ ownerMemberId: OWNER, request }).status).toBe("issued");
    }

    expect(service.issue({ ownerMemberId: OWNER, request })).toEqual({
      status: "refused",
      kind: "too-many-challenges",
    });
    clock.now += OWNER_UNLOCK_LIFETIME_MS + 1;
    expect(service.issue({ ownerMemberId: OWNER, request }).status).toBe("issued");
  });
});

describe("the administration session", () => {
  const other = "33333333-3333-4333-8333-333333333333";
  const open = () => {
    const clock = { now: 1_000_000 };
    const service = new OwnerUnlockService({ now: () => clock.now, hostMemberId: () => HOST });
    const session = service.openSession({ ownerMemberId: OWNER, ownerListStamp: "list-1" });
    if (session === undefined) throw new Error("No session.");
    const check = (overrides: { owner?: string; stamp?: string } = {}) =>
      service.checkSession({
        sessionId: session.sessionId,
        ownerMemberId: overrides.owner ?? OWNER,
        ownerListStamp: overrides.stamp ?? "list-1",
      });
    return { clock, service, session, check };
  };

  it("lasts exactly five minutes from the moment it opened", () => {
    const { clock, session, check } = open();

    expect(session.expiresAt).toBe(1_000_000 + 5 * 60_000);
    clock.now += 5 * 60_000;
    expect(check()).toEqual({ status: "open" });
    clock.now += 1;
    expect(check()).toEqual({ status: "refused", kind: "session-expired" });
    expect(check()).toEqual({ status: "refused", kind: "no-such-session" });
  });

  it("belongs to the owner it opened for and to the owner list it opened against", () => {
    const { check } = open();

    expect(check({ owner: other })).toEqual({ status: "refused", kind: "session-wrong-owner" });
    expect(check({ stamp: "list-2" })).toEqual({
      status: "refused",
      kind: "session-owner-changed",
    });
    expect(check()).toEqual({ status: "refused", kind: "no-such-session" });
  });

  it("is replaced when the same owner opens another, and ends when the owner is revoked", () => {
    const { service, session, check } = open();
    const second = service.openSession({ ownerMemberId: OWNER, ownerListStamp: "list-1" });

    expect(second?.sessionId).not.toBe(session.sessionId);
    expect(check()).toEqual({ status: "refused", kind: "no-such-session" });
    service.revokeOwner(OWNER);
    expect(
      service.checkSession({
        sessionId: second?.sessionId ?? "",
        ownerMemberId: OWNER,
        ownerListStamp: "list-1",
      }),
    ).toEqual({ status: "refused", kind: "no-such-session" });
  });
});
