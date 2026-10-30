import { Schema } from "effect";
import { AuditActingPrincipal } from "./auditEvents";
import { HubGrantItem, HubMemberId, RosterMember, SignedHubRoster } from "./hubAndSpokes";
import { HubPushReason } from "./hubPush";
import { RemotePushPlatform } from "./remotePushNotifications";
import { HubOfferId, HubOfferKind, HubProvisionMode, HubProvisionReason } from "./hubProvision";
import { HUB_WAKE_MAX_SPOKES, HubWakeSpokeTimes } from "./hubWake";
import { ProviderExecutionPolicy } from "./providers";

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
  "standby-order-changed",
  "stand-in-started",
  "stand-in-ended",
  "stand-in-merged",
  "stand-in-refused",
  "hub-promoted",
  "new-hub-accepted",
  "wake-switch-changed",
  "wake-times-reported",
  "wake-times-merged",
  "wake-times-dropped",
  "wake-nudge-sent",
  "wake-nudge-refused",
  "wake-unreachable",
  "push-switch-changed",
  "push-forwarded",
  "push-refused",
  "direct-push-switch-changed",
  "direct-push-environment-changed",
  "direct-push-credential-changed",
  "provision-switch-changed",
  "provision-offered",
  "provision-withdrawn",
  "provision-offer-refused",
  "provision-proposed",
  "provision-applied",
  "provision-dismissed",
  "provision-refused",
  "owner-session-opened",
  "owner-posture-changed",
  "credential-ticket-issued",
  "credential-copy-sent",
  "credential-copy-received",
  "credential-copy-refused",
);
export type HubMembershipChange = typeof HubMembershipChange.Type;

/**
 * Why a wake nudge came to nothing. The journal keeps this word and never a
 * routine's id, name, Project, or schedule.
 */
export const HubWakeReason = Schema.Literal(
  "unknown-routine",
  "too-early",
  "time-mismatch",
  "wake-not-granted",
  "standby-not-granted",
  "hub-reachable",
  "answer-refused",
);
export type HubWakeReason = typeof HubWakeReason.Type;

/**
 * Why a spoke took a promoted standby as its hub without a person. The journal
 * keeps this word beside the change.
 */
export const HubFollowReason = Schema.Literal("standby-granted-hub-silent");
export type HubFollowReason = typeof HubFollowReason.Type;

/**
 * What the journal keeps of a membership change: who petitioned, what changed,
 * and which member and roster sequence it concerned. Keys, pins, and codes
 * stay out.
 */
