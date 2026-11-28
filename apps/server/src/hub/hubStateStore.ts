import type { WindowsAuthorityStateFile } from "@octant/host-runtime";
import { nativeAuthorityState } from "./nativeAuthorityState";
// What a host remembers about hub membership: the hub's roster and members
// when it acts as hub, and the hub link, grant, and roster when it is a
// spoke. The journal records every change with its principal; this file holds
// the current state, in the Octant data folder where only the person's account
// reads it, beside the roster signing key. A file that cannot be read back
// exactly is treated as no state, so the host is neither hub nor spoke.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AppUpdateFeed,
  PairedDeviceAlert,
  HardwareAddress,
  HubAutoApplyKind,
  HubDirectPushEnvironment,
  HUB_GRANT_ITEMS,
  HubGrant,
  HubMemberId,
  HubOfferBody,
  HubOfferDeliveryResult,
  HubOfferId,
  HubProvisionReason,
  HubPushResult,
  HubSignInKind,
  HubSignInOutcome,
  HubSignInReason,
  HubSignInRequestId,
  HubWakeResult,
  HubWakeSpokeTimes,
  NewMemberAlert,
  PeerGrant,
  PublicFunnelPort,
  RelayAddress,
  SignedVisitorLinkGrant,
  VisitorThreadMode,
  HubWebhookEndpoint,
  HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE,
  WebhookDeliveryEnvelope,
  WebhookEndpointId,
  WebhookSignatureScheme,
  ProjectId,
  RosterMember,
  SignedHubRoster,
  WakeRoutineId,
} from "@octant/contracts";
import { Schema } from "effect";

const SUBDIR = "hub";
const FILE = "hub-state.json";
const digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
const key = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
  Schema.check(Schema.isMaxLength(512)),
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
);

/** What the hub keeps for a member beyond its roster entry. */
export const HubMemberRecord = Schema.Struct({
  memberId: HubMemberId,
  identityPublicKey: key,
  /**
   * The paired device this hub made for the member. Absent for a member that a
   * standby added while it stood in: it paired with the standby, so this hub
   * holds no device to revoke and the member holds no owner powers here.
   */
  deviceId: Schema.optional(Schema.String.check(Schema.isGUID())),
  /** Absent for a guest, which runs no listener the hub could reach. */
  listenerOrigin: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(300))),
  ),
  /**
   * For a guest that is a desktop window of a member: that member (the hub's
   * own id for a window on the hub). The guest leaves the roster with it, and
   * a member has one such guest at a time.
   */
  introducedBy: Schema.optional(HubMemberId),
  /**
   * The paired device this hub admitted for such a guest when the window
   * asked it directly, which the hub's own Act list bounds. Revoked when the
   * guest leaves the roster, is replaced, or the hub role is turned off.
   */
  windowDeviceId: Schema.optional(Schema.String.check(Schema.isGUID())),
});
export type HubMemberRecord = typeof HubMemberRecord.Type;

/** A join code the hub made and has not yet seen used. */
export const HubJoinTicketRecord = Schema.Struct({
  ticketId: Schema.String.check(Schema.isGUID()),
  owner: Schema.Boolean,
});
export type HubJoinTicketRecord = typeof HubJoinTicketRecord.Type;

/**
 * One entry of a host's own owner list with what the host needs to check the
 * device: its name as the roster showed it when it was added, and the unlock
 * public key. The identity key is not kept; the device presents it with each
 * request and the host compares its fingerprint.
 */
export const HostOwnerRecord = Schema.Struct({
  memberId: HubMemberId,
  name: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(128))),
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
  unlockPublicKey: key,
});
export type HostOwnerRecord = typeof HostOwnerRecord.Type;

/**
 * What a hub or a standing-in standby holds of one spoke's routines: opaque
 * ids and times, the address the person entered on the spoke, and the last
 * result of waking it. Rebuilt from the spoke's reports, so losing it costs
 * only the wakes until the spoke reports again.
 */
