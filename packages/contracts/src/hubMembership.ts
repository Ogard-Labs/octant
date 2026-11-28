import { Schema, Struct } from "effect";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { AuditActingPrincipal } from "./auditEvents";
import { HubGrantItem, HubMemberId, RosterMember, SignedHubRoster } from "./hubAndSpokes";
import { HubPushReason } from "./hubPush";
import { ProjectId } from "./projects";
import { RemotePushPlatform } from "./remotePushNotifications";
import { HubOfferId, HubOfferKind, HubProvisionMode, HubProvisionReason } from "./hubProvision";
import { HubSignInKind, HubSignInOutcome, HubSignInReason } from "./hubSignIn";
import { HUB_WAKE_MAX_SPOKES, HubWakeSpokeTimes } from "./hubWake";
import { ProviderExecutionPolicy } from "./providers";
import { WorkAccess } from "./workThreads";

const digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const base64Url = (maxLength: number) =>
  Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maxLength),
    Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  );
const bounded = (maxLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));

/** Every change to who a host's hub or hub-role membership is is journaled as one of these. */
export const HUB_MEMBERSHIP_CHANGED = "hub-and-spokes.membership-changed@1" as const;

export const HubMembershipChange = Schema.Literals([
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
  "accept-moved-threads-changed",
  "hub-act-changed",
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
  "public-entrance-switch-changed",
  "public-funnel-changed",
  "public-standby-serve-changed",
  "public-fronts-changed",
  "public-address-changed",
  "webhook-endpoint-created",
  "webhook-endpoint-removed",
  "webhook-endpoint-secret-set",
  "webhook-endpoints-received",
  "webhook-deliveries-expired",
  "webhook-deliveries-handed-back",
  "webhook-deliveries-dropped",
  "visitor-switch-changed",
  "visitor-link-shared",
  "visitor-link-stopped",
  "visitor-link-bound",
  "visitor-grants-received",
  "visitor-comment-received",
  "visitor-comment-sent",
  "visitor-comment-dismissed",
  "relay-switch-changed",
  "relay-device-changed",
  "relay-devices-received",
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
  "sign-in-asked",
  "sign-in-ask-refused",
  "sign-in-requested",
  "sign-in-refused",
  "sign-in-accepted",
  "sign-in-declined",
  "sign-in-ended",
  "sign-in-outcome-received",
  "owner-session-opened",
  "owner-posture-changed",
  "owner-thread-wake-changed",
  "owner-merge-unlocked",
  "paired-merge-unlock-on",
  "paired-merge-unlock-off",
  "owner-approval-answer-unlock-on",
  "owner-approval-answer-unlock-off",
  "credential-ticket-issued",
  "credential-copy-sent",
  "credential-copy-received",
  "credential-copy-refused",
]);
export type HubMembershipChange = typeof HubMembershipChange.Type;

/**
 * Why a wake nudge came to nothing. The journal keeps this word and never a
 * routine's id, name, Project, or schedule.
 */
