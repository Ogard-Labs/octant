import { describe, expect, it } from "vitest";
import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_SESSION_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeNewMemberConfirmation,
  decodeOwnerPostureChangeRequest,
  type HubMemberId,
  type NewMemberAlert,
  type NewMemberAlertId,
} from "@octant/contracts";
import { newMemberConfirmationSigningPayload, ownerUnlockSigningPayload } from "@octant/domain";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import { base64UrlDecode, base64UrlEncode, hex, sha256 } from "./hubLinkSigning";
import {
  copyApiKeySignIn,
  createOwnerClient,
  describeOwnerRefusal,
  type OwnerUnlockSigner,
  type UnlockAttempt,
} from "./hubOwnerClient";

const HOST_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000003";
const MEMBER_ID = "00000000-0000-4000-8000-000000000004";
const ALERT_ID = "00000000-0000-4000-8000-000000000005";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000006";
const encoder = new TextEncoder();

const alert: NewMemberAlert = {
  alertId: ALERT_ID as NewMemberAlertId,
  memberId: MEMBER_ID as HubMemberId,
  name: "Unknown tablet",
  role: "spoke",
  identityKeyFingerprint: "c".repeat(64),
  raisedAt: "2026-10-29T10:00:00.000Z" as NewMemberAlert["raisedAt"],
};

async function p256() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
}

async function rawSigner(keys: CryptoKeyPair, answer?: UnlockAttempt<never>) {
  const publicKey = base64UrlEncode(await crypto.subtle.exportKey("spki", keys.publicKey));
  const calls: string[] = [];
  const sessions = { opened: 0, closed: 0 };
  const signer: OwnerUnlockSigner = {
    shape: "raw",
    publicKey,
    open: async () => {
      sessions.opened += 1;
      if (answer !== undefined) return answer;
      return {
        status: "signed",
        value: {
          sign: async (text) => {
            calls.push(text);
            return base64UrlEncode(
              await crypto.subtle.sign(
                { name: "ECDSA", hash: "SHA-256" },
                keys.privateKey,
                encoder.encode(text),
              ),
            );
          },
          close: () => {
            sessions.closed += 1;
          },
        },
      };
    },
  };
  return { signer, publicKey, calls, sessions };
}

/** A passkey that signs the challenge it is handed, as an authenticator would. */
async function passkeySigner(keys: CryptoKeyPair) {
  const publicKey = base64UrlEncode(await crypto.subtle.exportKey("spki", keys.publicKey));
  const challenges: string[] = [];
  const signer: OwnerUnlockSigner = {
    shape: "webauthn",
    publicKey,
    assert: async (challenge) => {
      challenges.push(challenge);
      return {
        status: "signed",
        value: {
          authenticatorData: "YXV0aA",
          clientDataJson: "Y2xpZW50",
          signature: base64UrlEncode(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              keys.privateKey,
              encoder.encode(challenge),
            ),
          ),
        },
      };
    },
  };
  return { signer, publicKey, challenges };
}

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly body: string;
  readonly headers: Headers;
}