export const WakeSpokeRecord = Schema.Struct({
  ...HubWakeSpokeTimes.fields,
  reportedAt: Schema.Int,
  lastResult: Schema.optional(Schema.Struct({ at: Schema.Int, result: HubWakeResult })),
});
export type WakeSpokeRecord = typeof WakeSpokeRecord.Type;

/**
 * When a spoke last withdrew its wake state. It carries no times and no address and
 * never wakes anything; it only stops an older hand-back from bringing them back.
 */
export const WakeWithdrawal = Schema.Struct({
  memberId: HubMemberId,
  withdrawnAt: Schema.Int,
  /** The sequence of the withdrawing report, so an older report arriving later is ignored. */
  sequence: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
});
export type WakeWithdrawal = typeof WakeWithdrawal.Type;

/** The hub's wake service: its own switch, off until the person turns it on, and the times it holds. */
export const HubWakeState = Schema.Struct({
  enabled: Schema.Boolean,
  spokes: Schema.Array(WakeSpokeRecord),
  withdrawals: Schema.optional(Schema.Array(WakeWithdrawal)),
  /** Counts the times the switch changed; spokes learn it from the heartbeat and resend when it moves. */
  generation: Schema.optional(Schema.Int),
  /** The revision of the last copy handed to the standbys; it only rises, so a late older copy can be told apart. */
  copyRevision: Schema.optional(Schema.Int),
});
export type HubWakeState = typeof HubWakeState.Type;

/**
 * What the hub counts of the notifications it forwarded for one spoke: how many
 * went on and how many it refused, and how the last one ended. Counts only; the
 * hub keeps no capability, envelope, or gateway message.
 */
export const PushSpokeRecord = Schema.Struct({
  memberId: HubMemberId,
  forwarded: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  refused: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  lastResult: Schema.optional(Schema.Struct({ at: Schema.Int, result: HubPushResult })),
});
export type PushSpokeRecord = typeof PushSpokeRecord.Type;

/** The hub's push sender: its own switch, off until the person turns it on, and what it counted. */
export const HubPushState = Schema.Struct({
  enabled: Schema.Boolean,
  spokes: Schema.Array(PushSpokeRecord),
});
export type HubPushState = typeof HubPushState.Type;

/**
 * Whether this hub is the push gateway for a phone app its person built, and
 * which Apple push service that build talks to. Off until the person turns it
 * on in a window; the credentials live in the credential store, not here.
 */
export const HubDirectPushState = Schema.Struct({
  enabled: Schema.Boolean,
  environment: HubDirectPushEnvironment,
});
export type HubDirectPushState = typeof HubDirectPushState.Type;

/** How the hub's last attempt to hand one spoke one offer ended. */
export const ProvisionDeliveryRecord = Schema.Struct({
  memberId: HubMemberId,
  at: Schema.Int,
  result: HubOfferDeliveryResult,
  reason: Schema.optional(HubProvisionReason),
});
export type ProvisionDeliveryRecord = typeof ProvisionDeliveryRecord.Type;

/**
 * One offer the hub made, with the signed update feed document it mirrors (plain
 * data the hub serves and never vouches for) and how each spoke took it. What a
 * spoke later does with the proposal is the spoke's own and never told back.
 */
export const ProvisionOfferRecord = Schema.Struct({
  offerId: HubOfferId,
  createdAt: Schema.Int,
  offer: HubOfferBody,
  mirrorFeed: Schema.optional(AppUpdateFeed),
  deliveries: Schema.Array(ProvisionDeliveryRecord),
});
export type ProvisionOfferRecord = typeof ProvisionOfferRecord.Type;

/** The hub's provisioning: its own switch, off until the person turns it on, and the offers it holds. */
export const HubProvisionState = Schema.Struct({
  enabled: Schema.Boolean,
  offers: Schema.Array(ProvisionOfferRecord),
});
export type HubProvisionState = typeof HubProvisionState.Type;

