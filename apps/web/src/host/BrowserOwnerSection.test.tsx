import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  base64UrlEncode,
  createOwnerClient,
  type OwnerSpoke,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import { OWNER_UNLOCK_HEADER } from "@octant/contracts";
import { ownerUnlockSigningPayload } from "@octant/domain";
import { BrowserOwnerSection } from "./BrowserOwnerSection";
import {
  browserOwnerOffered,
  passkeyUnlockSigner,
  registerOwnerPasskey,
  type PasskeyCredentials,
} from "./ownerPasskey";

const HOST_ID = "00000000-0000-4000-8000-000000000002";
const OWNER_ID = "00000000-0000-4000-8000-000000000003";
const MEMBER_ID = "00000000-0000-4000-8000-000000000004";
const ALERT_ID = "00000000-0000-4000-8000-000000000005";
const CHALLENGE_ID = "00000000-0000-4000-8000-000000000006";
const bytes = (...values: number[]) => new Uint8Array(values).buffer;

function fakePasskeys(options: { cancel?: boolean } = {}) {
  const creates: CredentialCreationOptions[] = [];
  const gets: CredentialRequestOptions[] = [];
  const credentials: PasskeyCredentials = {
    create: async (request) => {
      creates.push(request);
      if (options.cancel === true) throw new DOMException("declined", "NotAllowedError");
      return {
        rawId: bytes(1, 2, 3),
        response: { getPublicKey: () => bytes(9, 8, 7) },
      } as unknown as Credential;
    },
    get: async (request) => {
      gets.push(request);
      if (options.cancel === true) throw new DOMException("declined", "NotAllowedError");
      return {
        rawId: bytes(1, 2, 3),
        response: {
          authenticatorData: bytes(4, 5),
          clientDataJSON: bytes(6, 7),
          signature: bytes(10, 11),
        },
      } as unknown as Credential;
    },
  };
  return { credentials, creates, gets };
}

describe("a browser owner's passkey", () => {
  it("makes a passkey that requires user verification on a platform authenticator and returns only its public key", async () => {
    const { credentials, creates } = fakePasskeys();

    const registered = await registerOwnerPasskey({
      credentials,
      hostName: "Mac mini",
      ownerMemberId: OWNER_ID,
      ownerName: "Henrik's browser",
    });

    expect(registered).toEqual({
      status: "registered",
      passkey: { credentialId: "AQID", publicKey: "CQgH" },
    });
    const publicKey = creates[0]?.publicKey;
    expect(publicKey?.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "platform",
      userVerification: "required",
    });
    expect(publicKey?.pubKeyCredParams).toEqual([{ type: "public-key", alg: -7 }]);
  });

  it("says the passkey was not made when the person declines or the browser has no authenticator", async () => {
    const { credentials } = fakePasskeys({ cancel: true });
    expect(
      await registerOwnerPasskey({
        credentials,
        hostName: "Mac mini",
        ownerMemberId: OWNER_ID,
        ownerName: "Henrik's browser",
      }),
    ).toEqual({ status: "cancelled" });
  });

  it("asks for that one passkey with user verification and hands back the assertion", async () => {
    const { credentials, gets } = fakePasskeys();
    const signer = passkeyUnlockSigner({
      credentials,
      passkey: { credentialId: "AQID", publicKey: "CQgH" },
    });
    if (signer.shape !== "webauthn") throw new Error("expected a passkey signer");

    const asserted = await signer.assert("CgsM");

    expect(asserted).toEqual({
      status: "signed",
      value: { authenticatorData: "BAU", clientDataJson: "Bgc", signature: "Cgs" },
    });
    const request = gets[0]?.publicKey;
    expect(request?.userVerification).toBe("required");
    expect(request?.allowCredentials).toHaveLength(1);
    expect([...new Uint8Array(request?.challenge as ArrayBuffer)]).toEqual([10, 11, 12]);
  });

  it("treats a declined passkey prompt as a cancelled unlock", async () => {
    const { credentials } = fakePasskeys({ cancel: true });
    const signer = passkeyUnlockSigner({
      credentials,
      passkey: { credentialId: "AQID", publicKey: "CQgH" },
    });
    if (signer.shape !== "webauthn") throw new Error("expected a passkey signer");

    expect(await signer.assert("CgsM")).toEqual({ status: "cancelled" });
  });
});

describe("browser owner availability", () => {
  const { credentials } = fakePasskeys();
  const windowBridge = { hubAdministrationRequest: vi.fn() };

  it("is offered to a browser client that joined as an owner", () => {
    expect(
      browserOwnerOffered({ hubAdministration: undefined, joinedAsOwner: true, credentials }),
    ).toBe(true);
  });

  it("is never offered in a desktop window, which already has the host's authority", () => {
    expect(
      browserOwnerOffered({ hubAdministration: windowBridge, joinedAsOwner: true, credentials }),
    ).toBe(false);
  });

  it("is not offered to a browser that did not join as an owner or has no passkey support", () => {
    expect(
      browserOwnerOffered({ hubAdministration: undefined, joinedAsOwner: false, credentials }),
    ).toBe(false);
    expect(
      browserOwnerOffered({
        hubAdministration: undefined,
        joinedAsOwner: true,
        credentials: undefined,
      }),
    ).toBe(false);
  });
});