export const HubWakeReason = Schema.Literals([
  "unknown-routine",
  "too-early",
  "time-mismatch",
  "wake-not-granted",
  "standby-not-granted",
  "hub-reachable",
  "answer-refused",
]);
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
  memberIds: Schema.optional(Schema.Array(HubMemberId).check(Schema.isMaxLength(256))),
  sequence: Schema.optional(PositiveInt),
  items: Schema.optional(Schema.Array(HubGrantItem)),
  /** For a wake change: how many routine times a report or a merge carried. */
  wakeCount: Schema.optional(NonNegativeInt),
  /** For a wake change: why a nudge came to nothing. */
  wakeReason: Schema.optional(HubWakeReason),
  /** For a new hub accepted without a person: why. */
  followReason: Schema.optional(HubFollowReason),
  /** For a webhook change: how many endpoints or deliveries it concerned, never a payload or a secret. */
  webhookCount: Schema.optional(NonNegativeInt),
  /** For a push forward or refusal: the size of the delivery request in bytes, never its content. */
  pushBytes: Schema.optional(NonNegativeInt),
  /** For a push refusal: why. */
  pushReason: Schema.optional(HubPushReason),
  /** For a direct-sending credential change: which phone platform it concerned, never the credential. */
  pushPlatform: Schema.optional(RemotePushPlatform),
  /** For a provisioning change: the offer, its kind, whether a person or the standing choice applied it, and why one came to nothing. */
  offerId: Schema.optional(HubOfferId),
  provisionKind: Schema.optional(HubOfferKind),
  provisionMode: Schema.optional(HubProvisionMode),
  provisionReason: Schema.optional(HubProvisionReason),
  /** For a hub-started sign-in: the request, the kind of account, the outcome word, and why one was refused. Never a token, code, address, or account name. */
  signInRequestId: Schema.optional(bounded(64)),
  signInKind: Schema.optional(HubSignInKind),
  signInOutcome: Schema.optional(HubSignInOutcome),
  signInReason: Schema.optional(HubSignInReason),
  /**
   * For an owner posture change: the posture the owner device set. For a
   * sign-in copy: the name of the sign-in, never its value, and why one was
   * refused.
   */
  posture: Schema.optional(Schema.Union([ProviderExecutionPolicy, WorkAccess])),
  credentialName: Schema.optional(bounded(128)),
  credentialReason: Schema.optional(bounded(64)),
});
export type HubMembershipChangedPayload = typeof HubMembershipChangedPayload.Type;
export const decodeHubMembershipChangedPayload = Schema.decodeUnknownSync(
  HubMembershipChangedPayload,
  STRICT_DECODE_OPTIONS,
);

/**
 * A joining member's request to the hub, sent after the person approved its
 * pairing on the hub. The ticket proof ties it to that approval; the identity
 * key signs the request, which proves the member holds it.
 */
export const HubJoinRequest = Schema.Struct({
  ticketId: GuidString,
  ticketProof: bounded(256),
  member: RosterMember.mapFields(Struct.omit(["role", "owner", "ownerUnlockPublicKey"])),
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
});
export type HubJoinRequest = typeof HubJoinRequest.Type;
export const decodeHubJoinRequest = Schema.decodeUnknownSync(HubJoinRequest, STRICT_DECODE_OPTIONS);

export const HubIdentityFacts = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  identityPublicKey: base64Url(512),
  identityKeyFingerprint: digest,
  rosterSigningPublicKey: base64Url(512),
  listenerPin: digest,
});
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
  standIn: Schema.optional(Schema.Struct({ hubOrigin: bounded(300), hubRoster: SignedHubRoster })),
});
export type HubJoinResponse = typeof HubJoinResponse.Type;
export const decodeHubJoinResponse = Schema.decodeUnknownSync(
  HubJoinResponse,
  STRICT_DECODE_OPTIONS,
);

export const HubLeaveRequest = Schema.Struct({ memberId: HubMemberId });
export type HubLeaveRequest = typeof HubLeaveRequest.Type;
export const decodeHubLeaveRequest = Schema.decodeUnknownSync(
  HubLeaveRequest,
  STRICT_DECODE_OPTIONS,
);

/** The status read a hub with the Status item may make of a spoke. */
export const HubSpokeStatus = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  serverBuildVersion: bounded(128),
  rosterSequence: PositiveInt,
  /** How busy the spoke is, changed only once a new level has held. Absent from a spoke before load levels. */
  load: Schema.optional(Schema.Literals(["light", "busy", "heavy"])),
  /** False once the spoke's person stopped accepting delegated work. */
  acceptingDelegatedWork: Schema.optional(Schema.Boolean),
});
export type HubSpokeStatus = typeof HubSpokeStatus.Type;

/** What a guest reads from the hub: the current signed roster, nothing beside it. */
export const HubGuestRosterResponse = Schema.Struct({ roster: SignedHubRoster });
export type HubGuestRosterResponse = typeof HubGuestRosterResponse.Type;
export const decodeHubGuestRosterResponse = Schema.decodeUnknownSync(
  HubGuestRosterResponse,
  STRICT_DECODE_OPTIONS,
);