/** An offer a spoke holds as a proposal until its person applies it, dismisses it, or it lapses. */
export const ProvisionProposalRecord = Schema.Struct({
  offerId: HubOfferId,
  offer: HubOfferBody,
  receivedAtMs: Schema.Int,
  expiresAtMs: Schema.Int,
});
export type ProvisionProposalRecord = typeof ProvisionProposalRecord.Type;

/**
 * A spoke's side of provisioning: the proposals it holds, the kinds its person
 * let apply without asking (all off until turned on), and the last mirrored
 * update feed it verified, kept as the document the hub served.
 */
export const SpokeProvisionState = Schema.Struct({
  proposals: Schema.Array(ProvisionProposalRecord),
  autoApply: Schema.Array(HubAutoApplyKind),
  verifiedFeed: Schema.optional(AppUpdateFeed),
});
export type SpokeProvisionState = typeof SpokeProvisionState.Type;

/**
 * One request the hub sent a spoke, and the one word the hub holds about how it
 * ended: still asked, an outcome word the spoke reported, or the reason the
 * spoke refused it. Nothing of the sign-in itself is ever kept here.
 */
export const SignInAskRecord = Schema.Struct({
  memberId: HubMemberId,
  requestId: HubSignInRequestId,
  kind: HubSignInKind,
  askedAtMs: Schema.Int,
  outcome: Schema.optional(HubSignInOutcome),
  refused: Schema.optional(HubSignInReason),
});
export type SignInAskRecord = typeof SignInAskRecord.Type;

export const HubSignInState = Schema.Struct({
  asks: Schema.Array(SignInAskRecord),
});
export type HubSignInState = typeof HubSignInState.Type;

/** A request a spoke holds for its person: asked, then accepted once they say so. */
export const SignInRequestRecord = Schema.Struct({
  requestId: HubSignInRequestId,
  kind: HubSignInKind,
  receivedAtMs: Schema.Int,
  expiresAtMs: Schema.Int,
  state: Schema.Literals(["asked", "accepted"]),
  /** The provider's sign-in command for the account this host uses, fixed when the request arrived. */
  command: Schema.optional(Schema.String),
});
export type SignInRequestRecord = typeof SignInRequestRecord.Type;

/**
 * A spoke's side of hub-started sign-in: the requests it holds, when requests
 * arrived in the last hour (for the limit), and outcome words the hub has not
 * yet been told.
 */
export const SpokeSignInState = Schema.Struct({
  requests: Schema.Array(SignInRequestRecord),
  arrivedAtMs: Schema.Array(Schema.Int),
  unreported: Schema.Array(
    Schema.Struct({ requestId: HubSignInRequestId, outcome: HubSignInOutcome }),
  ),
});
export type SpokeSignInState = typeof SpokeSignInState.Type;

export const HubSideState = Schema.Struct({
  enabled: Schema.Boolean,
  signIn: Schema.optional(HubSignInState),
  wake: Schema.optional(HubWakeState),
  push: Schema.optional(HubPushState),
  directPush: Schema.optional(HubDirectPushState),
  provision: Schema.optional(HubProvisionState),
  roster: Schema.optional(SignedHubRoster),
  members: Schema.Array(HubMemberRecord),
  joinTickets: Schema.Array(HubJoinTicketRecord),
  /** The hub's own owner list. A roster's owner mark never adds to it. */
  owners: Schema.optional(Schema.Array(HostOwnerRecord)),
  /** Accept moved threads, which is on unless a window on the hub turned it off. */
  acceptMovedThreads: Schema.optional(Schema.Literal(false)),
  /**
   * The hub's own Act list: the Projects here a member's desktop window may
   * start threads in, answer, and stop. Set only from a window on the hub;
   * absent or empty names none.
   */
  actProjects: Schema.optional(Schema.Array(ProjectId)),
  /**
   * The members this hub removed, with the roster sequence of each removal. A
   * standby that stood in hands back its changes against a base sequence, and
   * the removals after it are what keep a member out when the other side kept it.
   */
  removals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        memberId: HubMemberId,
        sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
      }),
    ),
  ),
});
export type HubSideState = typeof HubSideState.Type;

