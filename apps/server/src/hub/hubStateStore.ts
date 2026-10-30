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
  HardwareAddress,
  HubAutoApplyKind,
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
  RosterMember,
  SignedHubRoster,
  WakeRoutineId,
} from "@octant/contracts";
import { Schema } from "effect";

const SUBDIR = "hub";
const FILE = "hub-state.json";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const digest = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/));
const key = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^[A-Za-z0-9_-]+$/),
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
  deviceId: Schema.optional(Schema.UUID),
  /** Absent for a guest, which runs no listener the hub could reach. */
  listenerOrigin: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300))),
}).annotations(strict);
export type HubMemberRecord = typeof HubMemberRecord.Type;

/** A join code the hub made and has not yet seen used. */
export const HubJoinTicketRecord = Schema.Struct({
  ticketId: Schema.UUID,
  owner: Schema.Boolean,
}).annotations(strict);
export type HubJoinTicketRecord = typeof HubJoinTicketRecord.Type;

/**
 * One entry of a host's own owner list with what the host needs to check the
 * device: its name as the roster showed it when it was added, and the unlock
 * public key. The identity key is not kept; the device presents it with each
 * request and the host compares its fingerprint.
 */
export const HostOwnerRecord = Schema.Struct({
  memberId: HubMemberId,
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  identityKeyFingerprint: digest,
  unlockKeyFingerprint: digest,
  unlockPublicKey: key,
}).annotations(strict);
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
  lastResult: Schema.optional(
    Schema.Struct({ at: Schema.Int, result: HubWakeResult }).annotations(strict),
  ),
}).annotations(strict);
export type WakeSpokeRecord = typeof WakeSpokeRecord.Type;

/**
 * When a spoke last withdrew its wake state. It carries no times and no address and
 * never wakes anything; it only stops an older hand-back from bringing them back.
 */
export const WakeWithdrawal = Schema.Struct({
  memberId: HubMemberId,
  withdrawnAt: Schema.Int,
  /** The sequence of the withdrawing report, so an older report arriving later is ignored. */
  sequence: Schema.optional(Schema.Int.pipe(Schema.positive())),
}).annotations(strict);
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
}).annotations(strict);
export type HubWakeState = typeof HubWakeState.Type;

/**
 * What the hub counts of the notifications it forwarded for one spoke: how many
 * went on and how many it refused, and how the last one ended. Counts only; the
 * hub keeps no capability, envelope, or gateway message.
 */
export const PushSpokeRecord = Schema.Struct({
  memberId: HubMemberId,
  forwarded: Schema.Int.pipe(Schema.nonNegative()),
  refused: Schema.Int.pipe(Schema.nonNegative()),
  lastResult: Schema.optional(
    Schema.Struct({ at: Schema.Int, result: HubPushResult }).annotations(strict),
  ),
}).annotations(strict);
export type PushSpokeRecord = typeof PushSpokeRecord.Type;

/** The hub's push sender: its own switch, off until the person turns it on, and what it counted. */
export const HubPushState = Schema.Struct({
  enabled: Schema.Boolean,
  spokes: Schema.Array(PushSpokeRecord),
}).annotations(strict);
export type HubPushState = typeof HubPushState.Type;

/** How the hub's last attempt to hand one spoke one offer ended. */
export const ProvisionDeliveryRecord = Schema.Struct({
  memberId: HubMemberId,
  at: Schema.Int,
  result: HubOfferDeliveryResult,
  reason: Schema.optional(HubProvisionReason),
}).annotations(strict);
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
}).annotations(strict);
export type ProvisionOfferRecord = typeof ProvisionOfferRecord.Type;

/** The hub's provisioning: its own switch, off until the person turns it on, and the offers it holds. */
export const HubProvisionState = Schema.Struct({
  enabled: Schema.Boolean,
  offers: Schema.Array(ProvisionOfferRecord),
}).annotations(strict);
export type HubProvisionState = typeof HubProvisionState.Type;

/** An offer a spoke holds as a proposal until its person applies it, dismisses it, or it lapses. */
export const ProvisionProposalRecord = Schema.Struct({
  offerId: HubOfferId,
  offer: HubOfferBody,
  receivedAtMs: Schema.Int,
  expiresAtMs: Schema.Int,
}).annotations(strict);
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
}).annotations(strict);
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
}).annotations(strict);
export type SignInAskRecord = typeof SignInAskRecord.Type;

export const HubSignInState = Schema.Struct({
  asks: Schema.Array(SignInAskRecord),
}).annotations(strict);
export type HubSignInState = typeof HubSignInState.Type;

