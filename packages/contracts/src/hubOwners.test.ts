import { describe, expect, it } from "vitest";
import { decodeAuditActingPrincipal } from "./auditEvents";
import { decodeHubJoinRequest } from "./hubMembership";
import {
  decodeOwnerAdditionRequest,
  decodeOwnerChallengeRequest,
  decodeOwnerUnlockProof,
} from "./hubOwners";

const uuid = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);

describe("owner unlock contracts", () => {
  it("decodes both signed shapes and refuses a proof that mixes them", () => {
    expect(
      decodeOwnerUnlockProof({ shape: "raw", challengeId: uuid, signature: "c2ln" }).shape,
    ).toBe("raw");
    expect(
      decodeOwnerUnlockProof({
        shape: "webauthn",
        challengeId: uuid,
        authenticatorData: "YQ",
        clientDataJson: "YQ",
        signature: "c2ln",
      }).shape,
    ).toBe("webauthn");
    expect(() =>
      decodeOwnerUnlockProof({
        shape: "raw",
        challengeId: uuid,
        signature: "c2ln",
        authenticatorData: "YQ",
      }),
    ).toThrow();
  });

  it("refuses a challenge request for a method other than the two owner actions use, and unknown fields", () => {
    expect(
      decodeOwnerChallengeRequest({
        method: "POST",
        path: "/api/hub/owner/grant",
        bodyHash: digest,
      }).method,
    ).toBe("POST");
    expect(() =>
      decodeOwnerChallengeRequest({ method: "DELETE", path: "/x", bodyHash: digest }),
    ).toThrow();
    expect(() =>
      decodeOwnerChallengeRequest({ method: "POST", path: "/x", bodyHash: digest, extra: 1 }),
    ).toThrow();
  });

  it("requires at least one owner to add and refuses an unlock key that is not base64url", () => {
    const candidate = { memberId: uuid, identityKeyFingerprint: digest, unlockPublicKey: "a_b-c" };

    expect(decodeOwnerAdditionRequest({ owners: [candidate] }).owners).toHaveLength(1);
    expect(() => decodeOwnerAdditionRequest({ owners: [] })).toThrow();
    expect(() =>
      decodeOwnerAdditionRequest({ owners: [{ ...candidate, unlockPublicKey: "not base64+/=" }] }),
    ).toThrow();
  });

  it("carries an unlock public key on a join request and names an owner device in the journal", () => {
    const member = {
      memberId: uuid,
      name: "Phone",
      identityKeyFingerprint: digest,
      listenerPin: digest,
      privateNames: [],
      addresses: [],
    };
    const joined = decodeHubJoinRequest({
      ticketId: uuid,
      ticketProof: "proof",
      member,
      identityPublicKey: "a_b-c",
      ownerUnlockPublicKey: "d_e-f",
    });

    expect(joined.ownerUnlockPublicKey).toBe("d_e-f");
    expect(decodeAuditActingPrincipal({ kind: "owner-unlock", memberId: uuid })).toEqual({
      kind: "owner-unlock",
      memberId: uuid,
    });
  });
});