/** A member a standby added while standing in, kept until the hub takes it back. */
export const StandInAddedRecord = Schema.Struct({
  member: RosterMember,
  identityPublicKey: key,
  listenerOrigin: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
    Schema.check(Schema.isMaxLength(300)),
  ),
  /** The paired device the standby made for the member. */
  deviceId: Schema.String.check(Schema.isGUID()),
});
export type StandInAddedRecord = typeof StandInAddedRecord.Type;

/**
 * What a standby keeps while it stands in for an unreachable hub: the hub-signed
 * sequence it stood in on, the membership changes it made, and the join codes it
 * made. Members and join codes are never netted, so the hub sees every change.
 */
export const StandInState = Schema.Struct({
  startedAt: Schema.Int,
  baseSequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  added: Schema.Array(StandInAddedRecord),
  removed: Schema.Array(HubMemberId),
  joinTickets: Schema.Array(Schema.String.check(Schema.isGUID())),
  /** Routine times spokes reported to this standby while it stood in; handed back with the changes above. */
  wakeReports: Schema.optional(Schema.Array(WakeSpokeRecord)),
  /**
   * Set while a hand-back to the returned hub is in flight. Membership is
   * frozen then, so every change made is in the hand-back and none can be lost
   * when the stand-in ends.
   */
  handingBack: Schema.optional(Schema.Literal(true)),
});
export type StandInState = typeof StandInState.Type;

/**
 * What a spoke keeps for the wake service: the hardware address its person
 * entered (sent to the hub only when present) and the random id it made for
 * each routine it reports. The ids map back to routines only here.
 */
export const SpokeWakeState = Schema.Struct({
  hardwareAddress: Schema.optional(HardwareAddress),
  /**
   * Set once this spoke has sent the hub its wake state, and cleared only when the
   * hub confirms a withdrawal. A restart before the withdrawal still withdraws.
   */
  shared: Schema.optional(Schema.Literal(true)),
  /** The sequence of the last report this spoke started; the next is above it, and above the clock. */
  reportSequence: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
  routines: Schema.Array(
    Schema.Struct({
      automationId: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(
        Schema.check(Schema.isMaxLength(128)),
      ),
      routineId: WakeRoutineId,
    }),
  ),
});
export type SpokeWakeState = typeof SpokeWakeState.Type;

export const GuestDeviceRecord = Schema.Struct({
  memberId: HubMemberId,
  deviceId: Schema.String.check(Schema.isGUID()),
});
export type GuestDeviceRecord = typeof GuestDeviceRecord.Type;