/**
 * A guest asking a spoke to admit it as a paired device. It presents the
 * device key the hub's roster vouches for (by fingerprint); the request is
 * signed with that key, which proves the guest holds it.
 */
export const HubGuestAdmissionRequest = Schema.Struct({
  memberId: HubMemberId,
  devicePublicKey: base64Url(512),
  deviceLabel: bounded(128),
});
export type HubGuestAdmissionRequest = typeof HubGuestAdmissionRequest.Type;
export const decodeHubGuestAdmissionRequest = Schema.decodeUnknownSync(
  HubGuestAdmissionRequest,
  STRICT_DECODE_OPTIONS,
);

export const HubGuestAdmissionResponse = Schema.Struct({
  spokeMemberId: HubMemberId,
  deviceId: GuidString,
});
export type HubGuestAdmissionResponse = typeof HubGuestAdmissionResponse.Type;
export const decodeHubGuestAdmissionResponse = Schema.decodeUnknownSync(
  HubGuestAdmissionResponse,
  STRICT_DECODE_OPTIONS,
);

/**
 * A desktop window asking its own host to have the hub introduce it as a
 * guest: the device key it generated, the member id it chose, and its label.
 * A spoke's host forwards the same three facts to the hub, signed as itself.
 */
export const HubWindowGuestRequest = Schema.Struct({
  memberId: HubMemberId,
  devicePublicKey: base64Url(512),
  deviceLabel: bounded(128),
});
export type HubWindowGuestRequest = typeof HubWindowGuestRequest.Type;
export const decodeHubWindowGuestRequest = Schema.decodeUnknownSync(
  HubWindowGuestRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * A member of the hub as a window on another member reaches it: the address
 * and listener pin the roster this host holds gives, and the identity key
 * fingerprint the member's hello must prove.
 */
export const HubWindowComputer = Schema.Struct({
  memberId: HubMemberId,
  name: bounded(128),
  origin: bounded(300),
  /** The listener's certificate pin, `sha256-` and base64url. */
  pin: Schema.String.check(Schema.isPattern(/^sha256-[A-Za-z0-9_-]{43}$/)),
  identityKeyFingerprint: digest,
  /**
   * `hub` for the hub itself, which holds a member's window to its own Act
   * list; absent for a spoke or standby, which holds it to its Act item.
   */
  role: Schema.optional(Schema.Literal("hub")),
});
export type HubWindowComputer = typeof HubWindowComputer.Type;

/**
 * What a host answers its window's introduction: no hub, or the hub's other
 * members the window may reach directly, and how the introduction went. A
 * member the window cannot reach on a private address is not listed.
 */
export const HubWindowComputers = Schema.Union([
  Schema.Struct({ membership: Schema.Literal("none") }),
  Schema.Struct({
    membership: Schema.Literal("member"),
    introduction: Schema.Literals(["introduced", "unchanged", "refused", "hub-unreachable"]),
    hubMemberId: HubMemberId,
    members: Schema.Array(HubWindowComputer),
  }),
]);
export type HubWindowComputers = typeof HubWindowComputers.Type;
export const decodeHubWindowComputers = Schema.decodeUnknownSync(
  HubWindowComputers,
  STRICT_DECODE_OPTIONS,
);

const uniqueIds = <A>(items: ReadonlyArray<A>) => new Set(items.map(String)).size === items.length;

/**
 * The hub's own Act list: the Projects on the hub a member's desktop window
 * may start threads in, answer, and stop. Set only from a window on the hub;
 * empty names none.
 */
export const HubActProjectsRequest = Schema.Struct({
  actProjects: Schema.Array(ProjectId).check(
    Schema.isMaxLength(1_024),
    Schema.makeFilter(uniqueIds, { message: "Entries must not repeat." }),
  ),
});
export type HubActProjectsRequest = typeof HubActProjectsRequest.Type;
export const decodeHubActProjectsRequest = Schema.decodeUnknownSync(
  HubActProjectsRequest,
  STRICT_DECODE_OPTIONS,
);

/** The standby hubs the person names on the hub, in the order members try them. Empty clears them. */
export const HubStandbyOrderRequest = Schema.Struct({
  memberIds: Schema.Array(HubMemberId).check(
    Schema.isMaxLength(16),
    Schema.makeFilter(uniqueIds, { message: "Entries must not repeat." }),
  ),
});
export type HubStandbyOrderRequest = typeof HubStandbyOrderRequest.Type;
export const decodeHubStandbyOrderRequest = Schema.decodeUnknownSync(
  HubStandbyOrderRequest,
  STRICT_DECODE_OPTIONS,
);

/** The person's confirmation, in the standby's own window, that it becomes the hub for good. */
export const HubPromoteRequest = Schema.Struct({ confirmed: Schema.Literal(true) });
export type HubPromoteRequest = typeof HubPromoteRequest.Type;
export const decodeHubPromoteRequest = Schema.decodeUnknownSync(
  HubPromoteRequest,
  STRICT_DECODE_OPTIONS,
);

/** A spoke's person accepting the named standby that was promoted to hub. */
export const HubAcceptNewHubRequest = Schema.Struct({ hubMemberId: HubMemberId });
export type HubAcceptNewHubRequest = typeof HubAcceptNewHubRequest.Type;
export const decodeHubAcceptNewHubRequest = Schema.decodeUnknownSync(
  HubAcceptNewHubRequest,
  STRICT_DECODE_OPTIONS,
);

/** A member of the roster named by id: removing one while a standby stands in. */
export const HubMemberReference = Schema.Struct({ memberId: HubMemberId });
export type HubMemberReference = typeof HubMemberReference.Type;
export const decodeHubMemberReference = Schema.decodeUnknownSync(
  HubMemberReference,
  STRICT_DECODE_OPTIONS,
);

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
});
export type HubHeartbeatResponse = typeof HubHeartbeatResponse.Type;
export const decodeHubHeartbeatResponse = Schema.decodeUnknownSync(
  HubHeartbeatResponse,
  STRICT_DECODE_OPTIONS,
);