/** A host that issues one challenge at a time and forgets it once an action answers it. */
function fakeHost(options: {
  readonly unlockPublicKey: CryptoKey;
  readonly answers?: Record<string, Response>;
}) {
  const requests: Recorded[] = [];
  const open = new Map<
    string,
    { path: string; bodyHash: string; nonce: string; expiresAt: number }
  >();
  let issued = 0;
  const transport: PinnedListenerTransportPort = () => ({
    status: "available",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? init.body : "";
      requests.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body,
        headers: new Headers(init?.headers),
      });
      const fixed = options.answers?.[url.pathname];
      if (fixed !== undefined) return fixed.clone();
      if (url.pathname === "/api/hub/owner/challenge") {
        const asked = JSON.parse(body) as { path: string; bodyHash: string };
        issued += 1;
        const id = issued === 1 ? CHALLENGE_ID : `00000000-0000-4000-8000-00000000009${issued}`;
        const entry = {
          path: asked.path,
          bodyHash: asked.bodyHash,
          nonce: `nonce${issued}`,
          expiresAt: 1_900_000_000_000,
        };
        open.set(id, entry);
        return Response.json({
          challenge: { challengeId: id, nonce: entry.nonce, expiresAt: entry.expiresAt },
        });
      }
      const header = new Headers(init?.headers).get(OWNER_UNLOCK_HEADER);
      const proof = JSON.parse(new TextDecoder().decode(base64UrlDecode(header ?? ""))) as {
        challengeId: string;
        signature: string;
      };
      const entry = open.get(proof.challengeId);
      open.delete(proof.challengeId);
      if (entry === undefined) {
        return Response.json(
          { status: "refused", kind: "unlock-no-such-challenge" },
          { status: 403 },
        );
      }
      const text = ownerUnlockSigningPayload({
        challengeId: proof.challengeId,
        nonce: entry.nonce,
        hostMemberId: HOST_ID,
        ownerMemberId: OWNER_ID,
        method: "POST",
        path: entry.path,
        bodyHash: entry.bodyHash,
        expiresAt: entry.expiresAt,
      });
      const valid =
        entry.path === url.pathname &&
        entry.bodyHash === hex(await sha256(body)) &&
        (await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          options.unlockPublicKey,
          base64UrlDecode(proof.signature),
          encoder.encode(text),
        ));
      return valid
        ? Response.json({ status: "dismissed", alertId: ALERT_ID })
        : Response.json({ status: "refused", kind: "unlock-signature-invalid" }, { status: 403 });
    }) as typeof globalThis.fetch,
  });
  return { transport, requests };
}

async function ownerFixture(host: ReturnType<typeof fakeHost>, unlock: OwnerUnlockSigner) {
  const identity = await p256();
  return createOwnerClient({
    target: { memberId: HOST_ID, origin: "https://100.64.0.2:13774", pin: "sha256-AAAA" },
    identity: {
      memberId: OWNER_ID,
      publicKey: base64UrlEncode(await crypto.subtle.exportKey("spki", identity.publicKey)),
      sign: async (text) =>
        base64UrlEncode(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            identity.privateKey,
            encoder.encode(text),
          ),
        ),
    },
    unlock,
    transport: host.transport,
    now: () => Date.parse("2026-10-29T10:00:30.000Z"),
  });
}

describe("owner client from a browser", () => {
  it("reaches the host under the platform's certificate check when the target names no pin", async () => {
    const trusts: string[] = [];
    const client = createOwnerClient({
      target: { memberId: HOST_ID, origin: "https://spoke.tail1234.ts.net" },
      identity: { memberId: OWNER_ID, publicKey: "AAAA", sign: async () => "AA" },
      unlock: {
        shape: "webauthn",
        publicKey: "AAAA",
        assert: async () => ({ status: "cancelled" }),
      },
      transport: ({ trust }) => {
        trusts.push(trust.current.kind);
        return { status: "available", fetch: (async () => Response.json({ alerts: [] })) as never };
      },
    });

    expect(await client.alerts()).toEqual({ status: "read", alerts: [] });
    expect(trusts).toEqual(["platform"]);
  });
});