/** The hub as a spoke knows it, and what that spoke lets it do. */
export const HubLinkState = Schema.Struct({
  selfMemberId: HubMemberId,
  hubMemberId: HubMemberId,
  hubName: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(128))),
  hubOrigin: Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.check(Schema.isMaxLength(300))),
  hubListenerPin: digest,
  hubIdentityPublicKey: key,
  rosterSigningPublicKey: key,
  grant: HubGrant,
  roster: SignedHubRoster,
  /** What this spoke lets other members do to it. A newer roster ends the grants of a member it drops. */
  peerGrants: Schema.Array(PeerGrant),
  /** The paired devices this spoke made for guests it accepted; a dropped guest's device is revoked. */
  guestDevices: Schema.optional(Schema.Array(GuestDeviceRecord)),
  /** Set once a newer roster no longer lists this spoke: the hub principal is revoked. */
  removed: Schema.optional(Schema.Literal(true)),
  /** This spoke's own owner list; it is dropped with the rest of the link when the spoke leaves. */
  owners: Schema.optional(Schema.Array(HostOwnerRecord)),
  /** Hold a new member status-only until a window or an owner's signed unlock confirms it. Off by default. */
  confirmNewMembers: Schema.optional(Schema.Literal(true)),
  /** New members a roster added, which this spoke's windows and owner devices can read and dismiss. */
  alerts: Schema.optional(Schema.Array(NewMemberAlert)),
  /** Members a person removed from an alert here: a later roster still lists them, and this spoke does not accept them again. */
  rejectedMemberIds: Schema.optional(Schema.Array(HubMemberId)),
  /** Set while Leave waits on the hub, so no guest is admitted after the devices to revoke were read. */
  leaving: Schema.optional(Schema.Literal(true)),
  /**
   * The latest hub-signed roster, kept while `roster` is one a standby signed.
   * It is what names the standbys, so a standby-signed roster is judged against it.
   */
  hubSignedRoster: Schema.optional(SignedHubRoster),
  /** Present while this host, a named standby, stands in for a hub it cannot reach. */
  standIn: Schema.optional(StandInState),
  /** The wake times the hub handed this standby, so it can wake spokes while it stands in. */
  wakeCopy: Schema.optional(Schema.Array(WakeSpokeRecord)),
  /** The hub's wake switch as the last copy said it; a standby stands in to wake spokes only while it is on. */
  wakeCopyEnabled: Schema.optional(Schema.Boolean),
  /** The revision of the copy held; an older or equal copy arriving later is refused. */
  wakeCopyRevision: Schema.optional(Schema.Int),
  /** This spoke's side of the wake service. */
  wake: Schema.optional(SpokeWakeState),
  /** Whether the hub's push switch was on when it last told this standby, so a stand-in forwards only then. */
  pushCopy: Schema.optional(Schema.Struct({ enabled: Schema.Boolean })),
  /** This spoke's side of provisioning: proposals, auto-apply choices, the verified mirrored feed. */
  provision: Schema.optional(SpokeProvisionState),
  /** This spoke's side of hub-started sign-in: the requests its person has yet to answer. */
  signIn: Schema.optional(SpokeSignInState),
});
export type HubLinkState = typeof HubLinkState.Type;

/**
 * This host's own public entrance: the switch, the loopback port it keeps so a
 * front's target stays the same, and the Funnel front while it is on. It belongs
 * to the host rather than to the hub role, because a member that is not the
 * acting hub forwards to the one that is.
 */
export const PublicEntranceState = Schema.Struct({
  enabled: Schema.Boolean,
  port: Schema.optional(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 }))),
  ),
  funnel: Schema.optional(Schema.Struct({ port: PublicFunnelPort })),
  /** A standby's own choice to serve the entrance while it stands in for the hub. */
  serveWhileStandingIn: Schema.optional(Schema.Boolean),
  /**
   * The Tailscale addresses of the person's own proxy on another machine.
   * While any is listed, the entrance binds the hub's Tailscale address and
   * serves only them.
   */
  fronts: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(64)))).pipe(
      Schema.check(Schema.isMaxLength(8)),
    ),
  ),
  /** The public address the person's own front answers on, as they typed it on this host. */
  ownFrontOrigin: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(300)))),
});
export type PublicEntranceState = typeof PublicEntranceState.Type;

/** One delivery the hub holds for a spoke that has not taken it yet; never journaled. */
export const HubWebhookQueued = Schema.Struct({
  spokeMemberId: HubMemberId,
  keys: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(320)))).pipe(
    Schema.check(Schema.isMaxLength(2)),
  ),
  bytes: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  envelope: WebhookDeliveryEnvelope,
});
export type HubWebhookQueued = typeof HubWebhookQueued.Type;

/**
 * What the acting hub holds for webhooks: its own sealing key, each spoke's
 * endpoints with secrets sealed to that key, the deliveries waiting for a
 * spoke, and counts. The routine an endpoint starts is never here.
 */
export const HubWebhookHubState = Schema.Struct({
  sealingKey: Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String }),
  endpoints: Schema.Array(HubWebhookEndpoint).pipe(Schema.check(Schema.isMaxLength(4_096))),
  queue: Schema.Array(HubWebhookQueued),
  counts: Schema.Struct({
    forwarded: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    refused: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    expired: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
});

