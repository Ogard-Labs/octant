import { describe, expect, it } from "vitest";
import { decodeAuditActingPrincipal } from "./auditEvents";
import { decodeNewMemberConfirmation } from "./hubAndSpokes";
import { decodeHubJoinRequest } from "./hubMembership";
import {
  decodeCredentialTransfer,
  decodeOwnerAdditionRequest,
  decodeOwnerAdministrationSession,
  decodeOwnerChallengeRequest,
  decodeOwnerCredentialCopyRequest,
  decodeOwnerCredentialReceiveRequest,
  decodeOwnerPostureChangeRequest,
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

  it("requires at least one owner to add and refuses a key sent by hand", () => {
    const candidate = {
      memberId: uuid,
      identityKeyFingerprint: digest,
      unlockKeyFingerprint: digest,
    };

    expect(decodeOwnerAdditionRequest({ owners: [candidate] }).owners).toHaveLength(1);
    expect(() => decodeOwnerAdditionRequest({ owners: [] })).toThrow();
    expect(() =>
      decodeOwnerAdditionRequest({ owners: [{ ...candidate, unlockPublicKey: "a_b-c" }] }),
    ).toThrow();
  });

  it("decodes a confirmation signed as raw text or as a passkey assertion, and refuses a mix", () => {
    const fields = {
      spokeId: uuid,
      memberId: uuid,
      identityKeyFingerprint: digest,
      confirmedBy: uuid,
      unlockKeyFingerprint: digest,
      confirmedAt: "2026-10-29T10:00:00.000Z",
      signature: "c2ln",
    };

    expect(decodeNewMemberConfirmation(fields).signature).toBe("c2ln");
    expect(
      decodeNewMemberConfirmation({ ...fields, authenticatorData: "YQ", clientDataJson: "YQ" })
        .signature,
    ).toBe("c2ln");
    expect(() => decodeNewMemberConfirmation({ ...fields, authenticatorData: "YQ" })).toThrow();
  });

  it("refuses a join request that claims to carry an unlock key on its roster entry", () => {
    const member = {
      memberId: uuid,
      name: "Phone",
      identityKeyFingerprint: digest,
      listenerPin: digest,
      privateNames: [],
      addresses: [],
      ownerUnlockPublicKey: "d_e-f",
    };

    expect(() =>
      decodeHubJoinRequest({
        ticketId: uuid,
        ticketProof: "proof",
        member,
        identityPublicKey: "a_b-c",
      }),
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

describe("owner administration session, posture, and sign-in copy contracts", () => {
  it("decodes a session and refuses a field it does not know", () => {
    expect(decodeOwnerAdministrationSession({ sessionId: "c2Vzc2lvbg", expiresAt: 5 })).toEqual({
      sessionId: "c2Vzc2lvbg",
      expiresAt: 5,
    });
    expect(() =>
      decodeOwnerAdministrationSession({ sessionId: "c2Vzc2lvbg", expiresAt: 5, owner: uuid }),
    ).toThrow();
  });

  it("names a posture for a Code Project or a Code thread and refuses any other subject", () => {
    const change = { posture: "plan", persistence: "current-session" };

    expect(
      decodeOwnerPostureChangeRequest({ ...change, subject: { kind: "project", projectId: uuid } })
        .subject.kind,
    ).toBe("project");
    expect(
      decodeOwnerPostureChangeRequest({
        ...change,
        subject: { kind: "code-thread", threadId: uuid },
      }).subject.kind,
    ).toBe("code-thread");
    expect(() =>
      decodeOwnerPostureChangeRequest({
        ...change,
        subject: { kind: "work-thread", threadId: uuid },
      }),
    ).toThrow();
    expect(() =>
      decodeOwnerPostureChangeRequest({
        ...change,
        posture: "root",
        subject: { kind: "project", projectId: uuid },
      }),
    ).toThrow();
  });

  it("carries a sign-in by name and a ticket, and the transfer holds the value only for the receiving host", () => {
    expect(
      decodeOwnerCredentialCopyRequest({
        targetMemberId: uuid,
        credentialName: "provider-1",
        ticketId: uuid,
      }).credentialName,
    ).toBe("provider-1");
    expect(() =>
      decodeOwnerCredentialCopyRequest({
        targetMemberId: uuid,
        credentialName: "provider-1",
        ticketId: uuid,
        value: "sk-secret",
      }),
    ).toThrow();
    expect(() =>
      decodeOwnerCredentialReceiveRequest({ sourceMemberId: uuid, credentialName: "has space" }),
    ).toThrow();
    expect(
      decodeCredentialTransfer({ ticketId: uuid, credentialName: "provider-1", value: "sk-secret" })
        .value,
    ).toBe("sk-secret");
  });
});