describe("owner client", () => {
  it("asks for a challenge bound to the action, signs it with the unlock key, and sends the action with the proof", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, unlock.signer);

    const result = await client.dismissAlert(ALERT_ID);

    expect(result).toEqual({ status: "done", body: { status: "dismissed", alertId: ALERT_ID } });
    const [challenge, action] = host.requests;
    expect(challenge?.path).toBe("/api/hub/owner/challenge");
    expect(JSON.parse(challenge?.body ?? "")).toEqual({
      method: "POST",
      path: "/api/hub/owner/alerts/dismiss",
      bodyHash: hex(await sha256(JSON.stringify({ alertId: ALERT_ID }))),
    });
    expect(action?.path).toBe("/api/hub/owner/alerts/dismiss");
    expect(action?.headers.get(OWNER_UNLOCK_HEADER)).not.toBeNull();
    expect(action?.headers.get(OWNER_IDENTITY_KEY_HEADER)).not.toBeNull();
    expect(unlock.calls).toHaveLength(1);
  });

  it("asks the person to unlock again for each action instead of reusing one proof", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, unlock.signer);

    await client.dismissAlert(ALERT_ID);
    await client.removeFromAlert(ALERT_ID);

    expect(unlock.calls).toHaveLength(2);
    expect(unlock.sessions).toEqual({ opened: 2, closed: 2 });
    expect(host.requests.filter((request) => request.path.endsWith("/challenge"))).toHaveLength(2);
  });

  it("sends nothing and says the person did not unlock when the unlock is cancelled", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys, { status: "cancelled" });
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, unlock.signer);

    expect(await client.removeFromAlert(ALERT_ID)).toEqual({
      status: "not-unlocked",
      reason: "cancelled",
    });
    expect(host.requests).toEqual([]);
  });

  it("reports a refused replay in plain words", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({
      unlockPublicKey: keys.publicKey,
      answers: {
        "/api/hub/owner/alerts/dismiss": Response.json(
          { status: "refused", kind: "unlock-no-such-challenge" },
          { status: 403 },
        ),
      },
    });
    const client = await ownerFixture(host, unlock.signer);

    const result = await client.dismissAlert(ALERT_ID);

    expect(result).toEqual({ status: "refused", kind: "unlock-no-such-challenge" });
    expect(describeOwnerRefusal("unlock-no-such-challenge")).toBe(
      "That unlock was already used or never issued. Unlock again for this action.",
    );
    expect(describeOwnerRefusal("something-new")).toBe("The computer refused that.");
  });

  it("reads alerts without asking for an unlock", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({
      unlockPublicKey: keys.publicKey,
      answers: { "/api/hub/owner/alerts": Response.json({ alerts: [alert, { nonsense: true }] }) },
    });
    const client = await ownerFixture(host, unlock.signer);

    expect(await client.alerts()).toEqual({ status: "read", alerts: [alert] });
    expect(unlock.calls).toEqual([]);
    expect(host.requests[0]?.method).toBe("GET");
  });

  it("signs the confirmation with the unlock key before asking the unlock for the action", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, unlock.signer);

    await client.confirmNewMember(alert);

    const sent = JSON.parse(host.requests.at(-1)?.body ?? "{}") as Record<string, string>;
    expect(sent).toMatchObject({
      spokeId: HOST_ID,
      memberId: MEMBER_ID,
      confirmedBy: OWNER_ID,
      identityKeyFingerprint: "c".repeat(64),
      unlockKeyFingerprint: hex(await sha256(base64UrlDecode(unlock.publicKey))),
    });
    expect(unlock.calls[0]).toBe(
      newMemberConfirmationSigningPayload(decodeNewMemberConfirmation(sent)),
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        keys.publicKey,
        base64UrlDecode(sent.signature ?? ""),
        encoder.encode(unlock.calls[0]),
      ),
    ).toBe(true);
    expect(unlock.calls).toHaveLength(2);
  });

  it("authenticates the person once to confirm a member, signs both with that one key, and then closes it", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, unlock.signer);

    const result = await client.confirmNewMember(alert);

    expect(result.status).toBe("done");
    expect(unlock.sessions).toEqual({ opened: 1, closed: 1 });
    expect(unlock.calls).toHaveLength(2);
    expect(host.requests.map((request) => request.path)).toEqual([
      "/api/hub/owner/challenge",
      "/api/hub/owner/confirm-member",
    ]);
  });

  it("closes the key even when the host refuses the confirmation", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const host = fakeHost({
      unlockPublicKey: keys.publicKey,
      answers: {
        "/api/hub/owner/confirm-member": Response.json(
          { status: "refused", kind: "confirmation-invalid" },
          { status: 409 },
        ),
      },
    });
    const client = await ownerFixture(host, unlock.signer);

    expect(await client.confirmNewMember(alert)).toEqual({
      status: "refused",
      kind: "confirmation-invalid",
    });
    expect(unlock.sessions).toEqual({ opened: 1, closed: 1 });
  });

  it("confirms a member with a passkey that answers the confirmation text as its challenge", async () => {
    const keys = await p256();
    const passkey = await passkeySigner(keys);
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const client = await ownerFixture(host, passkey.signer);

    await client.confirmNewMember(alert);

    const sent = JSON.parse(host.requests.at(-1)?.body ?? "{}") as Record<string, string>;
    expect(sent).toMatchObject({
      memberId: MEMBER_ID,
      confirmedBy: OWNER_ID,
      authenticatorData: "YXV0aA",
      clientDataJson: "Y2xpZW50",
    });
    const unsigned = decodeNewMemberConfirmation(sent);
    expect(passkey.challenges[0]).toBe(
      base64UrlEncode(await sha256(newMemberConfirmationSigningPayload(unsigned))),
    );
    // The passkey signs one challenge per prompt: the confirmation, then the action.
    expect(passkey.challenges).toHaveLength(2);
  });

  it("lists the members the host holds without asking for an unlock", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const held = {
      memberId: MEMBER_ID,
      name: "Unknown tablet",
      role: "spoke",
      identityKeyFingerprint: "c".repeat(64),
    };
    const host = fakeHost({
      unlockPublicKey: keys.publicKey,
      answers: {
        "/api/hub/owner/held-members": Response.json({ members: [held, { nonsense: true }] }),
      },
    });
    const client = await ownerFixture(host, unlock.signer);

    expect(await client.heldMembers()).toEqual({ status: "read", members: [held] });
    expect(unlock.sessions.opened).toBe(0);
    expect(host.requests[0]?.method).toBe("GET");
  });

  it("hands a passkey the SHA-256 of the unlock text as its challenge", async () => {
    const keys = await p256();
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const challenges: string[] = [];
    const client = await ownerFixture(host, {
      shape: "webauthn",
      publicKey: "AAAA",
      assert: async (challenge) => {
        challenges.push(challenge);
        return { status: "cancelled" };
      },
    });

    await client.dismissAlert(ALERT_ID);

    const expected = base64UrlEncode(
      await sha256(
        ownerUnlockSigningPayload({
          challengeId: CHALLENGE_ID,
          nonce: "nonce1",
          hostMemberId: HOST_ID,
          ownerMemberId: OWNER_ID,
          method: "POST",
          path: "/api/hub/owner/alerts/dismiss",
          bodyHash: hex(await sha256(JSON.stringify({ alertId: ALERT_ID }))),
          expiresAt: 1_900_000_000_000,
        }),
      ),
    );
    expect(challenges).toEqual([expected]);
  });

  it("says the computer could not be reached when the connection fails", async () => {
    const keys = await p256();
    const unlock = await rawSigner(keys);
    const client = createOwnerClient({
      target: { memberId: HOST_ID, origin: "https://100.64.0.2:13774", pin: "sha256-AAAA" },
      identity: { memberId: OWNER_ID, publicKey: "AAAA", sign: async () => "AA" },
      unlock: unlock.signer,
      transport: () => ({
        status: "available",
        fetch: (async () => {
          throw new Error("offline");
        }) as typeof globalThis.fetch,
      }),
    });

    expect(await client.dismissAlert(ALERT_ID)).toEqual({ status: "unreachable" });
  });
});