/**
 * How many replaced Stripe secrets one endpoint can hold at once. Each is held
 * up to two days. Every one is a further sealed copy in the endpoint list the
 * spoke hands its hub, and two is the most that keeps a full spoke's longest
 * list inside that route's request limit; a list the hub refuses would leave it
 * checking deliveries against secrets the spoke no longer has.
 */
export const SPOKE_REPLACED_SECRETS_MAX = 2;

/** One of this spoke's endpoints, with the secret it checks deliveries with; only the person sees the secret, once. */
export const SpokeWebhookEndpoint = Schema.Struct({
  endpointId: WebhookEndpointId,
  scheme: WebhookSignatureScheme,
  /** Absent only for a Stripe endpoint whose person has not pasted Stripe's secret yet. */
  secret: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(256))),
  ),
  /**
   * The Stripe secrets newer pastes replaced, oldest first. A new delivery
   * signed with one is taken until its own `until`, a day after the paste
   * that replaced it, and it is held a further hold after that, so a delivery
   * the hub or a standby already answered still runs.
   */
  previousSecrets: Schema.optional(
    Schema.Array(
      Schema.Struct({
        secret: Schema.String.pipe(
          Schema.check(Schema.isMinLength(1)),
          Schema.check(Schema.isMaxLength(256)),
        ),
        until: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      }),
    ).pipe(Schema.check(Schema.isMaxLength(SPOKE_REPLACED_SECRETS_MAX))),
  ),
  label: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
  createdAt: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** The ids this endpoint replaced by rotation, so a routine that names one still reads it. */
  formerIds: Schema.optional(
    Schema.Array(WebhookEndpointId).pipe(Schema.check(Schema.isMaxLength(8))),
  ),
});
export type SpokeWebhookEndpoint = typeof SpokeWebhookEndpoint.Type;

/** A delivery this spoke accepted: what its routine reads, as outside content. */
export const SpokeWebhookDelivery = Schema.Struct({
  endpointId: WebhookEndpointId,
  deliveryId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(256)),
  ),
  receivedAt: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  event: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(256)))),
  data: Schema.String.pipe(Schema.check(Schema.isMaxLength(2_048))),
  /** When a routine's read first showed it; until then it counts against the endpoint's backlog. */
  readAt: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type SpokeWebhookDelivery = typeof SpokeWebhookDelivery.Type;

export const SpokeWebhookLogEntry = Schema.Struct({
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  endpointId: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
  outcome: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
});
export type SpokeWebhookLogEntry = typeof SpokeWebhookLogEntry.Type;

/** This spoke's endpoints, the deliveries it accepted, the keys it claimed (kept seven days), and a short log. */
export const SpokeWebhookState = Schema.Struct({
  endpoints: Schema.Array(SpokeWebhookEndpoint).pipe(
    Schema.check(Schema.isMaxLength(HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE)),
  ),
  deliveries: Schema.Array(SpokeWebhookDelivery).pipe(Schema.check(Schema.isMaxLength(1_024))),
  claimed: Schema.Array(
    Schema.Struct({
      key: Schema.String.pipe(Schema.check(Schema.isMaxLength(320))),
      at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(50_000))),
  log: Schema.Array(SpokeWebhookLogEntry).pipe(Schema.check(Schema.isMaxLength(50))),
  /** The hub has not taken the current endpoint list yet; the next look sends it again. */
  unpublished: Schema.optional(Schema.Literal(true)),
});
export type SpokeWebhookState = typeof SpokeWebhookState.Type;

/** One of this spoke's visitor links: the signed grant the hub holds, the thread only this spoke knows, and the browser bound to it. */
export const SpokeVisitorLink = Schema.Struct({
  signed: SignedVisitorLinkGrant,
  mode: VisitorThreadMode,
  threadId: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
  /** SHA-256 of the first browser's key; every later request must name it. */
  binding: Schema.optional(Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)))),
  /** Set when the person stopped sharing; kept so the link answers "revoked" until it would have expired. */
  stoppedAt: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
});
export type SpokeVisitorLink = typeof SpokeVisitorLink.Type;