/** A host that issues one challenge and records the proof the action carries. */
function browserSpoke(credentials: PasskeyCredentials, options: { held?: boolean } = {}) {
  const proofs: unknown[] = [];
  const paths: string[] = [];
  let challenge: { nonce: string; expiresAt: number; path: string; bodyHash: string } | undefined;
  const transport: PinnedListenerTransportPort = () => ({
    status: "available",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path === "/api/hub/owner/alerts") {
        return Response.json({
          alerts: [
            {
              alertId: ALERT_ID,
              memberId: MEMBER_ID,
              name: "Unknown tablet",
              role: "spoke",
              identityKeyFingerprint: "c".repeat(64),
              raisedAt: "2026-10-29T10:00:00.000Z",
            },
          ],
        });
      }
      if (path === "/api/hub/owner/held-members") {
        return Response.json({
          members:
            options.held === false
              ? []
              : [
                  {
                    memberId: MEMBER_ID,
                    name: "Unknown tablet",
                    role: "spoke",
                    identityKeyFingerprint: "c".repeat(64),
                  },
                ],
        });
      }
      if (path === "/api/hub/owner/challenge") {
        const asked = JSON.parse(String(init?.body)) as { path: string; bodyHash: string };
        challenge = { nonce: "nonce", expiresAt: 1_900_000_000_000, ...asked };
        return Response.json({
          challenge: { challengeId: CHALLENGE_ID, nonce: "nonce", expiresAt: 1_900_000_000_000 },
        });
      }
      const header = new Headers(init?.headers).get(OWNER_UNLOCK_HEADER) ?? "";
      proofs.push(JSON.parse(atob(header.replaceAll("-", "+").replaceAll("_", "/"))));
      return Response.json({ status: "removed", alertId: ALERT_ID });
    }) as typeof globalThis.fetch,
  });
  const client = createOwnerClient({
    target: { memberId: HOST_ID, origin: "https://100.64.0.2:13774", pin: "sha256-AAAA" },
    identity: { memberId: OWNER_ID, publicKey: "AAAA", sign: async () => "AA" },
    unlock: passkeyUnlockSigner({
      credentials,
      passkey: { credentialId: "AQID", publicKey: "CQgH" },
    }),
    transport,
  });
  const spoke: OwnerSpoke = { memberId: HOST_ID, name: "Mac mini", client };
  return { spoke, proofs, paths, challenge: () => challenge };
}

describe("BrowserOwnerSection", () => {
  it("shows nothing in a desktop window", () => {
    const { credentials } = fakePasskeys();
    const { spoke } = browserSpoke(credentials);
    render(
      <BrowserOwnerSection
        credentials={credentials}
        hubAdministration={{ hubAdministrationRequest: vi.fn() }}
        spokes={[spoke]}
      />,
    );
    expect(screen.queryByText("Owner alerts")).toBeNull();
  });

  it("asks for the passkey before removing, with the host's unlock text hashed as the challenge, and sends the assertion", async () => {
    const user = userEvent.setup();
    const { credentials, gets } = fakePasskeys();
    const { spoke, proofs, challenge } = browserSpoke(credentials);
    render(
      <BrowserOwnerSection
        credentials={credentials}
        hubAdministration={undefined}
        spokes={[spoke]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Remove Unknown tablet" }));

    await waitFor(() => expect(proofs).toHaveLength(1));
    expect(gets).toHaveLength(1);
    const asked = challenge();
    const text = ownerUnlockSigningPayload({
      challengeId: CHALLENGE_ID,
      nonce: "nonce",
      hostMemberId: HOST_ID,
      ownerMemberId: OWNER_ID,
      method: "POST",
      path: "/api/hub/owner/alerts/remove",
      bodyHash: asked?.bodyHash ?? "",
      expiresAt: 1_900_000_000_000,
    });
    const expected = base64UrlEncode(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    );
    expect(base64UrlEncode(gets[0]?.publicKey?.challenge as ArrayBuffer)).toBe(expected);
    expect(proofs[0]).toMatchObject({
      shape: "webauthn",
      challengeId: CHALLENGE_ID,
      authenticatorData: "BAU",
    });
  });

  it("changes nothing when the person declines the passkey", async () => {
    const user = userEvent.setup();
    const { credentials } = fakePasskeys({ cancel: true });
    const { spoke, proofs, paths } = browserSpoke(credentials);
    render(
      <BrowserOwnerSection
        credentials={credentials}
        hubAdministration={undefined}
        spokes={[spoke]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Remove Unknown tablet" }));

    expect(await screen.findByText("Nothing changed. The unlock was cancelled.")).toBeVisible();
    expect(proofs).toEqual([]);
    expect(paths).not.toContain("/api/hub/owner/alerts/remove");
  });

  it("confirms a held member with the passkey, once for the confirmation and once for the action", async () => {
    const user = userEvent.setup();
    const { credentials, gets } = fakePasskeys();
    const { spoke, paths, proofs } = browserSpoke(credentials);
    render(
      <BrowserOwnerSection
        credentials={credentials}
        hubAdministration={undefined}
        spokes={[spoke]}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Confirm Unknown tablet" }));

    await waitFor(() => expect(proofs).toHaveLength(1));
    expect(gets).toHaveLength(2);
    expect(paths).toContain("/api/hub/owner/confirm-member");
  });

  it("offers Confirm only for a member the computer holds under Confirm new members", async () => {
    const { credentials } = fakePasskeys();
    const { spoke } = browserSpoke(credentials, { held: false });
    render(
      <BrowserOwnerSection
        credentials={credentials}
        hubAdministration={undefined}
        spokes={[spoke]}
      />,
    );

    expect(await screen.findByRole("button", { name: "Remove Unknown tablet" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Confirm Unknown tablet" })).toBeNull();
  });
});