/** A host that answers every action itself and issues a challenge for each unlock, without checking signatures. */
function scriptedHost(answer: (request: Recorded) => Response | undefined) {
  const requests: Recorded[] = [];
  const transport: PinnedListenerTransportPort = () => ({
    status: "available",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const request: Recorded = {
        path: url.pathname,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
      };
      requests.push(request);
      if (url.pathname === "/api/hub/owner/challenge") {
        return Response.json({
          challenge: {
            challengeId: crypto.randomUUID(),
            nonce: "nonce",
            expiresAt: 1_900_000_000_000,
          },
        });
      }
      return answer(request) ?? Response.json({ status: "done" });
    }) as typeof globalThis.fetch,
  });
  return { transport, requests };
}

function clientFor(transport: PinnedListenerTransportPort, unlock: OwnerUnlockSigner) {
  return createOwnerClient({
    target: { memberId: HOST_ID, origin: "https://100.64.0.2:13774", pin: "sha256-AAAA" },
    identity: { memberId: OWNER_ID, publicKey: "AAAA", sign: async () => "AA" },
    unlock,
    transport,
    now: () => Date.parse("2026-10-29T10:00:30.000Z"),
  });
}

const SESSION_ID = "c2Vzc2lvbi1pZC1zZWNyZXQ";
const SESSION_ENDS = Date.parse("2026-10-29T10:05:00.000Z");
const openedSession = (expiresAt: number) =>
  Response.json({ status: "opened", session: { sessionId: SESSION_ID, expiresAt } });