/** A visitor's comment waiting for the person's Send or Dismiss. */
export const SpokeVisitorComment = Schema.Struct({
  commentId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/))),
  linkId: Schema.String.pipe(Schema.check(Schema.isMaxLength(64))),
  text: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4_000)),
  ),
  at: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type SpokeVisitorComment = typeof SpokeVisitorComment.Type;

export const SpokeVisitorState = Schema.Struct({
  links: Schema.Array(SpokeVisitorLink).pipe(Schema.check(Schema.isMaxLength(256))),
  comments: Schema.Array(SpokeVisitorComment).pipe(Schema.check(Schema.isMaxLength(5_120))),
  /** The hub has not taken the current grant list yet; the next look sends it again. */
  unpublished: Schema.optional(Schema.Literal(true)),
});
export type SpokeVisitorState = typeof SpokeVisitorState.Type;

/** What the acting hub holds for visitor links: its switch and each spoke's signed grants. */
export const HubVisitorHubState = Schema.Struct({
  enabled: Schema.Boolean,
  grants: Schema.Array(SignedVisitorLinkGrant).pipe(Schema.check(Schema.isMaxLength(4_096))),
});
export type HubVisitorHubState = typeof HubVisitorHubState.Type;

const keyDigest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));

/** What the acting hub holds for the device relay: its switch and each host's listed device keys. */
export const HubRelayHubState = Schema.Struct({
  enabled: Schema.Boolean,
  hosts: Schema.Array(
    Schema.Struct({
      memberId: HubMemberId,
      fingerprints: Schema.Array(keyDigest).pipe(Schema.check(Schema.isMaxLength(256))),
    }),
  ).pipe(Schema.check(Schema.isMaxLength(256))),
});
export type HubRelayHubState = typeof HubRelayHubState.Type;

/** The paired devices this host's person lets through the hub's device relay. */
export const SpokeRelayState = Schema.Struct({
  deviceIds: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(128)))).pipe(
    Schema.check(Schema.isMaxLength(256)),
  ),
  /** The hub has not taken the current list yet; the next look sends it again. */
  unpublished: Schema.optional(Schema.Literal(true)),
  /** The relay address the hub last named in its answer, which this host tells its own devices. */
  address: Schema.optional(RelayAddress),
});
export type SpokeRelayState = typeof SpokeRelayState.Type;

export const HubState = Schema.Struct({
  hub: Schema.optional(HubSideState),
  link: Schema.optional(HubLinkState),
  publicEntrance: Schema.optional(PublicEntranceState),
  /** The acting hub's webhook endpoints and queue (decision H33). */
  webhookHub: Schema.optional(HubWebhookHubState),
  /** This spoke's own webhook endpoints and deliveries. */
  webhooks: Schema.optional(SpokeWebhookState),
  /** The acting hub's visitor-link switch and grants (decision H32). */
  visitorHub: Schema.optional(HubVisitorHubState),
  /** This spoke's own visitor links and the comments waiting on them. */
  visitors: Schema.optional(SpokeVisitorState),
  /** The acting hub's device relay switch and listed keys (decision H36). */
  relayHub: Schema.optional(HubRelayHubState),
  /** This host's own devices allowed through the relay. */
  relays: Schema.optional(SpokeRelayState),
  /** Guest devices a dropped link, or the hub dropping a member window, could not revoke because the device pairing was not running; revoked once it is. */
  pendingDeviceRevocations: Schema.optional(Schema.Array(Schema.String.check(Schema.isGUID()))),
  /** Devices that paired directly with this host, until a window clears each alert or the device is removed. */
  pairedDeviceAlerts: Schema.optional(Schema.Array(PairedDeviceAlert)),
  /** A paired phone or web client's merge needs a fresh unlock on an owner device; set only from a window on this host. */
  ownerUnlockBeforePairedMerge: Schema.optional(Schema.Literal(true)),
  /** Each approval answer from an owner device needs its own fresh unlock; unset, an open session covers them. Set only from a window on this host. */
  ownerUnlockPerApprovalAnswer: Schema.optional(Schema.Literal(true)),
});
export type HubState = typeof HubState.Type;

