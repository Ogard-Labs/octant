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
  member: RosterMember.pipe(Schema.omit("role", "owner")).annotations(strict),
  identityPublicKey: base64Url(512),
  listenerOrigin: bounded(300),
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
