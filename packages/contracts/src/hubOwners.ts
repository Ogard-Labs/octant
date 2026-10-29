import { Schema } from "effect";
import { CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";
import { HubMemberId, HubMemberRole } from "./hubAndSpokes";
import { ProjectId } from "./projects";
import { PermissionPersistence, ProviderExecutionPolicy } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const base64Url = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maxLength),
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
  );

/** Request headers an owner device adds to a signed member request. */
export const OWNER_UNLOCK_HEADER = "x-octant-owner-unlock";
export const OWNER_IDENTITY_KEY_HEADER = "x-octant-owner-identity-key";

/**
 * What an owner device's unlock key signs for one action: a raw ES256
 * signature over the host's unlock text, or a WebAuthn assertion whose
 * challenge is the SHA-256 of that text (base64url). Either way the host
 * issued the challenge for exactly this method, path, and body.
 */
export const OwnerUnlockProof = Schema.Union(
  Schema.Struct({
    shape: Schema.Literal("raw"),
    challengeId: Schema.UUID,
    signature: base64Url(512),
  }).annotations(strict),
  Schema.Struct({
    shape: Schema.Literal("webauthn"),
    challengeId: Schema.UUID,
    authenticatorData: base64Url(1_024),
    clientDataJson: base64Url(2_048),
    signature: base64Url(512),
  }).annotations(strict),
);
export type OwnerUnlockProof = typeof OwnerUnlockProof.Type;
export const decodeOwnerUnlockProof = Schema.decodeUnknownSync(OwnerUnlockProof);

export const OwnerActionMethod = Schema.Literal("POST", "PUT");

/** An owner device asks the host for a challenge bound to the one action it is about to take. */
export const OwnerChallengeRequest = Schema.Struct({
  method: OwnerActionMethod,
  path: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  bodyHash: digest,
}).annotations(strict);
export type OwnerChallengeRequest = typeof OwnerChallengeRequest.Type;
export const decodeOwnerChallengeRequest = Schema.decodeUnknownSync(OwnerChallengeRequest);