const decodeState = Schema.decodeUnknownSync(HubState, { onExcessProperty: "error" });
const KNOWN_HUB_GRANT_ITEMS: ReadonlySet<string> = new Set(HUB_GRANT_ITEMS);

/**
 * Drop a hub grant item this build does not know.
 *
 * A newer Octant build can add a grant item to `HUB_GRANT_ITEMS`. If the
 * person later moves back to an older build, decoding the whole hub state
 * strictly would drop the spoke's entire hub link, roster, and grant. Keeping
 * non-string entries untouched ensures genuine corruption still fails decode.
 */
function withoutUnknownGrantItems(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const link = raw.link;
  if (!isObject(link)) return raw;
  const grant = link.grant;
  if (!isObject(grant) || !Array.isArray(grant.items)) return raw;
  const filtered = grant.items.filter(
    (item) => typeof item !== "string" || KNOWN_HUB_GRANT_ITEMS.has(item),
  );
  if (filtered.length === grant.items.length) return raw;
  return {
    ...raw,
    link: {
      ...link,
      grant: {
        ...grant,
        items: filtered,
      },
    },
  };
}

function decodeStoredHubState(raw: unknown): HubState {
  return decodeState(withoutUnknownGrantItems(withoutFeedsMissingTheirApp(raw)));
}

/**
 * Drop a stored update feed whose release does not name its app.
 *
 * A feed saved before releases carried `product` no longer decodes, and the
 * state is decoded as one document: without this, one old mirror would lose
 * the whole hub link on load. No current install accepts such a feed, so
 * there is nothing left to serve or verify in it.
 */
function withoutFeedsMissingTheirApp(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const named = (feed: unknown): boolean =>
    isObject(feed) && isObject(feed.release) && "product" in feed.release;
  const hub = raw.hub;
  const link = raw.link;
  return {
    ...raw,
    ...(isObject(hub) && isObject(hub.provision) && Array.isArray(hub.provision.offers)
      ? {
          hub: {
            ...hub,
            provision: {
              ...hub.provision,
              offers: hub.provision.offers.map((offer: unknown) => {
                if (!isObject(offer) || !("mirrorFeed" in offer) || named(offer.mirrorFeed)) {
                  return offer;
                }
                const { mirrorFeed: _unnamed, ...kept } = offer;
                return kept;
              }),
            },
          },
        }
      : {}),
    ...(isObject(link) &&
    isObject(link.provision) &&
    "verifiedFeed" in link.provision &&
    !named(link.provision.verifiedFeed)
      ? {
          link: {
            ...link,
            provision: (({ verifiedFeed: _unnamed, ...kept }) => kept)(link.provision),
          },
        }
      : {}),
  };
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HubStatePort {
  readonly load: () => HubState;
  readonly save: (state: HubState) => void;
}

export function createHubStateStore(
  dataDirectory: string,
  nativeFile?: WindowsAuthorityStateFile,
): HubStatePort {
  const native = nativeAuthorityState(
    dataDirectory,
    nativeFile,
    decodeStoredHubState,
    Schema.encodeSync(HubState),
    () => ({}),
  );
  if (native !== undefined) return native;
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeStoredHubState(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        return {};
      }
    },
    save: (state) => {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const staging = `${path}.${process.pid}.tmp`;
      writeFileSync(staging, JSON.stringify(Schema.encodeSync(HubState)(state)), { mode: 0o600 });
      // writeFileSync applies the mode only when it creates the file, so a
      // staging file left behind by a crashed save is narrowed here too.
      chmodSync(staging, 0o600);
      renameSync(staging, path);
    },
  };
}
