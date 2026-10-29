// The spoke side of a hub: joining one, the hub grant, leaving, and what a
// request from the hub may do here. Only this host, through its loopback
// administration channel, joins, leaves, or changes the grant. The hub is a
// principal of kind `hub` whose authority is exactly that grant; it never
// carries a window's authority and never answers an approval.

import { randomUUID } from "node:crypto";
import {
  HubMemberId as HubMemberIdSchema,
  NewMemberAlertId,
  UtcTimestamp,
  decodeHubJoinResponse,
  type AuditActingPrincipal,
  type HubGrant,
  type HubGrantItem,
  type HeldMember,
  type HubGuestAdmissionRequest,
  type HubJoinRequest,
  type HubMemberId,
  type HubPrincipal,
  type PeerPrincipal,
  type HubSpokeStatus,
  type NewMemberAlert,
  type NewMemberConfirmation,
  type OwnerCandidate,
  type OwnerListEntry,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  admitNewMember,
  authorizeHubRequest,
  authorizePeer,
  decideRosterReplacement,
  defaultHubGrant,
  evaluateDeviceRegistration,
  fullMemberPeerGrant,
  holdsOnlyStatusGrant,
  hubRosterSigningPayload,
  introduceGuests,
  newMemberConfirmationSigningPayload,
  reconcileHeldGrants,
  type AuthorizedPeer,
  type NewMemberAdmission,
  type RosterReplacement,
} from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import { listenerPinFromDigest, publicKeyFingerprint, verifySignature } from "./hubCrypto";
import { HubLinkVerifier, sendHubLinkRequest } from "./hubLink";
import { openHubPairing, type HubPairingRefusal, type HubPairingSession } from "./hubPairing";
import type { HubHostIdentity } from "./hubService";
import type { HostOwnerRecord, HubLinkState, HubStatePort } from "./hubStateStore";
import {
  addOwnerRecords,
  ownerEntries,
  ownerListView,
  readRosterOwners,
  withoutOwner,
  type OwnerCandidateView,
  type OwnerChange,
  type OwnerKeyMismatch,
} from "./ownerRecords";
import { verifyOwnerAssertion } from "./ownerUnlock";
import type { HubTransport } from "./pinnedHubTransport";
import { readPrivateListener } from "./privateListenerReading";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberIdSchema);
const decodeAlertId = Schema.decodeUnknownSync(NewMemberAlertId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
/** Alerts a spoke keeps; the oldest go first once a person leaves them undismissed. */
const MAX_ALERTS = 64;

/**
 * Whether a paired device can still sign in: `expired` once its inactivity or
 * absolute window has passed, `unknown` when this host holds no such device.
 */
export type SpokeDeviceLifecycle = "active" | "expired" | "revoked" | "unknown";

/** What the spoke needs of its own device pairing to admit and drop a guest. */
export interface SpokeDevicePort {
  readonly admitIntroducedDevice: (input: {
    readonly devicePublicKey: string;
    readonly deviceLabel: string;
    readonly origin: string;
    readonly sourceClass: "lan-private" | "tailscale";
  }) => { readonly deviceId: string };
  readonly deviceLifecycle: (deviceId: string, now: number) => SpokeDeviceLifecycle;
  readonly revokeDevice: (deviceId: string) => void;
  /** False for a device that is revoked, expired, or not held here. */
  readonly deviceActive: (deviceId: string) => boolean;
}

/** Reads one device's lifecycle from the host's device list under the pairing's own expiry policy. */
export function deviceLifecycleAt(
  devices: ReadonlyArray<{
    readonly deviceId: string;
    readonly state: "active" | "revoked" | "expired";
    readonly createdAt: string;
    readonly lastSeenAt: string;
  }>,
  deviceId: string,
  now: number,
): SpokeDeviceLifecycle {
  const device = devices.find((entry) => entry.deviceId === deviceId);
  if (device === undefined) return "unknown";
  if (device.state === "revoked") return "revoked";
  const verdict = evaluateDeviceRegistration({
    state: device.state,
    now,
    createdAt: Date.parse(device.createdAt),
    lastSeenAt: Date.parse(device.lastSeenAt),
  });
  return verdict.kind === "active" ? "active" : "expired";
}

export type GuestAdmission =
  | { readonly status: "admitted"; readonly spokeMemberId: HubMemberId; readonly deviceId: string }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "missing"
        | "malformed"
        | "stale"
        | "unknown-sender"
        | "signature-invalid"
        | "replayed"
        | "not-in-roster"
        | "key-mismatch"
        | "guest-not-accepted"
        | "guest-not-confirmed"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin"
        | "devices-unavailable"
        | "device-revoked";
    };

/** A raw key signs the confirmation text; a passkey answers it as a WebAuthn challenge, as for an unlock. */
function confirmationSignatureHolds(
  confirmation: NewMemberConfirmation,
  unlockPublicKey: string,
): boolean {
  const payload = newMemberConfirmationSigningPayload(confirmation);
  if ("authenticatorData" in confirmation) {
    return (
      verifyOwnerAssertion({ payload, assertion: confirmation, unlockPublicKey }).status === "fresh"
    );
  }
  return verifySignature({
    payload,
    signature: confirmation.signature,
    publicKey: unlockPublicKey,
  });
}

