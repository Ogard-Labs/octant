import { describe, expect, it } from "vitest";
import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeNewMemberConfirmation,
  type HubMemberId,
  type NewMemberAlert,
  type NewMemberAlertId,
} from "@octant/contracts";
import { newMemberConfirmationSigningPayload, ownerUnlockSigningPayload } from "@octant/domain";
import type { PinnedListenerTransportPort } from "./appPairingCode";
import { base64UrlDecode, base64UrlEncode, hex, sha256 } from "./hubLinkSigning";
import {
  createOwnerClient,
  describeOwnerRefusal,
  type OwnerUnlockAssertion,
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
  const signer: OwnerUnlockSigner = {
    shape: "raw",
    publicKey,
    sign: async (text) => {
      calls.push(text);
      if (answer !== undefined) return answer;
      return {
        status: "signed",
        value: base64UrlEncode(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keys.privateKey,
            encoder.encode(text),
          ),
        ),
      };
    },
  };
  return { signer, publicKey, calls };
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
    expect(host.requests.map((request) => request.path)).toEqual(["/api/hub/owner/challenge"]);
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

  it("cannot confirm a member with a passkey, which signs a challenge and not text", async () => {
    const keys = await p256();
    const host = fakeHost({ unlockPublicKey: keys.publicKey });
    const assertion: OwnerUnlockAssertion = {
      authenticatorData: "AA",
      clientDataJson: "AA",
      signature: "AA",
    };
    const client = await ownerFixture(host, {
      shape: "webauthn",
      publicKey: "AAAA",
      assert: async () => ({ status: "signed", value: assertion }),
    });

    expect(await client.confirmNewMember(alert)).toEqual({ status: "unsupported" });
    expect(host.requests).toEqual([]);
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