const postureRequest = (posture: "plan" | "full-access") =>
  decodeOwnerPostureChangeRequest({
    subject: { kind: "code-thread", threadId: "77777777-7777-4777-8777-777777777777" },
    posture,
    persistence: "current-session",
  });

describe("owner client unlock session", () => {
  it("unlocks once for a session and then sends administration changes without asking again", async () => {
    const unlock = await rawSigner(await p256());
    const host = scriptedHost((request) =>
      request.path === "/api/hub/owner/session" ? openedSession(SESSION_ENDS) : undefined,
    );
    const client = clientFor(host.transport, unlock.signer);

    const opened = await client.openSession();
    const dismissed = await client.dismissAlert(ALERT_ID);
    const confirmed = await client.setConfirmNewMembers(true);

    expect(opened).toEqual({ status: "done", body: { expiresAt: SESSION_ENDS } });
    expect(dismissed.status).toBe("done");
    expect(confirmed.status).toBe("done");
    expect(unlock.sessions.opened).toBe(1);
    const actions = host.requests.filter(
      (request) =>
        request.path.endsWith("/dismiss") || request.path.endsWith("/confirm-new-members"),
    );
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      expect(action.headers.get(OWNER_SESSION_HEADER)).toBe(SESSION_ID);
      expect(action.headers.get(OWNER_UNLOCK_HEADER)).toBeNull();
    }
    expect(client.hasSession()).toBe(true);
  });

  it("asks for its own unlock for Full access even while a session is open", async () => {
    const unlock = await rawSigner(await p256());
    const host = scriptedHost((request) =>
      request.path === "/api/hub/owner/session" ? openedSession(SESSION_ENDS) : undefined,
    );
    const client = clientFor(host.transport, unlock.signer);
    await client.openSession();

    await client.changePosture(postureRequest("plan"));
    expect(unlock.sessions.opened).toBe(1);
    await client.changePosture(postureRequest("full-access"));

    expect(unlock.sessions.opened).toBe(2);
    const changes = host.requests.filter(
      (request) => request.path === "/api/hub/owner/posture/change",
    );
    expect(changes[0]?.headers.get(OWNER_SESSION_HEADER)).toBe(SESSION_ID);
    expect(changes[1]?.headers.get(OWNER_SESSION_HEADER)).toBeNull();
    expect(changes[1]?.headers.get(OWNER_UNLOCK_HEADER)).not.toBeNull();
  });

  it("falls back to a fresh unlock when the host ended the session, and forgets it", async () => {
    const unlock = await rawSigner(await p256());
    const host = scriptedHost((request) => {
      if (request.path === "/api/hub/owner/session") return openedSession(SESSION_ENDS);
      if (request.headers.get(OWNER_SESSION_HEADER) !== null) {
        return Response.json({ status: "refused", kind: "session-expired" }, { status: 403 });
      }
      return undefined;
    });
    const client = clientFor(host.transport, unlock.signer);
    await client.openSession();

    const result = await client.dismissAlert(ALERT_ID);

    expect(result.status).toBe("done");
    expect(unlock.sessions.opened).toBe(2);
    expect(client.hasSession()).toBe(false);
  });

  it("does not use a session past its time, and endSession forgets one", async () => {
    const unlock = await rawSigner(await p256());
    const host = scriptedHost((request) =>
      request.path === "/api/hub/owner/session"
        ? openedSession(Date.parse("2026-10-29T10:00:10.000Z"))
        : undefined,
    );
    const client = clientFor(host.transport, unlock.signer);
    await client.openSession();
    expect(client.hasSession()).toBe(false);

    await client.dismissAlert(ALERT_ID);
    expect(unlock.sessions.opened).toBe(2);

    const lasting = scriptedHost((request) =>
      request.path === "/api/hub/owner/session" ? openedSession(SESSION_ENDS) : undefined,
    );
    const another = clientFor(lasting.transport, unlock.signer);
    await another.openSession();
    another.endSession();
    expect(another.hasSession()).toBe(false);
  });
});