const publicKeyPem = (publicKey: string): string => {
  const body = Buffer.from(publicKey, "base64url").toString("base64");
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END PUBLIC KEY-----`;
};

export interface SpokeLinkOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly listener: () => PrivateListenerHostStatus;
  readonly transport: HubTransport;
  /** The paired devices of this host, which an introduced guest becomes one of. */
  readonly devices: () => SpokeDevicePort | undefined;
  readonly record: (change: {
    readonly change:
      | "joined-hub"
      | "left-hub"
      | "hub-grant-changed"
      | "roster-accepted"
      | "guest-admitted"
      | "guest-dropped"
      | "owner-added"
      | "owner-removed"
      | "new-member-alerted"
      | "new-member-confirmed"
      | "new-member-removed"
      | "alert-dismissed"
      | "confirm-new-members-changed";
    readonly actingPrincipal: AuditActingPrincipal;
    readonly memberId?: HubMemberId;
    readonly sequence?: number;
    readonly items?: ReadonlyArray<HubGrantItem>;
  }) => void;
  readonly serverBuildVersion: string;
  readonly now: () => number;
}

export type JoinStartOutcome =
  | {
      readonly status: "awaiting-approval";
      readonly hubName: string;
      readonly hubKeyFingerprint: string;
      readonly comparisonCode: string;
    }
  | {
      readonly status: "refused";
      readonly kind:
        | HubPairingRefusal
        | "already-joined"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin"
        | "hub-unreachable";
    };

export type JoinFinishOutcome =
  | { readonly status: "awaiting-approval" }
  | { readonly status: "joined"; readonly rosterSequence: number; readonly grant: HubGrant }
  | {
      readonly status: "refused";
      readonly kind:
        | "no-join-in-progress"
        | "hub-declined"
        | "hub-unreachable"
        | "hub-refused-join"
        | "hub-answer-invalid";
    };

export type SpokeLinkStatus =
  | { readonly membership: "none" }
  | {
      readonly membership: "member" | "removed";
      readonly hub: { readonly memberId: HubMemberId; readonly name: string };
      readonly grant: HubGrant;
      readonly roster: SignedHubRoster;
      /** The roster members this host accepted: the ones it gave a peer grant, so a guest among them may knock. */
      readonly acceptedMemberIds: ReadonlyArray<string>;
      /** This host's own owner list, by name and fingerprint. */
      readonly owners: ReadonlyArray<OwnerListEntry>;
      /** Roster members that list an unlock key and are not on the owner list: a window confirms each by name and both fingerprints. */
      readonly ownerCandidates: ReadonlyArray<OwnerCandidateView>;
      /** Owners whose roster entry lists a different unlock key than the one this host confirmed; the list is unchanged. */
      readonly ownerKeyMismatches: ReadonlyArray<OwnerKeyMismatch>;
      readonly confirmNewMembers: boolean;
      /** Members this host holds status-only until a window or an owner's signed unlock confirms them. */
      readonly awaitingConfirmation: ReadonlyArray<string>;
      readonly heldMembers: ReadonlyArray<HeldMember>;
      readonly alerts: ReadonlyArray<NewMemberAlert>;
    };

export type SpokeOwnerContext = {
  readonly roster: SignedHubRoster["roster"];
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly grant: HubGrant;
  readonly hubMemberId: HubMemberId;
  /** Members whose paired device on this host is revoked or unknown: they hold no owner powers here. */
  readonly inactiveDeviceMemberIds: ReadonlyArray<string>;
};

export type MemberConfirmation =
  | { readonly status: "confirmed"; readonly memberId: HubMemberId }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "not-awaiting-confirmation"
        | "confirmation-invalid";
      readonly reason?: string;
    };

export type AlertOutcome =
  | { readonly status: "dismissed" | "removed"; readonly alertId: string }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | "no-such-alert";
    };

export type HubRequestOutcome =
  | { readonly status: "hub"; readonly principal: HubPrincipal }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "missing"
        | "malformed"
        | "stale"
        | "unknown-sender"
        | "signature-invalid"
        | "replayed";
    };

export type PeerRequestOutcome =
  | {
      readonly status: "peer";
      readonly principal: PeerPrincipal;
      readonly peer: AuthorizedPeer;
      /** This host's own member id, which a result it returns names as its source. */
      readonly selfMemberId: HubMemberId;
    }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-a-spoke"
        | "hub-revoked"
        | "missing"
        | "malformed"
        | "stale"
        | "unknown-sender"
        | "key-mismatch"
        | "signature-invalid"
        | "replayed"
        | "not-in-roster"
        | "hub-cannot-delegate"
        | "no-peer-grant";
    };

export type MemberTarget =
  | { readonly status: "member"; readonly self: HubMemberId; readonly member: RosterMember }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | "not-in-roster";
    };

export type RosterReceipt =
  | { readonly status: "accepted"; readonly sequence: number; readonly removed: boolean }
  | {
      readonly status: "refused";
      readonly kind:
        | Extract<RosterReplacement, { readonly status: "refused" }>["kind"]
        | "no-hub-grant"
        | "item-not-granted"
        | "not-a-spoke"
        | "hub-revoked";
    };

interface PendingJoin {
  readonly session: HubPairingSession;
  readonly ownListener: Extract<
    ReturnType<typeof readPrivateListener>,
    { readonly status: "private" }
  >;
}

export class SpokeLinkService {
  readonly #options: SpokeLinkOptions;
  readonly #verifier: HubLinkVerifier;
  #pending: PendingJoin | undefined;

  constructor(options: SpokeLinkOptions) {
    this.#options = options;
    this.#verifier = new HubLinkVerifier({ now: options.now });
  }

  status(): SpokeLinkStatus {
    this.settlePendingRevocations();
    const link = this.#options.state.load().link;
    if (link === undefined) return { membership: "none" };
    return {
      membership: link.removed === true ? "removed" : "member",
      hub: { memberId: link.hubMemberId, name: link.hubName },
      grant: link.grant,
      roster: link.roster,
      acceptedMemberIds: link.peerGrants.map((grant) => String(grant.memberId)),
      owners: ownerListView(link.owners ?? []),
      ...(link.removed === true
        ? { ownerCandidates: [], ownerKeyMismatches: [] }
        : this.#rosterOwners(link)),
      confirmNewMembers: link.confirmNewMembers === true,
      awaitingConfirmation: link.peerGrants
        .filter(holdsOnlyStatusGrant)
        .map((grant) => String(grant.memberId)),
      heldMembers: this.heldMembers(),
      alerts: link.alerts ?? [],
    };
  }

  /**
   * The members this host holds status-only under Confirm new members: the ones
   * its window, or an owner device with a fresh unlock, may confirm.
   */
  heldMembers(): ReadonlyArray<HeldMember> {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) return [];
    return link.roster.roster.members
      .filter((member) =>
        link.peerGrants.some(
          (grant) =>
            String(grant.memberId) === String(member.memberId) && holdsOnlyStatusGrant(grant),
        ),
      )
      .map(({ memberId, name, role, identityKeyFingerprint }) => ({
        memberId,
        name,
        role,
        identityKeyFingerprint,
      }));
  }

  /** Owners the held roster lists a key for: ones to confirm, and ones whose listed key changed since this host confirmed them. */
  #rosterOwners(link: HubLinkState): {
    readonly ownerCandidates: ReadonlyArray<OwnerCandidateView>;
    readonly ownerKeyMismatches: ReadonlyArray<OwnerKeyMismatch>;
  } {
    const read = readRosterOwners({
      roster: link.roster.roster,
      selfMemberId: String(link.selfMemberId),
      owners: link.owners ?? [],
      rejectedMemberIds: link.rejectedMemberIds ?? [],
    });
    return { ownerCandidates: read.candidates, ownerKeyMismatches: read.mismatches };
  }

  /** What the owner routes check a request against; absent when this host is not a member of a hub. */
  ownerContext(): SpokeOwnerContext | undefined {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) return undefined;
    return {
      roster: link.roster.roster,
      owners: link.owners ?? [],
      grant: link.grant,
      hubMemberId: link.hubMemberId,
      // Only a guest holds a paired device on a spoke; a failed lookup counts as inactive.
      inactiveDeviceMemberIds: (link.guestDevices ?? [])
        .filter((entry) => this.#options.devices()?.deviceActive(entry.deviceId) !== true)
        .map((entry) => String(entry.memberId)),
    };
  }

  /** Adds devices to this spoke's owner list; the caller has checked who may ask. */
  addOwners(
    candidates: ReadonlyArray<OwnerCandidate>,
    principal: AuditActingPrincipal,
  ): OwnerChange {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const added = addOwnerRecords({
      roster: link.roster.roster,
      selfMemberId: String(link.selfMemberId),
      owners: link.owners ?? [],
      candidates,
    });
    if (added.status === "refused") return added;
    this.#options.state.save({ ...state, link: { ...link, owners: added.owners } });
    for (const candidate of candidates) {
      this.#options.record({
        change: "owner-added",
        actingPrincipal: principal,
        memberId: candidate.memberId,
      });
    }
    return { status: "changed", owners: ownerListView(added.owners) };
  }

  removeOwner(memberId: string, principal: AuditActingPrincipal): OwnerChange {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    const owners = link.owners ?? [];
    const target = owners.find((owner) => String(owner.memberId) === memberId);
    if (target === undefined) return { status: "refused", kind: "not-an-owner", memberId };
    const remaining = withoutOwner(owners, memberId);
    this.#options.state.save({ ...state, link: { ...link, owners: remaining } });
    this.#options.record({
      change: "owner-removed",
      actingPrincipal: principal,
      memberId: target.memberId,
    });
    return { status: "changed", owners: ownerListView(remaining) };
  }

  /** Confirm new members is this spoke's own setting, off by default. */
  setConfirmNewMembers(
    enabled: boolean,
    principal: AuditActingPrincipal,
  ):
    | { readonly status: "changed"; readonly enabled: boolean }
    | { readonly status: "refused"; readonly kind: "not-a-spoke" | "hub-revoked" } {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const { confirmNewMembers: _previous, ...rest } = link;
    this.#options.state.save({
      ...state,
      link: enabled ? { ...rest, confirmNewMembers: true } : rest,
    });
    this.#options.record({
      change: "confirm-new-members-changed",
      actingPrincipal: principal,
      memberId: link.hubMemberId,
    });
    return { status: "changed", enabled };
  }

  /** A window on this spoke confirms a member it holds status-only. */
  confirmMemberFromWindow(memberId: string, principal: AuditActingPrincipal): MemberConfirmation {
    return this.#confirm(memberId, principal, (member) => ({
      status: "full-member",
      grant: fullMemberPeerGrant(member),
    }));
  }

  /**
   * An owner device confirms a member with a `NewMemberConfirmation` signed by
   * its unlock key. The owner must be on this spoke's own list and the
   * signature must verify against the unlock key recorded there; the hub holds
   * neither, so it cannot produce one.
   */
  confirmMemberByOwner(
    confirmation: NewMemberConfirmation,
    principal: AuditActingPrincipal,
  ): MemberConfirmation {
    const link = this.#options.state.load().link;
    const owners = link?.owners ?? [];
    const owner = owners.find(
      (entry) => String(entry.memberId) === String(confirmation.confirmedBy),
    );
    const signatureVerified =
      owner !== undefined && confirmationSignatureHolds(confirmation, owner.unlockPublicKey);
    return this.#confirm(String(confirmation.memberId), principal, (member) =>
      admitNewMember({
        spokeId: link?.selfMemberId ?? confirmation.spokeId,
        member,
        confirmNewMembers: true,
        owners: ownerEntries(owners),
        confirmation: { confirmation, signatureVerified },
      }),
    );
  }

  #confirm(
    memberId: string,
    principal: AuditActingPrincipal,
    admit: (member: RosterMember) => NewMemberAdmission,
  ): MemberConfirmation {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const member = link.roster.roster.members.find((entry) => String(entry.memberId) === memberId);
    const held = link.peerGrants.find((grant) => String(grant.memberId) === memberId);
    if (member === undefined || held === undefined || !holdsOnlyStatusGrant(held)) {
      return { status: "refused", kind: "not-awaiting-confirmation" };
    }
    const admission = admit(member);
    if (admission.status !== "full-member") {
      return {
        status: "refused",
        kind: "confirmation-invalid",
        ...(admission.reason === undefined ? {} : { reason: admission.reason }),
      };
    }
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        peerGrants: link.peerGrants.map((grant) =>
          String(grant.memberId) === memberId ? admission.grant : grant,
        ),
      },
    });
    this.#options.record({
      change: "new-member-confirmed",
      actingPrincipal: principal,
      memberId: member.memberId,
    });
    return { status: "confirmed", memberId: member.memberId };
  }

  /** Dismisses an alert. Owner devices and windows read and dismiss; the hub does neither. */
  dismissAlert(alertId: string, principal: AuditActingPrincipal): AlertOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    const alert = link.alerts?.find((entry) => String(entry.alertId) === alertId);
    if (alert === undefined) return { status: "refused", kind: "no-such-alert" };
    this.#options.state.save({
      ...state,
      link: { ...link, alerts: (link.alerts ?? []).filter((entry) => entry !== alert) },
    });
    this.#options.record({
      change: "alert-dismissed",
      actingPrincipal: principal,
      memberId: alert.memberId,
    });
    return { status: "dismissed", alertId };
  }

  /**
   * Remove on an alert: revokes what this spoke gave the member (its peer
   * grant and any paired device) and marks it not accepted, so a later roster
   * that still lists it does not bring it back. Removing the member from the
   * hub's roster needs the hub's own authority and is not done here.
   */
  removeFromAlert(alertId: string, principal: AuditActingPrincipal): AlertOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    const alert = link.alerts?.find((entry) => String(entry.alertId) === alertId);
    if (alert === undefined) return { status: "refused", kind: "no-such-alert" };
    const memberId = String(alert.memberId);
    const devices = (link.guestDevices ?? []).filter(
      (entry) => String(entry.memberId) === memberId,
    );
    const rejected = link.rejectedMemberIds ?? [];
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        peerGrants: link.peerGrants.filter((grant) => String(grant.memberId) !== memberId),
        guestDevices: (link.guestDevices ?? []).filter(
          (entry) => String(entry.memberId) !== memberId,
        ),
        alerts: (link.alerts ?? []).filter((entry) => String(entry.memberId) !== memberId),
        // A member this spoke refuses loses any owner entry here with it.
        ...(link.owners === undefined ? {} : { owners: withoutOwner(link.owners, memberId) }),
        rejectedMemberIds: rejected.some((id) => String(id) === memberId)
          ? rejected
          : [...rejected, alert.memberId],
      },
    });
    this.#revokeOrKeepDevices(devices.map((entry) => entry.deviceId));
    this.#options.record({
      change: "new-member-removed",
      actingPrincipal: principal,
      memberId: alert.memberId,
    });
    return { status: "removed", alertId };
  }

  /** The peer grants this spoke has given, which a newer roster or Leave can end. */
  peerGrantCount(): number {
    return this.#options.state.load().link?.peerGrants.length ?? 0;
  }

  /**
   * Step one of joining: read the join code, reach the hub over a connection
   * held to its pin, and claim the pairing. The person then compares the short
   * code and approves on the hub.
   */
  async startJoin(input: { readonly code: string }): Promise<JoinStartOutcome> {
    const link = this.#options.state.load().link;
    if (link !== undefined && link.removed !== true) {
      return { status: "refused", kind: "already-joined" };
    }
    // The hub must be able to reach this host back, so the listener is checked first.
    const own = readPrivateListener(this.#options.listener());
    if (own.status === "refused") return { status: "refused", kind: own.kind };
    const identity = this.#options.identity();
    const opening = await openHubPairing({
      code: input.code,
      deviceLabel: identity.displayName,
      transport: this.#options.transport,
      webBuildVersion: this.#options.serverBuildVersion,
      now: this.#options.now,
    });
    if (opening.status === "refused") return { status: "refused", kind: opening.kind };
    if (opening.status === "failed") return { status: "refused", kind: "hub-unreachable" };
    this.#pending = { session: opening.session, ownListener: own };
    return {
      status: "awaiting-approval",
      hubName: opening.session.hub.displayName,
      hubKeyFingerprint: opening.session.hub.hostKeyFingerprint,
      comparisonCode: opening.session.comparisonCode,
    };
  }

  /**
   * Step two: once the person approved on the hub, finish pairing, hand the
   * hub this host's identity key and listener, and keep the signed roster it
   * answers with. Until then it reports that approval is still awaited.
   */
  async finishJoin(
    principal: AuditActingPrincipal,
    options: { readonly unlockPublicKey?: string } = {},
  ): Promise<JoinFinishOutcome> {
    const pending = this.#pending;
    if (pending === undefined) return { status: "refused", kind: "no-join-in-progress" };
    const { session, ownListener } = pending;
    const polled = await session.poll().catch(() => undefined);
    if (polled === undefined) return { status: "refused", kind: "hub-unreachable" };
    if (polled.kind === "pending") return { status: "awaiting-approval" };
    if (polled.kind === "failed") {
      this.#pending = undefined;
      return { status: "refused", kind: "hub-declined" };
    }
    const identity = this.#options.identity();
    const hubIdentityKey = session.hub.hostPublicKey;
    const selfMemberId = decodeMemberId(String(identity.hostId));
    const request: HubJoinRequest = {
      ticketId: session.ticket.ticketId,
      ticketProof: session.ticket.ticketProof,
      member: {
        memberId: selfMemberId,
        name: identity.displayName,
        identityKeyFingerprint: identity.signing.hostKeyFingerprint,
        listenerPin: ownListener.pinDigest,
        privateNames: ownListener.privateNames,
        addresses: ownListener.addresses,
      },
      identityPublicKey: identity.signing.hostPublicKey,
      listenerOrigin: ownListener.origin,
      // The hub adds this key to its owner list only if the code was an owner
      // code; for any other code it is ignored.
      ...(options.unlockPublicKey === undefined
        ? {}
        : { ownerUnlockPublicKey: options.unlockPublicKey }),
    };
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: session.hub.origin, pin: session.hub.pin },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(selfMemberId),
      recipientMemberId: session.hub.hostId,
      method: "POST",
      path: "/api/hub/join",
      body: JSON.stringify(request),
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return { status: "refused", kind: "hub-unreachable" };
    this.#pending = undefined;
    if (!answer.response.ok) return { status: "refused", kind: "hub-refused-join" };
    let response;
    try {
      response = decodeHubJoinResponse(await answer.response.json());
    } catch {
      return { status: "refused", kind: "hub-answer-invalid" };
    }
    // The hub is who its hello proved it to be, and the roster is signed by the
    // key the hub announced and lists this host. Anything else is not a join.
    const rosterSigned = verifySignature({
      payload: hubRosterSigningPayload(response.roster.roster),
      signature: response.roster.signature,
      publicKey: response.hub.rosterSigningPublicKey,
    });
    const listsSelf = response.roster.roster.members.some(
      (member) => String(member.memberId) === String(selfMemberId),
    );
    if (
      String(response.hub.memberId) !== session.hub.hostId ||
      response.hub.identityPublicKey !== hubIdentityKey ||
      publicKeyFingerprint(hubIdentityKey) !== session.hub.hostKeyFingerprint ||
      String(response.roster.signedBy.memberId) !== session.hub.hostId ||
      response.roster.signedBy.kind !== "hub" ||
      !rosterSigned ||
      !listsSelf
    ) {
      return { status: "refused", kind: "hub-answer-invalid" };
    }
    const grant = defaultHubGrant();
    const state = this.#options.state.load();
    this.#options.state.save({
      ...state,
      link: {
        selfMemberId,
        hubMemberId: response.hub.memberId,
        hubName: response.hub.name,
        hubOrigin: session.hub.origin,
        hubListenerPin: response.hub.listenerPin,
        hubIdentityPublicKey: hubIdentityKey,
        rosterSigningPublicKey: response.hub.rosterSigningPublicKey,
        grant,
        roster: response.roster,
        // Introduce is ticked by default, so guests already in the roster are
        // accepted here; they still knock before they hold a device.
        peerGrants: introduceGuests({
          spokeId: selfMemberId,
          roster: response.roster.roster,
          grants: [],
          introduce: grant.items.includes("introduce"),
          confirmNewMembers: false,
        }).grants,
      },
    });
    this.#options.record({
      change: "joined-hub",
      actingPrincipal: principal,
      memberId: response.hub.memberId,
      sequence: response.roster.roster.sequence,
      items: grant.items,
    });
    return { status: "joined", rosterSequence: response.roster.roster.sequence, grant };
  }

  /** Only this host changes what its hub may do. */
  setGrant(
    grant: HubGrant,
    principal: AuditActingPrincipal,
  ):
    | { readonly status: "changed"; readonly grant: HubGrant }
    | { readonly status: "refused"; readonly kind: "not-a-spoke" | "hub-revoked" } {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#options.state.save({ ...state, link: { ...link, grant } });
    this.#options.record({
      change: "hub-grant-changed",
      actingPrincipal: principal,
      memberId: link.hubMemberId,
      items: grant.items,
    });
    return { status: "changed", grant };
  }

  /**
   * Leave revokes the hub principal, drops the grants this spoke gave, and
   * forgets the roster. It tells the hub when the hub is reachable, so the hub
   * drops this spoke from its next roster; this spoke's own threads, Projects,
   * and credentials are untouched.
   */
  async leave(
    principal: AuditActingPrincipal,
  ): Promise<
    | { readonly status: "left"; readonly hubNotified: boolean }
    | { readonly status: "refused"; readonly kind: "not-a-spoke" }
  > {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    let hubNotified = false;
    if (link.removed !== true) {
      // Marked before the first await: a guest admitted while the hub is
      // being told would hold a device no revocation below knows about.
      this.#options.state.save({ ...state, link: { ...link, leaving: true } });
      const identity = this.#options.identity();
      const body = JSON.stringify({ memberId: link.selfMemberId });
      const answer = await sendHubLinkRequest({
        transport: this.#options.transport,
        target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
        signHostPayload: identity.signing.signHostPayload,
        senderMemberId: String(link.selfMemberId),
        recipientMemberId: String(link.hubMemberId),
        method: "POST",
        path: "/api/hub/leave",
        body,
        now: this.#options.now(),
      });
      hubNotified = answer.status === "answered" && answer.response.ok;
    }
    // The link is read again: a roster that arrived while the hub was being
    // told may have changed which guest devices exist.
    const current = this.#options.state.load();
    this.#options.state.save({
      ...(current.hub === undefined ? {} : { hub: current.hub }),
      ...(current.pendingDeviceRevocations === undefined
        ? {}
        : { pendingDeviceRevocations: current.pendingDeviceRevocations }),
    });
    this.#revokeGuestDevices(
      current.link?.guestDevices ?? link.guestDevices ?? [],
      link.hubMemberId,
    );
    this.#pending = undefined;
    this.#options.record({
      change: "left-hub",
      actingPrincipal: principal,
      memberId: link.hubMemberId,
    });
    return { status: "left", hubNotified };
  }

  /**
   * Resolves a request that claims to come from the hub. It is the hub only if
   * it is signed with the key this spoke recorded when it joined, and only
   * while the hub principal has not been revoked.
   */
  authenticateHub(input: {
    readonly header: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }): HubRequestOutcome {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const verified = this.#verifier.verify({
      header: input.header,
      method: input.method,
      path: input.path,
      body: input.body,
      recipientMemberId: String(link.selfMemberId),
      publicKeyFor: (sender) =>
        sender === String(link.hubMemberId) ? link.hubIdentityPublicKey : undefined,
    });
    if (verified.status === "refused") return { status: "refused", kind: verified.kind };
    return { status: "hub", principal: { kind: "hub", memberId: link.hubMemberId } };
  }

  /**
   * Resolves a request that claims to come from another member of the hub.
   * Checked in this order, so the first failing reason is the one reported:
   * this host is a member of a hub; the sender is in the verified roster the
   * host holds; the key it presents is the one the roster fingerprints; the
   * request is signed with that key, fresh, and not seen before; the sender is
   * not the hub, a standby, or a guest, which never send delegated work; and
   * this host gave the sender a peer grant. The roster says who the hub
   * vouches for; only the peer grant says what the sender may do here.
   */
  authenticatePeer(input: {
    readonly header: string | null;
    readonly publicKey: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
  }): PeerRequestOutcome {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    if (input.header === null) return { status: "refused", kind: "missing" };
    const claimed = input.header.split(".")[1];
    if (claimed === undefined) return { status: "refused", kind: "malformed" };
    const roster = link.roster.roster;
    const member = roster.members.find((entry) => String(entry.memberId) === claimed);
    if (member === undefined || claimed === String(link.selfMemberId)) {
      return { status: "refused", kind: "not-in-roster" };
    }
    if (input.publicKey === null) return { status: "refused", kind: "unknown-sender" };
    if (publicKeyFingerprint(input.publicKey) !== member.identityKeyFingerprint) {
      return { status: "refused", kind: "key-mismatch" };
    }
    const verified = this.#verifier.verify({
      header: input.header,
      method: input.method,
      path: input.path,
      body: input.body,
      recipientMemberId: String(link.selfMemberId),
      publicKeyFor: (sender) => (sender === claimed ? (input.publicKey ?? undefined) : undefined),
    });
    if (verified.status === "refused") return { status: "refused", kind: verified.kind };
    if (member.role === "hub" || member.role === "standby-hub") {
      return { status: "refused", kind: "hub-cannot-delegate" };
    }
    const authorized = authorizePeer({
      roster,
      grants: link.peerGrants,
      memberId: member.memberId,
    });
    if (authorized.status === "refused") {
      return { status: "refused", kind: "no-peer-grant" };
    }
    return {
      status: "peer",
      principal: { kind: "peer", memberId: member.memberId },
      peer: { member: authorized.member, grant: authorized.grant },
      selfMemberId: link.selfMemberId,
    };
  }

  /**
   * The member and the grant this host holds for it right now, for a request
   * already authenticated that must still be allowed when its work starts.
   * Undefined once the host left the hub, the roster dropped the member, or
   * its peer grant was removed.
   */
  currentPeer(memberId: HubMemberId): AuthorizedPeer | undefined {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) return undefined;
    const authorized = authorizePeer({
      roster: link.roster.roster,
      grants: link.peerGrants,
      memberId,
    });
    return authorized.status === "authorized"
      ? { member: authorized.member, grant: authorized.grant }
      : undefined;
  }

  /**
   * The roster entry and the listener pin this host reaches a full member at.
   * Only a spoke, a standby, or the hub with a listener is dialled; a guest has
   * no listener, and a member the held roster does not list is not reachable.
   */
  memberTarget(memberId: string): MemberTarget {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const member = link.roster.roster.members.find((entry) => String(entry.memberId) === memberId);
    if (member === undefined) return { status: "refused", kind: "not-in-roster" };
    return { status: "member", self: link.selfMemberId, member };
  }

  /** Whether the hub's grant lets it use an item. */
  hubMayUse(item: HubGrantItem): ReturnType<typeof authorizeHubRequest> {
    return authorizeHubRequest({ grant: this.#options.state.load().link?.grant, item });
  }

  /**
   * A roster the hub sent. An older or equal one never replaces a newer one.
   * A newer one ends the grants this spoke gave to any member it no longer
   * lists, and one that no longer lists this spoke revokes the hub principal.
   */
  receiveRoster(candidate: SignedHubRoster): RosterReceipt {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    const decision = decideRosterReplacement({
      held: {
        latest: link.roster,
        ...(link.roster.signedBy.kind === "hub" ? { latestHubSigned: link.roster } : {}),
      },
      candidate,
      signatureVerified:
        candidate.signedBy.kind === "hub" &&
        verifySignature({
          payload: hubRosterSigningPayload(candidate.roster),
          signature: candidate.signature,
          publicKey: link.rosterSigningPublicKey,
        }),
      hubReachable: true,
    });
    if (decision.status === "refused") return decision;
    const { kept } = reconcileHeldGrants({
      grants: link.peerGrants,
      held: link.roster.roster,
      newer: candidate.roster,
    });
    const listsSelf = candidate.roster.members.some(
      (member) => String(member.memberId) === String(link.selfMemberId),
    );
    const listed = (memberId: HubMemberId) =>
      candidate.roster.members.some((member) => String(member.memberId) === String(memberId));
    // A member this spoke's person removed from an alert stays out while the
    // roster lists it; the entry goes once the roster stops listing it.
    const rejected = (link.rejectedMemberIds ?? []).filter(listed);
    // A spoke that ticked Introduce accepts a guest the verified roster adds;
    // one that did not leaves it unaccepted, and the guest's knock is refused.
    // With Confirm new members on the guest is held status-only.
    const introduced = introduceGuests({
      spokeId: link.selfMemberId,
      roster: {
        ...candidate.roster,
        members: candidate.roster.members.filter(
          (member) => !rejected.some((id) => String(id) === String(member.memberId)),
        ),
      },
      grants: kept,
      introduce: link.grant.items.includes("introduce"),
      confirmNewMembers: link.confirmNewMembers === true,
    });
    const guestDevices = link.guestDevices ?? [];
    // Every member a newer roster adds is raised here, from this spoke's own
    // comparison with the roster it held, so the hub cannot hide one.
    const heldIds = new Set(link.roster.roster.members.map((member) => String(member.memberId)));
    const added = listsSelf
      ? candidate.roster.members.filter(
          (member) =>
            !heldIds.has(String(member.memberId)) &&
            String(member.memberId) !== String(link.selfMemberId) &&
            member.role !== "hub",
        )
      : [];
    const raisedAt = decodeTimestamp(new Date(this.#options.now()).toISOString());
    const raised = added.map((member) => ({
      alertId: decodeAlertId(randomUUID()),
      memberId: member.memberId,
      name: member.name,
      role: member.role,
      identityKeyFingerprint: member.identityKeyFingerprint,
      raisedAt,
    }));
    const alerts = [...(link.alerts ?? []), ...raised].slice(-MAX_ALERTS);
    // A guest the roster no longer lists loses its device here. A spoke the
    // roster no longer lists is out: the hub principal is revoked and every
    // grant it gave ends, with the guest devices. Its threads, Projects, and
    // credentials stay.
    const droppedDevices = guestDevices.filter((entry) => !listsSelf || !listed(entry.memberId));
    const next: HubLinkState = listsSelf
      ? {
          ...link,
          roster: candidate,
          peerGrants: introduced.grants,
          guestDevices: guestDevices.filter((entry) => listed(entry.memberId)),
          alerts,
          rejectedMemberIds: rejected,
          // A dropped member loses any owner entry with its roster entry.
          ...(link.owners === undefined
            ? {}
            : { owners: link.owners.filter((owner) => listed(owner.memberId)) }),
        }
      : {
          ...link,
          roster: candidate,
          peerGrants: [],
          guestDevices: [],
          removed: true,
          owners: [],
        };
    this.#options.state.save({ ...state, link: next });
    this.#revokeGuestDevices(droppedDevices, link.hubMemberId);
    for (const alert of raised) {
      this.#options.record({
        change: "new-member-alerted",
        actingPrincipal: { kind: "hub", memberId: link.hubMemberId },
        memberId: alert.memberId,
        sequence: candidate.roster.sequence,
      });
    }
    this.#options.record({
      change: "roster-accepted",
      actingPrincipal: { kind: "hub", memberId: link.hubMemberId },
      memberId: link.hubMemberId,
      sequence: candidate.roster.sequence,
    });
    return { status: "accepted", sequence: candidate.roster.sequence, removed: !listsSelf };
  }

  /**
   * A guest asking to be admitted as a paired device here. The hub vouched for
   * its device key in the roster; this spoke checks that the roster it holds
   * lists the guest, that the key presented is that key (by fingerprint), that
   * the request is signed with it, and that this spoke accepted the guest:
   * Introduce was ticked when a verified roster first listed it. Anything else
   * is refused before a device is made. The device it gets is an ordinary
   * paired device; it carries no window authority and no hub grant.
   */
  admitGuest(input: {
    readonly header: string | null;
    readonly method: string;
    readonly path: string;
    readonly body: string;
    readonly request: HubGuestAdmissionRequest;
  }): GuestAdmission {
    this.settlePendingRevocations();
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true || link.leaving === true) {
      return { status: "refused", kind: "hub-revoked" };
    }
    const { request } = input;
    const listed = link.roster.roster.members.find(
      (member) => String(member.memberId) === String(request.memberId) && member.role === "guest",
    );
    if (listed === undefined) return { status: "refused", kind: "not-in-roster" };
    if (publicKeyFingerprint(request.devicePublicKey) !== listed.identityKeyFingerprint) {
      return { status: "refused", kind: "key-mismatch" };
    }
    const verified = this.#verifier.verify({
      header: input.header,
      method: input.method,
      path: input.path,
      body: input.body,
      recipientMemberId: String(link.selfMemberId),
      publicKeyFor: (sender) =>
        sender === String(request.memberId) ? request.devicePublicKey : undefined,
    });
    if (verified.status === "refused") return { status: "refused", kind: verified.kind };
    const grant = link.peerGrants.find(
      (entry) => String(entry.memberId) === String(request.memberId),
    );
    if (grant === undefined) return { status: "refused", kind: "guest-not-accepted" };
    // A guest held for Confirm new members has no device until it is confirmed.
    if (holdsOnlyStatusGrant(grant)) return { status: "refused", kind: "guest-not-confirmed" };
    const existing = link.guestDevices?.find(
      (entry) => String(entry.memberId) === String(request.memberId),
    );
    const devices = this.#options.devices();
    if (existing !== undefined) {
      // Admitted once is not admitted for good: a device unused for its
      // inactivity window expires, and the phone would keep a credential that
      // can never sign in. An expired or lost device is replaced; a revoked one
      // is the person's decision and stays refused.
      if (devices === undefined) return { status: "refused", kind: "devices-unavailable" };
      const lifecycle = devices.deviceLifecycle(existing.deviceId, this.#options.now());
      if (lifecycle === "revoked") return { status: "refused", kind: "device-revoked" };
      if (lifecycle === "active") {
        return {
          status: "admitted",
          spokeMemberId: link.selfMemberId,
          deviceId: existing.deviceId,
        };
      }
    }
    const own = readPrivateListener(this.#options.listener());
    if (own.status === "refused") return { status: "refused", kind: own.kind };
    if (devices === undefined) return { status: "refused", kind: "devices-unavailable" };
    const device = devices.admitIntroducedDevice({
      devicePublicKey: publicKeyPem(request.devicePublicKey),
      deviceLabel: request.deviceLabel,
      origin: own.origin,
      sourceClass: own.sourceClass,
    });
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        guestDevices: [
          ...(link.guestDevices ?? []).filter(
            (entry) => String(entry.memberId) !== String(request.memberId),
          ),
          { memberId: request.memberId, deviceId: device.deviceId },
        ],
      },
    });
    if (existing !== undefined) {
      try {
        devices.revokeDevice(existing.deviceId);
      } catch {
        // A device this host no longer holds leaves nothing to revoke.
      }
    }
    this.#options.record({
      change: "guest-admitted",
      actingPrincipal: { kind: "hub", memberId: link.hubMemberId },
      memberId: request.memberId,
      sequence: link.roster.roster.sequence,
    });
    return { status: "admitted", spokeMemberId: link.selfMemberId, deviceId: device.deviceId };
  }

  #revokeGuestDevices(
    entries: ReadonlyArray<{ readonly memberId: HubMemberId; readonly deviceId: string }>,
    hubMemberId: HubMemberId,
  ): void {
    this.#revokeOrKeepDevices(entries.map((entry) => entry.deviceId));
    for (const entry of entries) {
      this.#options.record({
        change: "guest-dropped",
        actingPrincipal: { kind: "hub", memberId: hubMemberId },
        memberId: entry.memberId,
      });
    }
  }

  #revokeOrKeepDevices(deviceIds: ReadonlyArray<string>): void {
    const devices = this.#options.devices();
    const unrevoked: string[] = [];
    for (const deviceId of deviceIds) {
      if (devices === undefined) {
        unrevoked.push(deviceId);
        continue;
      }
      try {
        devices.revokeDevice(deviceId);
      } catch {
        // A device already revoked, or one this host no longer holds, leaves nothing to revoke.
      }
    }
    // The device pairing runs with the private listener. A device left active
    // here would be usable once it starts, so its id is kept until it does.
    if (unrevoked.length > 0) {
      const state = this.#options.state.load();
      this.#options.state.save({
        ...state,
        pendingDeviceRevocations: [...(state.pendingDeviceRevocations ?? []), ...unrevoked],
      });
    }
  }

  /** Revokes the guest devices a dropped link could not revoke, as soon as the device pairing exists. */
  settlePendingRevocations(): void {
    const state = this.#options.state.load();
    const pending = state.pendingDeviceRevocations;
    if (pending === undefined || pending.length === 0) return;
    const devices = this.#options.devices();
    if (devices === undefined) return;
    for (const deviceId of pending) {
      try {
        devices.revokeDevice(deviceId);
      } catch {
        // A device already revoked, or one this host no longer holds, leaves nothing to revoke.
      }
    }
    const { pendingDeviceRevocations: _settled, ...rest } = state;
    this.#options.state.save(rest);
  }

  /** The status read the hub's Status item allows. */
  readStatus(): HubSpokeStatus | undefined {
    const link = this.#options.state.load().link;
    if (link === undefined) return undefined;
    return {
      memberId: link.selfMemberId,
      name: this.#options.identity().displayName,
      serverBuildVersion: this.#options.serverBuildVersion,
      rosterSequence: link.roster.roster.sequence,
    };
  }
}
