import { Schema } from "effect";
import { AuditActingPrincipal } from "./auditEvents";
import { HubGrantItem, HubMemberId, RosterMember, SignedHubRoster } from "./hubAndSpokes";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const base64Url = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maxLength),
    Schema.pattern(/^[A-Za-z0-9_-]+$/),
  );
const bounded = (maxLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maxLength));

/** Every change to who a host's hub or hub-role membership is is journaled as one of these. */
export const HUB_MEMBERSHIP_CHANGED = "hub-and-spokes.membership-changed@1" as const;

export const HubMembershipChange = Schema.Literal(
  "hub-role-enabled",
  "hub-role-disabled",
  "member-added",
  "member-removed",
  "member-left",
  "joined-hub",
  "left-hub",
  "hub-grant-changed",
  "roster-accepted",
  "guest-admitted",
  "guest-dropped",
  "owner-added",
  "owner-removed",
  "new-member-alerted",
  "new-member-confirmed",
  "new-member-removed",
  "alert-dismissed",
  "confirm-new-members-changed",
  "join-code-minted",
);
export type HubMembershipChange = typeof HubMembershipChange.Type;

/**
 * What the journal keeps of a membership change: who petitioned, what changed,
 * and which member and roster sequence it concerned. Keys, pins, and codes
 * stay out.
 */
export const HubMembershipChangedPayload = Schema.Struct({
  change: HubMembershipChange,
  actingPrincipal: AuditActingPrincipal,
  memberId: Schema.optional(HubMemberId),
  sequence: Schema.optional(Schema.Int.pipe(Schema.positive())),
  items: Schema.optional(Schema.Array(HubGrantItem)),
}).annotations(strict);
export type HubMembershipChangedPayload = typeof HubMembershipChangedPayload.Type;
export const decodeHubMembershipChangedPayload = Schema.decodeUnknownSync(
  HubMembershipChangedPayload,
);

/**
 * A joining member's request to the hub, sent after the person approved its
 * pairing on the hub. The ticket proof ties it to that approval; the identity
 * key signs the request, which proves the member holds it.
 */
export const HubJoinRequest = Schema.Struct({
  ticketId: Schema.UUID,
  ticketProof: bounded(256),
  member: RosterMember.pipe(Schema.omit("role", "owner", "ownerUnlockPublicKey")).annotations(
    strict,
  ),
  identityPublicKey: base64Url(512),
  /** Absent for a guest, which runs no listener. */
  listenerOrigin: Schema.optional(bounded(300)),
  /**
   * The member joins as a guest: its identity key is the device key it paired
   * with, and the hub checks that it is. A guest has no listener and no hub
   * grant to choose.
   */
  asGuest: Schema.optional(Schema.Literal(true)),
  /**
   * The joining member's unlock public key. The hub adds it to its owner list
   * only when the join code was an owner code; any other code ignores it.
   */
  ownerUnlockPublicKey: Schema.optional(base64Url(512)),
}).annotations(strict);
export type HubJoinRequest = typeof HubJoinRequest.Type;
export const decodeHubJoinRequest = Schema.decodeUnknownSync(HubJoinRequest);

export const HubIdentityFacts = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  identityPublicKey: base64Url(512),
  identityKeyFingerprint: digest,
  rosterSigningPublicKey: base64Url(512),
  listenerPin: digest,
}).annotations(strict);
export type HubIdentityFacts = typeof HubIdentityFacts.Type;

export const HubJoinResponse = Schema.Struct({
  hub: HubIdentityFacts,
  roster: SignedHubRoster,
}).annotations(strict);
export type HubJoinResponse = typeof HubJoinResponse.Type;
export const decodeHubJoinResponse = Schema.decodeUnknownSync(HubJoinResponse);

export const HubLeaveRequest = Schema.Struct({ memberId: HubMemberId }).annotations(strict);
export type HubLeaveRequest = typeof HubLeaveRequest.Type;
export const decodeHubLeaveRequest = Schema.decodeUnknownSync(HubLeaveRequest);

/** The status read a hub with the Status item may make of a spoke. */
export const HubSpokeStatus = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  serverBuildVersion: bounded(128),
  rosterSequence: Schema.Int.pipe(Schema.positive()),
}).annotations(strict);
export type HubSpokeStatus = typeof HubSpokeStatus.Type;

/** What a guest reads from the hub: the current signed roster, nothing beside it. */
export const HubGuestRosterResponse = Schema.Struct({ roster: SignedHubRoster }).annotations(
  strict,
);
export type HubGuestRosterResponse = typeof HubGuestRosterResponse.Type;
export const decodeHubGuestRosterResponse = Schema.decodeUnknownSync(HubGuestRosterResponse);

/**
 * A guest asking a spoke to admit it as a paired device. It presents the
 * device key the hub's roster vouches for (by fingerprint); the request is
 * signed with that key, which proves the guest holds it.
 */
export const HubGuestAdmissionRequest = Schema.Struct({
  memberId: HubMemberId,
  devicePublicKey: base64Url(512),
  deviceLabel: bounded(128),
}).annotations(strict);
export type HubGuestAdmissionRequest = typeof HubGuestAdmissionRequest.Type;
export const decodeHubGuestAdmissionRequest = Schema.decodeUnknownSync(HubGuestAdmissionRequest);

export const HubGuestAdmissionResponse = Schema.Struct({
  spokeMemberId: HubMemberId,
  deviceId: Schema.UUID,
}).annotations(strict);
export type HubGuestAdmissionResponse = typeof HubGuestAdmissionResponse.Type;
export const decodeHubGuestAdmissionResponse = Schema.decodeUnknownSync(HubGuestAdmissionResponse);