/** A request a spoke holds for its person: asked, then accepted once they say so. */
export const SignInRequestRecord = Schema.Struct({
  requestId: HubSignInRequestId,
  kind: HubSignInKind,
  receivedAtMs: Schema.Int,
  expiresAtMs: Schema.Int,
  state: Schema.Literal("asked", "accepted"),
}).annotations(strict);
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
    Schema.Struct({ requestId: HubSignInRequestId, outcome: HubSignInOutcome }).annotations(strict),
  ),
}).annotations(strict);
export type SpokeSignInState = typeof SpokeSignInState.Type;

export const HubSideState = Schema.Struct({
  enabled: Schema.Boolean,
  signIn: Schema.optional(HubSignInState),
  wake: Schema.optional(HubWakeState),
  push: Schema.optional(HubPushState),
  provision: Schema.optional(HubProvisionState),
  roster: Schema.optional(SignedHubRoster),
  members: Schema.Array(HubMemberRecord),
  joinTickets: Schema.Array(HubJoinTicketRecord),
  /** The hub's own owner list. A roster's owner mark never adds to it. */
  owners: Schema.optional(Schema.Array(HostOwnerRecord)),
  /**
   * The members this hub removed, with the roster sequence of each removal. A
   * standby that stood in hands back its changes against a base sequence, and
   * the removals after it are what keep a member out when the other side kept it.
   */
  removals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        memberId: HubMemberId,
        sequence: Schema.Int.pipe(Schema.positive()),
      }).annotations(strict),
    ),
  ),
}).annotations(strict);
export type HubSideState = typeof HubSideState.Type;

/** A member a standby added while standing in, kept until the hub takes it back. */
export const StandInAddedRecord = Schema.Struct({
  member: RosterMember,
  identityPublicKey: key,
  listenerOrigin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300)),
  /** The paired device the standby made for the member. */
  deviceId: Schema.UUID,
}).annotations(strict);
export type StandInAddedRecord = typeof StandInAddedRecord.Type;

/**
 * What a standby keeps while it stands in for an unreachable hub: the hub-signed
 * sequence it stood in on, the membership changes it made, and the join codes it
 * made. Members and join codes are never netted, so the hub sees every change.
 */
export const StandInState = Schema.Struct({
  startedAt: Schema.Int,
  baseSequence: Schema.Int.pipe(Schema.positive()),
  added: Schema.Array(StandInAddedRecord),
  removed: Schema.Array(HubMemberId),
  joinTickets: Schema.Array(Schema.UUID),
  /** Routine times spokes reported to this standby while it stood in; handed back with the changes above. */
  wakeReports: Schema.optional(Schema.Array(WakeSpokeRecord)),
  /**
   * Set while a hand-back to the returned hub is in flight. Membership is
   * frozen then, so every change made is in the hand-back and none can be lost
   * when the stand-in ends.
   */
  handingBack: Schema.optional(Schema.Literal(true)),
}).annotations(strict);
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
  reportSequence: Schema.optional(Schema.Int.pipe(Schema.positive())),
  routines: Schema.Array(
    Schema.Struct({
      automationId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
      routineId: WakeRoutineId,
    }).annotations(strict),
  ),
}).annotations(strict);
export type SpokeWakeState = typeof SpokeWakeState.Type;

export const GuestDeviceRecord = Schema.Struct({
  memberId: HubMemberId,
  deviceId: Schema.UUID,
}).annotations(strict);
export type GuestDeviceRecord = typeof GuestDeviceRecord.Type;

/** The hub as a spoke knows it, and what that spoke lets it do. */
export const HubLinkState = Schema.Struct({
  selfMemberId: HubMemberId,
  hubMemberId: HubMemberId,
  hubName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128)),
  hubOrigin: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(300)),
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
  pushCopy: Schema.optional(Schema.Struct({ enabled: Schema.Boolean }).annotations(strict)),
  /** This spoke's side of provisioning: proposals, auto-apply choices, the verified mirrored feed. */
  provision: Schema.optional(SpokeProvisionState),
  /** This spoke's side of hub-started sign-in: the requests its person has yet to answer. */
  signIn: Schema.optional(SpokeSignInState),
}).annotations(strict);
export type HubLinkState = typeof HubLinkState.Type;

export const HubState = Schema.Struct({
  hub: Schema.optional(HubSideState),
  link: Schema.optional(HubLinkState),
  /** Guest devices a dropped link could not revoke because the device pairing was not running; revoked once it is. */
  pendingDeviceRevocations: Schema.optional(Schema.Array(Schema.UUID)),
}).annotations(strict);
export type HubState = typeof HubState.Type;

const decodeState = Schema.decodeUnknownSync(HubState);

export interface HubStatePort {
  readonly load: () => HubState;
  readonly save: (state: HubState) => void;
}

export function createHubStateStore(dataDirectory: string): HubStatePort {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, FILE);
  return {
    load: () => {
      try {
        return decodeState(JSON.parse(readFileSync(path, "utf8")));
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