export const OwnerChallenge = Schema.Struct({
  challengeId: Schema.UUID,
  nonce: base64Url(64),
  expiresAt: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type OwnerChallenge = typeof OwnerChallenge.Type;
export const decodeOwnerChallenge = Schema.decodeUnknownSync(OwnerChallenge);

/**
 * One device to add to a host's owner list. The person confirmed its name and
 * both fingerprints; the host copies the unlock key from the roster entry it
 * holds, after checking both fingerprints against it. A key sent by hand is not
 * accepted.
 */
export const OwnerCandidate = Schema.Struct({
  memberId: HubMemberId,
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
}).annotations(strict);
export type OwnerCandidate = typeof OwnerCandidate.Type;

export const OwnerAdditionRequest = Schema.Struct({
  owners: Schema.Array(OwnerCandidate).pipe(Schema.minItems(1), Schema.maxItems(16)),
}).annotations(strict);
export type OwnerAdditionRequest = typeof OwnerAdditionRequest.Type;
export const decodeOwnerAdditionRequest = Schema.decodeUnknownSync(OwnerAdditionRequest);

export const OwnerRemovalRequest = Schema.Struct({ memberId: HubMemberId }).annotations(strict);
export type OwnerRemovalRequest = typeof OwnerRemovalRequest.Type;
export const decodeOwnerRemovalRequest = Schema.decodeUnknownSync(OwnerRemovalRequest);

/** An owner as a window or another owner device sees it: names and fingerprints, never keys. */
export const OwnerListEntry = Schema.Struct({
  memberId: HubMemberId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
}).annotations(strict);
export type OwnerListEntry = typeof OwnerListEntry.Type;

export const ConfirmNewMembersRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(
  strict,
);
export type ConfirmNewMembersRequest = typeof ConfirmNewMembersRequest.Type;
export const decodeConfirmNewMembersRequest = Schema.decodeUnknownSync(ConfirmNewMembersRequest);

export const HubRoleRequest = Schema.Struct({ enabled: Schema.Boolean }).annotations(strict);
export type HubRoleRequest = typeof HubRoleRequest.Type;
export const decodeHubRoleRequest = Schema.decodeUnknownSync(HubRoleRequest);

export const OwnerJoinCodeRequest = Schema.Struct({ owner: Schema.Boolean }).annotations(strict);
export const decodeOwnerJoinCodeRequest = Schema.decodeUnknownSync(OwnerJoinCodeRequest);

export const OwnerMemberRequest = Schema.Struct({ memberId: HubMemberId }).annotations(strict);
export const decodeOwnerMemberRequest = Schema.decodeUnknownSync(OwnerMemberRequest);

export const NewMemberAlertId = Schema.UUID.pipe(Schema.brand("NewMemberAlertId"));
export type NewMemberAlertId = typeof NewMemberAlertId.Type;

/** A spoke's record that a newer roster added a member; the hub cannot hide or write one. */
export const NewMemberAlert = Schema.Struct({
  alertId: NewMemberAlertId,
  memberId: HubMemberId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  role: HubMemberRole,
  identityKeyFingerprint: digest,
  raisedAt: UtcTimestamp,
}).annotations(strict);
export type NewMemberAlert = typeof NewMemberAlert.Type;

/** A member a host holds status-only under Confirm new members until an owner or its window confirms it. */
export const HeldMember = Schema.Struct({
  memberId: HubMemberId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  role: HubMemberRole,
  identityKeyFingerprint: digest,
}).annotations(strict);
export type HeldMember = typeof HeldMember.Type;

export const OwnerAlertRequest = Schema.Struct({ alertId: NewMemberAlertId }).annotations(strict);
export const decodeOwnerAlertRequest = Schema.decodeUnknownSync(OwnerAlertRequest);

/** Carries the id of an open administration session beside the signed request (decision H17). */
export const OWNER_SESSION_HEADER = "x-octant-owner-session";

/**
 * What a host answers to a fresh unlock for the administration scope. The id
 * is a secret the owner device keeps in memory; the host keeps it in memory
 * too and forgets it at `expiresAt`, when the owner list changes, or when the
 * device is removed.
 */
export const OwnerAdministrationSession = Schema.Struct({
  sessionId: base64Url(64),
  expiresAt: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type OwnerAdministrationSession = typeof OwnerAdministrationSession.Type;
export const decodeOwnerAdministrationSession = Schema.decodeUnknownSync(
  OwnerAdministrationSession,
);

/**
 * What a posture belongs to: a Code Project's remembered default, or one Code
 * thread's own posture. Work asks first and has no posture to set.
 */
export const OwnerPostureSubject = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("code-thread"), threadId: CodeThreadId }).annotations(
    strict,
  ),
);
export type OwnerPostureSubject = typeof OwnerPostureSubject.Type;

export const OwnerPostureReadRequest = Schema.Struct({
  subject: OwnerPostureSubject,
}).annotations(strict);
export type OwnerPostureReadRequest = typeof OwnerPostureReadRequest.Type;
export const decodeOwnerPostureReadRequest = Schema.decodeUnknownSync(OwnerPostureReadRequest);

/** A posture as a host reports it. `persistence` is absent where the host has none to report. */
export const OwnerPosture = Schema.Struct({
  subject: OwnerPostureSubject,
  posture: ProviderExecutionPolicy,
  persistence: Schema.optional(PermissionPersistence),
}).annotations(strict);
export type OwnerPosture = typeof OwnerPosture.Type;

export const OwnerPostureChangeRequest = Schema.Struct({
  subject: OwnerPostureSubject,
  posture: ProviderExecutionPolicy,
  persistence: PermissionPersistence,
}).annotations(strict);
export type OwnerPostureChangeRequest = typeof OwnerPostureChangeRequest.Type;
export const decodeOwnerPostureChangeRequest = Schema.decodeUnknownSync(OwnerPostureChangeRequest);

const credentialName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.pattern(/^[A-Za-z0-9._:-]+$/),
);

/**
 * The receiving host's half of a sign-in copy: the owner unlocks on the host
 * that will store the key and names the host that may send it and the sign-in.
 */
export const OwnerCredentialReceiveRequest = Schema.Struct({
  sourceMemberId: HubMemberId,
  credentialName,
}).annotations(strict);
export type OwnerCredentialReceiveRequest = typeof OwnerCredentialReceiveRequest.Type;
export const decodeOwnerCredentialReceiveRequest = Schema.decodeUnknownSync(
  OwnerCredentialReceiveRequest,
);

/** The sending host's half: the owner unlocks on the host that holds the key and names the ticket the receiver issued. */
export const OwnerCredentialCopyRequest = Schema.Struct({
  targetMemberId: HubMemberId,
  credentialName,
  ticketId: Schema.UUID,
}).annotations(strict);
export type OwnerCredentialCopyRequest = typeof OwnerCredentialCopyRequest.Type;
export const decodeOwnerCredentialCopyRequest = Schema.decodeUnknownSync(
  OwnerCredentialCopyRequest,
);

/** What travels from the sending host to the receiving one, over the pinned member link. The value is a secret and is never journaled. */
export const CredentialTransfer = Schema.Struct({
  ticketId: Schema.UUID,
  credentialName,
  value: Schema.NonEmptyString.pipe(Schema.maxLength(8_192)),
}).annotations(strict);
export type CredentialTransfer = typeof CredentialTransfer.Type;
export const decodeCredentialTransfer = Schema.decodeUnknownSync(CredentialTransfer);