export const HubMembershipChangedPayload = Schema.Struct({
  change: HubMembershipChange,
  actingPrincipal: AuditActingPrincipal,
  memberId: Schema.optional(HubMemberId),
  /** The members a change names together, such as the standby order in its order. */
  memberIds: Schema.optional(Schema.Array(HubMemberId).pipe(Schema.maxItems(256))),
  sequence: Schema.optional(Schema.Int.pipe(Schema.positive())),
  items: Schema.optional(Schema.Array(HubGrantItem)),
  /** For a wake change: how many routine times a report or a merge carried. */
  wakeCount: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  /** For a wake change: why a nudge came to nothing. */
  wakeReason: Schema.optional(HubWakeReason),
  /** For a new hub accepted without a person: why. */
  followReason: Schema.optional(HubFollowReason),
  /** For a push forward or refusal: the size of the delivery request in bytes, never its content. */
  pushBytes: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  /** For a push refusal: why. */
  pushReason: Schema.optional(HubPushReason),
  /** For a direct-sending credential change: which phone platform it concerned, never the credential. */
  pushPlatform: Schema.optional(RemotePushPlatform),
  /** For a provisioning change: the offer, its kind, whether a person or the standing choice applied it, and why one came to nothing. */
  offerId: Schema.optional(HubOfferId),
  provisionKind: Schema.optional(HubOfferKind),
  provisionMode: Schema.optional(HubProvisionMode),
  provisionReason: Schema.optional(HubProvisionReason),
  /**
   * For an owner posture change: the posture the owner device set. For a
   * sign-in copy: the name of the sign-in, never its value, and why one was
   * refused.
   */
  posture: Schema.optional(ProviderExecutionPolicy),
  credentialName: Schema.optional(bounded(128)),
  credentialReason: Schema.optional(bounded(64)),
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
  /**
   * Present when a standby that is standing in answered instead of the hub. Then
   * `hub` is the hub the standby holds, `roster` is the standby-signed update,
   * and the hub-signed roster that names the standby travels beside it with the
   * hub's origin, so the new member can reach the hub when it returns.
   */
  standIn: Schema.optional(
    Schema.Struct({ hubOrigin: bounded(300), hubRoster: SignedHubRoster }).annotations(strict),
  ),
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

const uniqueIds = <A>(items: ReadonlyArray<A>) => new Set(items.map(String)).size === items.length;

/** The standby hubs the person names on the hub, in the order members try them. Empty clears them. */
export const HubStandbyOrderRequest = Schema.Struct({
  memberIds: Schema.Array(HubMemberId).pipe(
    Schema.maxItems(16),
    Schema.filter(uniqueIds, { message: () => "Entries must not repeat." }),
  ),
}).annotations(strict);
export type HubStandbyOrderRequest = typeof HubStandbyOrderRequest.Type;
export const decodeHubStandbyOrderRequest = Schema.decodeUnknownSync(HubStandbyOrderRequest);

/** The person's confirmation, in the standby's own window, that it becomes the hub for good. */
export const HubPromoteRequest = Schema.Struct({ confirmed: Schema.Literal(true) }).annotations(
  strict,
);
export type HubPromoteRequest = typeof HubPromoteRequest.Type;
export const decodeHubPromoteRequest = Schema.decodeUnknownSync(HubPromoteRequest);

/** A spoke's person accepting the named standby that was promoted to hub. */
export const HubAcceptNewHubRequest = Schema.Struct({ hubMemberId: HubMemberId }).annotations(
  strict,
);
export type HubAcceptNewHubRequest = typeof HubAcceptNewHubRequest.Type;
export const decodeHubAcceptNewHubRequest = Schema.decodeUnknownSync(HubAcceptNewHubRequest);

/** A member of the roster named by id: removing one while a standby stands in. */
export const HubMemberReference = Schema.Struct({ memberId: HubMemberId }).annotations(strict);
export type HubMemberReference = typeof HubMemberReference.Type;
export const decodeHubMemberReference = Schema.decodeUnknownSync(HubMemberReference);

/**
 * What a member learns when it asks the hub, or a standby that is standing in,
 * whether it is there. The hub answers with its latest roster; a standby that
 * is standing in says so and signs with its own identity key, which it presents.
 */
export const HubHeartbeatResponse = Schema.Struct({
  standingIn: Schema.Boolean,
  roster: SignedHubRoster,
  /** The answering hub's identity facts, so a spoke that accepts a promoted hub can pin it. */
  hub: Schema.optional(HubIdentityFacts),
  /** The identity key of a standby that signed `roster`; a member checks its fingerprint against the roster. */
  signerPublicKey: Schema.optional(base64Url(512)),
  /**
   * Changes whenever the hub clears the wake times it holds (its wake switch
   * turned off or on), so a spoke that remembers what it sent knows to send it
   * again. Absent from a standby.
   */
  wakeGeneration: Schema.optional(Schema.Int),
}).annotations(strict);
export type HubHeartbeatResponse = typeof HubHeartbeatResponse.Type;
export const decodeHubHeartbeatResponse = Schema.decodeUnknownSync(HubHeartbeatResponse);

/** A member a standby added while standing in, with what the hub needs to hold it. */
export const StandInAddedMember = Schema.Struct({
  member: RosterMember,
  identityPublicKey: base64Url(512),
  listenerOrigin: bounded(300),
}).annotations(strict);
export type StandInAddedMember = typeof StandInAddedMember.Type;

/**
 * One spoke's times as a standby gathered them. `reportedAt` is when the spoke
 * reported to the standby; the hub keeps whichever report is newer, and counts
 * one without a time as older.
 */
export const HubHandbackWakeTimes = Schema.Struct({
  ...HubWakeSpokeTimes.fields,
  reportedAt: Schema.optional(Schema.Int),
}).annotations(strict);
export type HubHandbackWakeTimes = typeof HubHandbackWakeTimes.Type;

/**
 * What a standby hands back to the hub when it steps down. `wakeTimes` are the
 * routine times spokes reported to it while it stood in; the hub takes them
 * for the spokes it still lists.
 */
export const HubStandInHandback = Schema.Struct({
  baseSequence: Schema.Int.pipe(Schema.positive()),
  sequence: Schema.Int.pipe(Schema.positive()),
  added: Schema.Array(StandInAddedMember).pipe(Schema.maxItems(64)),
  removed: Schema.Array(HubMemberId).pipe(Schema.maxItems(256)),
  wakeTimes: Schema.Array(HubHandbackWakeTimes).pipe(Schema.maxItems(HUB_WAKE_MAX_SPOKES)),
}).annotations(strict);
export type HubStandInHandback = typeof HubStandInHandback.Type;
export const decodeHubStandInHandback = Schema.decodeUnknownSync(HubStandInHandback);

export const HubStandInHandbackResponse = Schema.Struct({ roster: SignedHubRoster }).annotations(
  strict,
);
export type HubStandInHandbackResponse = typeof HubStandInHandbackResponse.Type;
export const decodeHubStandInHandbackResponse = Schema.decodeUnknownSync(
  HubStandInHandbackResponse,
);