describe("copying an API-key sign-in between two hosts", () => {
  const SOURCE = "00000000-0000-4000-8000-0000000000a1";
  const TARGET = "00000000-0000-4000-8000-0000000000b2";
  const TICKET = "66666666-6666-4666-8666-666666666666";

  it("unlocks on the receiving host first, then the sending host, and carries only the ticket", async () => {
    const targetUnlock = await rawSigner(await p256());
    const sourceUnlock = await rawSigner(await p256());
    const order: string[] = [];
    const target = scriptedHost((request) => {
      order.push(`target ${request.path}`);
      return request.path === "/api/hub/owner/credentials/receive"
        ? Response.json({ status: "issued", ticketId: TICKET, expiresAt: 1 })
        : undefined;
    });
    const source = scriptedHost((request) => {
      order.push(`source ${request.path}`);
      return request.path === "/api/hub/owner/credentials/copy"
        ? Response.json({ status: "copied" })
        : undefined;
    });

    const result = await copyApiKeySignIn({
      target: clientFor(target.transport, targetUnlock.signer),
      source: clientFor(source.transport, sourceUnlock.signer),
      sourceMemberId: SOURCE,
      targetMemberId: TARGET,
      credentialName: "provider-1",
    });

    expect(result).toEqual({ status: "done", body: { status: "copied" } });
    expect(order.filter((line) => line.includes("/credentials/"))).toEqual([
      "target /api/hub/owner/credentials/receive",
      "source /api/hub/owner/credentials/copy",
    ]);
    expect(targetUnlock.sessions.opened).toBe(1);
    expect(sourceUnlock.sessions.opened).toBe(1);
    const sent = source.requests.find((request) => request.path.endsWith("/credentials/copy"));
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      targetMemberId: TARGET,
      credentialName: "provider-1",
      ticketId: TICKET,
    });
  });

  it("stops at the receiving host when it refuses, without unlocking on the sending one", async () => {
    const targetUnlock = await rawSigner(await p256());
    const sourceUnlock = await rawSigner(await p256());
    const target = scriptedHost(() =>
      Response.json({ status: "refused", kind: "not-a-spoke-member" }, { status: 409 }),
    );
    const source = scriptedHost(() => undefined);

    const result = await copyApiKeySignIn({
      target: clientFor(target.transport, targetUnlock.signer),
      source: clientFor(source.transport, sourceUnlock.signer),
      sourceMemberId: SOURCE,
      targetMemberId: TARGET,
      credentialName: "provider-1",
    });

    expect(result).toEqual({ status: "refused", kind: "not-a-spoke-member" });
    expect(sourceUnlock.sessions.opened).toBe(0);
  });

  it("explains a subscription sign-in in plain words", () => {
    expect(describeOwnerRefusal("subscription-sign-in")).toBe(
      "Subscription sign-ins stay on the computer that holds them. Only API keys copy.",
    );
  });
});
