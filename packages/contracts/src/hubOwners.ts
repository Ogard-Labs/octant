import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HubMemberId, HubMemberRole } from "./hubAndSpokes";

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