/** A member a standby added while standing in, with what the hub needs to hold it. */
export const StandInAddedMember = Schema.Struct({
  member: RosterMember,
  identityPublicKey: base64Url(512),
  listenerOrigin: bounded(300),
});
export type StandInAddedMember = typeof StandInAddedMember.Type;

/**
 * One spoke's times as a standby gathered them. `reportedAt` is when the spoke
 * reported to the standby; the hub keeps whichever report is newer, and counts
 * one without a time as older.
 */
export const HubHandbackWakeTimes = Schema.Struct({
  ...HubWakeSpokeTimes.fields,
  reportedAt: Schema.optional(Schema.Int),
});
export type HubHandbackWakeTimes = typeof HubHandbackWakeTimes.Type;

/**
 * What a standby hands back to the hub when it steps down. `wakeTimes` are the
 * routine times spokes reported to it while it stood in; the hub takes them
 * for the spokes it still lists.
 */
export const HubStandInHandback = Schema.Struct({
  baseSequence: PositiveInt,
  sequence: PositiveInt,
  added: Schema.Array(StandInAddedMember).check(Schema.isMaxLength(64)),
  removed: Schema.Array(HubMemberId).check(Schema.isMaxLength(256)),
  wakeTimes: Schema.Array(HubHandbackWakeTimes).check(Schema.isMaxLength(HUB_WAKE_MAX_SPOKES)),
});
export type HubStandInHandback = typeof HubStandInHandback.Type;
export const decodeHubStandInHandback = Schema.decodeUnknownSync(
  HubStandInHandback,
  STRICT_DECODE_OPTIONS,
);

export const HubStandInHandbackResponse = Schema.Struct({ roster: SignedHubRoster });
export type HubStandInHandbackResponse = typeof HubStandInHandbackResponse.Type;
export const decodeHubStandInHandbackResponse = Schema.decodeUnknownSync(
  HubStandInHandbackResponse,
  STRICT_DECODE_OPTIONS,
);
