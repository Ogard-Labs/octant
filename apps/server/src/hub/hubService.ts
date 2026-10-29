// The hub role of a host: it keeps the roster, signs it with its own key, makes
// join codes, admits a member that paired with it, and removes one. Turning
// the role on or off, making a code, and removing a member are the loopback
// administration channel's alone (see hubAdministrationRoutes); a member's
// join and leave arrive signed with its identity key (see hubLinkRoutes).

import {
  EventActorDeviceId,
  HubMemberId,
  NO_LISTENER_PIN,
  encodeSignedHubRoster,
  type AuditActingPrincipal,
  type HubHeartbeatResponse,
  type HubJoinRequest,
  type HubJoinResponse,
  type HubMembershipChangedPayload,
  type HubStandInHandback,
  type OwnerCandidate,
  type OwnerListEntry,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import type { StableHostId } from "@octant/contracts/remote-access";
import {
  buildPairingCode,
  hubRosterSigningPayload,
  decideStandInHandback,
  mergeStandInMembership,
  orderStandbys,
} from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import type { HostSigningPort } from "../remote/remoteProtocolService";
import { listenerPinFromDigest, publicKeyFingerprint } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import { memberOrigin } from "./memberOrigin";
import type { HostOwnerRecord, HubSideState, HubStatePort } from "./hubStateStore";
import {
  addOwnerRecords,
  isUnlockPublicKey,
  ownerListView,
  readRosterOwners,
  withoutOwner,
  type OwnerCandidateView,
  type OwnerChange,
} from "./ownerRecords";
import type { HubTransport } from "./pinnedHubTransport";
import { originIsPrivate, readPrivateListener } from "./privateListenerReading";
import type { RosterSigningKeyStore } from "./rosterSigningKey";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);
const DEFAULT_FAILOVER_AFTER_SECONDS = 300;

export interface HubHostIdentity {
  readonly hostId: StableHostId;
  readonly displayName: string;
  readonly signing: HostSigningPort;
}

/** What the hub needs of its own pairing: a ticket for a code, and the device an approved one made. */
export interface HubPairingPort {
  readonly createTicket: (sourceClass: "lan-private" | "tailscale") => {
    readonly ticketId: string;
    readonly ticketProof: string;
    readonly expiresAt: number;
  };
  readonly approvedDeviceFor: (ticket: {
    readonly ticketId: string;
    readonly ticketProof: string;
  }) => string | undefined;
  readonly revokeDevice: (deviceId: string) => void;
  /** The key fingerprint of a device this hub paired, so a guest's identity key can be tied to it. */
  readonly deviceKeyFingerprint: (deviceId: string) => string | undefined;
  /** False for a device that is revoked, expired, or not held here. */
  readonly deviceActive: (deviceId: string) => boolean;
}

export interface HubServiceOptions {
  readonly state: HubStatePort;
  readonly rosterKey: RosterSigningKeyStore;
  readonly identity: () => HubHostIdentity;
  readonly listener: () => PrivateListenerHostStatus;
  readonly pairing: () => HubPairingPort | undefined;
  readonly transport: HubTransport;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
}

const hubMemberId = (identity: HubHostIdentity) => decodeMemberId(String(identity.hostId));

/** The port a member's listener origin names, which the hub states in the roster instead of trusting a claim. */
export function listenerPortOf(origin: string | undefined): { readonly listenerPort?: number } {
  if (origin === undefined) return {};
  const port = new URL(origin).port;
  return port === "" ? {} : { listenerPort: Number(port) };
}

export type HubRoleRefusal =
  | "listener-not-running"
  | "listener-not-private"
  | "listener-has-no-pin"
  | "hub-role-off";

export type HubRoleOutcome =
  | { readonly status: "enabled"; readonly roster: SignedHubRoster }
  | { readonly status: "disabled" }
  | { readonly status: "refused"; readonly kind: HubRoleRefusal };

export type JoinCodeOutcome =
  | {
      readonly status: "minted";
      readonly code: string;
      readonly expiresAt: number;
      readonly owner: boolean;
    }
  | { readonly status: "refused"; readonly kind: HubRoleRefusal | "pairing-unavailable" };

export type JoinOutcome =
  | { readonly status: "joined"; readonly response: HubJoinResponse }
  | {
      readonly status: "refused";
      readonly kind:
        | "hub-role-off"
        | "identity-mismatch"
        | "member-origin-not-private"
        | "not-a-join-code"
        | "not-approved"
        | "already-member"
        | "unlock-key-invalid"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin";
    };

export type RemoveOutcome =
  | { readonly status: "removed"; readonly sequence: number }
  | {
      readonly status: "refused";
      readonly kind: "hub-role-off" | "not-a-member" | "cannot-remove-the-hub";
    };

export type StandbyOrderOutcome =
  | { readonly status: "ordered"; readonly roster: SignedHubRoster }
  | {
      readonly status: "refused";
      readonly kind:
        | "hub-role-off"
        | "duplicate-member"
        | "unknown-member"
        | "not-a-spoke"
        | "member-unreachable"
        | "standby-not-granted";
      readonly memberId?: string;
    };

export type HandbackOutcome =
  | { readonly status: "merged"; readonly roster: SignedHubRoster }
  | {
      readonly status: "refused";
      readonly kind: "hub-role-off" | "not-a-named-standby" | "invalid-member" | "handback-invalid";
    };

export type PromoteOutcome =
  | { readonly status: "promoted"; readonly roster: SignedHubRoster }
  | {
      readonly status: "refused";
      readonly kind:
        | "already-hub"
        | "not-a-spoke"
        | "not-a-named-standby"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin";
    };

/** The most removals the hub remembers for merging a standby's changes back. */
const MAX_REMEMBERED_REMOVALS = 256;

export class HubService {
  readonly #options: HubServiceOptions;

  constructor(options: HubServiceOptions) {
    this.#options = options;
  }

  /** Whether the hub role is on, and the roster it holds. */
  status(): { readonly enabled: boolean; readonly roster?: SignedHubRoster } {
    const hub = this.#options.state.load().hub;
    return {
      enabled: hub?.enabled === true,
      ...(hub?.roster === undefined ? {} : { roster: hub.roster }),
    };
  }

  /**
   * The key the hub trusts for a member's requests: the one the member joined
   * with. A member this hub holds no key for, such as one a promoted standby
   * carried over, may present its key; it is trusted only if its fingerprint is
   * the one the hub's own signed roster lists for that member.
   */
  memberKey(memberId: string, presentedKey?: string): string | undefined {
    const hub = this.#options.state.load().hub;
    if (hub?.enabled !== true) return undefined;
    const recorded = hub.members.find((member) => String(member.memberId) === memberId);
    if (recorded !== undefined) return recorded.identityPublicKey;
    const listed = hub.roster?.roster.members.find(
      (member) => String(member.memberId) === memberId,
    );
    return listed !== undefined &&
      listed.role !== "hub" &&
      presentedKey !== undefined &&
      publicKeyFingerprint(presentedKey) === listed.identityKeyFingerprint
      ? presentedKey
      : undefined;
  }

  /**
   * What the hub answers a member that asks whether it is there: its latest
   * roster, and the identity facts a spoke pins when it accepts a promoted hub.
   */
  heartbeat(): HubHeartbeatResponse | undefined {
    const hub = this.#options.state.load().hub;
    if (hub?.enabled !== true || hub.roster === undefined) return undefined;
    const reading = readPrivateListener(this.#options.listener());
    const identity = this.#options.identity();
    return {
      standingIn: false,
      roster: hub.roster,
      wakeGeneration: hub.wake?.generation ?? 0,
      ...(reading.status === "refused"
        ? {}
        : {
            hub: {
              memberId: hubMemberId(identity),
              name: identity.displayName,
              identityPublicKey: identity.signing.hostPublicKey,
              identityKeyFingerprint: identity.signing.hostKeyFingerprint,
              rosterSigningPublicKey: this.#options.rosterKey.signer().publicKey,
              listenerPin: reading.pinDigest,
            },
          }),
    };
  }

  /**
   * The key a guest's request to the hub is checked against: the device key it
   * joined with. A spoke, a standby, or an unknown id has none here, so a
   * member that is not a guest cannot use the guest routes.
   */
  guestKey(memberId: string): string | undefined {
    const hub = this.#options.state.load().hub;
    if (hub?.enabled !== true) return undefined;
    const listed = hub.roster?.roster.members.find(
      (member) => String(member.memberId) === memberId,
    );
    return listed?.role === "guest" ? this.memberKey(memberId) : undefined;
  }

  /** The current signed roster, for a guest that has proved it holds its key. */
  rosterForGuest(): SignedHubRoster | undefined {
    const hub = this.#options.state.load().hub;
    return hub?.enabled === true ? hub.roster : undefined;
  }

  hubMemberId(): string {
    return String(hubMemberId(this.#options.identity()));
  }

  enable(principal: AuditActingPrincipal): HubRoleOutcome {
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled === true) {
      return hub.roster === undefined
        ? { status: "refused", kind: "hub-role-off" }
        : { status: "enabled", roster: hub.roster };
    }
    const identity = this.#options.identity();
    const self = this.#hubMember(identity, reading);
    // A hub turned back on keeps the members it had and re-signs with the hub
    // entry as it stands now, because its listener may have moved.
    const previous = hub?.roster?.roster;
    const roster = this.#sign({
      sequence: (previous?.sequence ?? 0) + 1,
      members: [self, ...(previous?.members.filter((member) => member.role !== "hub") ?? [])],
      standbyOrder: previous?.standbyOrder ?? [],
      failoverAfterSeconds: previous?.failoverAfterSeconds ?? DEFAULT_FAILOVER_AFTER_SECONDS,
    });
    this.#options.state.save({
      ...current,
      hub: {
        enabled: true,
        roster,
        members: hub?.members ?? [],
        joinTickets: [],
        ...(hub?.owners === undefined ? {} : { owners: hub.owners }),
      },
    });
    this.#options.record({
      change: "hub-role-enabled",
      actingPrincipal: principal,
      sequence: roster.roster.sequence,
    });
    return { status: "enabled", roster };
  }

  disable(principal: AuditActingPrincipal): HubRoleOutcome {
    const current = this.#options.state.load();
    if (current.hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    // Members and the roster stay, so turning the role back on resumes them;
    // outstanding join codes do not.
    this.#options.state.save({
      ...current,
      hub: { ...current.hub, enabled: false, joinTickets: [] },
    });
    this.#options.record({ change: "hub-role-disabled", actingPrincipal: principal });
    return { status: "disabled" };
  }

  /**
   * A join code for the person to type or scan on the device that is joining.
   * The loopback channel's call is the window's own act and is not journaled
   * here; an owner device's call passes its principal and is.
   */
  mintJoinCode(
    input: { readonly owner: boolean },
    principal?: AuditActingPrincipal,
  ): JoinCodeOutcome {
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    const pairing = this.#options.pairing();
    if (pairing === undefined) return { status: "refused", kind: "pairing-unavailable" };
    const ticket = pairing.createTicket(reading.sourceClass);
    const pin = this.#options.listener().tlsPin;
    if (pin === null) return { status: "refused", kind: "listener-has-no-pin" };
    const built = buildPairingCode({
      origin: reading.origin,
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
      pin,
    });
    if (built.status === "refused") return { status: "refused", kind: "listener-not-private" };
    this.#options.state.save({
      ...current,
      hub: {
        ...hub,
        joinTickets: [...hub.joinTickets, { ticketId: ticket.ticketId, owner: input.owner }],
      },
    });
    if (principal !== undefined) {
      this.#options.record({ change: "join-code-minted", actingPrincipal: principal });
    }
    return {
      status: "minted",
      code: built.code,
      expiresAt: ticket.expiresAt,
      owner: input.owner,
    };
  }

  /** What the owner routes check a request against: the roster this hub signed and its own owner list. */
  ownerContext():
    | {
        readonly roster: SignedHubRoster["roster"];
        readonly owners: ReadonlyArray<HostOwnerRecord>;
        /** Members whose paired device on this hub is revoked or unknown: they hold no owner powers here. */
        readonly inactiveDeviceMemberIds: ReadonlyArray<string>;
      }
    | undefined {
    const hub = this.#options.state.load().hub;
    if (hub?.roster === undefined) return undefined;
    const pairing = this.#options.pairing();
    return {
      roster: hub.roster.roster,
      owners: hub.owners ?? [],
      // A failed lookup counts as inactive, so owner powers fail closed.
      inactiveDeviceMemberIds: hub.members
        .filter(
          (member) =>
            member.deviceId === undefined || pairing?.deviceActive(member.deviceId) !== true,
        )
        .map((member) => String(member.memberId)),
    };
  }

  listOwners(): ReadonlyArray<OwnerListEntry> {
    return ownerListView(this.#options.state.load().hub?.owners ?? []);
  }

  /** Roster members that list an unlock key but are not owners here, for the person to confirm. */
  ownerCandidates(): ReadonlyArray<OwnerCandidateView> {
    const hub = this.#options.state.load().hub;
    if (hub?.roster === undefined) return [];
    return readRosterOwners({
      roster: hub.roster.roster,
      selfMemberId: this.hubMemberId(),
      owners: hub.owners ?? [],
    }).candidates;
  }

  /**
   * Adds devices to this hub's owner list. Only a window on this host, or an
   * owner already on the list with a fresh unlock, reaches this; the caller
   * has checked which.
   */
  addOwners(
    candidates: ReadonlyArray<OwnerCandidate>,
    principal: AuditActingPrincipal,
  ): OwnerChange {
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.roster === undefined) return { status: "refused", kind: "hub-role-off" };
    const added = addOwnerRecords({
      roster: hub.roster.roster,
      selfMemberId: this.hubMemberId(),
      owners: hub.owners ?? [],
      candidates,
    });
    if (added.status === "refused") return added;
    this.#options.state.save({ ...current, hub: { ...hub, owners: added.owners } });
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
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub === undefined) return { status: "refused", kind: "hub-role-off" };
    const owners = hub.owners ?? [];
    const target = owners.find((owner) => String(owner.memberId) === memberId);
    if (target === undefined) return { status: "refused", kind: "not-an-owner", memberId };
    const remaining = withoutOwner(owners, memberId);
    this.#options.state.save({ ...current, hub: { ...hub, owners: remaining } });
    this.#options.record({
      change: "owner-removed",
      actingPrincipal: principal,
      memberId: target.memberId,
    });
    return { status: "changed", owners: ownerListView(remaining) };
  }

  /**
   * Admits the member that paired with this hub's join code. The caller has
   * checked the request's signature against the key the request names; that
   * only proves the member holds the key. The ticket proof, the person's
   * approval on this hub, and the key's fingerprint are what tie the key to the
   * device the person approved.
   */
  acceptJoin(request: HubJoinRequest): JoinOutcome {
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    if (publicKeyFingerprint(request.identityPublicKey) !== request.member.identityKeyFingerprint) {
      return { status: "refused", kind: "identity-mismatch" };
    }
    const asGuest = request.asGuest === true;
    // A guest runs no listener; any other member must name a private one.
    if (
      !asGuest &&
      !(request.listenerOrigin !== undefined && originIsPrivate(request.listenerOrigin))
    ) {
      return { status: "refused", kind: "member-origin-not-private" };
    }
    const ticket = hub.joinTickets.find((entry) => entry.ticketId === request.ticketId);
    if (ticket === undefined) return { status: "refused", kind: "not-a-join-code" };
    const deviceId = this.#options.pairing()?.approvedDeviceFor({
      ticketId: request.ticketId,
      ticketProof: request.ticketProof,
    });
    if (deviceId === undefined) return { status: "refused", kind: "not-approved" };
    const roster = hub.roster.roster;
    if (
      roster.members.some((member) => String(member.memberId) === String(request.member.memberId))
    ) {
      return { status: "refused", kind: "already-member" };
    }
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    // A guest's identity key is the device key the person approved on this
    // hub, so a spoke can later tie the roster entry to that device's key.
    if (
      asGuest &&
      this.#options.pairing()?.deviceKeyFingerprint(deviceId) !==
        request.member.identityKeyFingerprint
    ) {
      return { status: "refused", kind: "identity-mismatch" };
    }

    // The roster states what the hub checked, not what the member claimed: a
    // guest has no listener, no names, no addresses, and no owner mark.
    const { listenerPort: _claimedPort, ...claimed } = request.member;
    // Only an owner code adds the joiner to this hub's owner list, with the
    // unlock key it presented; the roster's owner mark alone never does. The
    // roster entry then carries that key, signed by the hub, so a spoke's
    // person can confirm it by fingerprint instead of pasting it.
    const presented = ticket.owner ? request.ownerUnlockPublicKey : undefined;
    if (presented !== undefined && !isUnlockPublicKey(presented)) {
      return { status: "refused", kind: "unlock-key-invalid" };
    }
    const listedKey = presented === undefined ? {} : { ownerUnlockPublicKey: presented };
    const member: RosterMember = asGuest
      ? {
          ...claimed,
          role: "guest",
          listenerPin: NO_LISTENER_PIN,
          privateNames: [],
          addresses: [],
          owner: false,
          ...listedKey,
        }
      : {
          ...claimed,
          role: "spoke",
          ...listenerPortOf(request.listenerOrigin),
          owner: ticket.owner,
          ...listedKey,
        };
    const owners: ReadonlyArray<HostOwnerRecord> =
      presented === undefined
        ? (hub.owners ?? [])
        : [
            ...(hub.owners ?? []),
            {
              memberId: member.memberId,
              name: member.name,
              identityKeyFingerprint: member.identityKeyFingerprint,
              unlockKeyFingerprint: publicKeyFingerprint(presented),
              unlockPublicKey: presented,
            },
          ];
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members: [...roster.members, member],
    });
    this.#options.state.save({
      ...current,
      hub: {
        ...hub,
        ...(owners.length === 0 ? {} : { owners }),
        roster: signed,
        members: [
          ...hub.members,
          {
            memberId: member.memberId,
            identityPublicKey: request.identityPublicKey,
            deviceId,
            ...(asGuest || request.listenerOrigin === undefined
              ? {}
              : { listenerOrigin: request.listenerOrigin }),
          },
        ],
        joinTickets: hub.joinTickets.filter((entry) => entry.ticketId !== request.ticketId),
      },
    });
    this.#options.record({
      change: "member-added",
      actingPrincipal: { kind: "remote-device", deviceId: decodeDeviceId(deviceId) },
      memberId: member.memberId,
      sequence: signed.roster.sequence,
    });
    if (presented !== undefined) {
      this.#options.record({
        change: "owner-added",
        actingPrincipal: { kind: "remote-device", deviceId: decodeDeviceId(deviceId) },
        memberId: member.memberId,
      });
    }
    void this.#publish(signed, hub, roster.members, []);
    const identity = this.#options.identity();
    return {
      status: "joined",
      response: {
        hub: {
          memberId: hubMemberId(identity),
          name: identity.displayName,
          identityPublicKey: identity.signing.hostPublicKey,
          identityKeyFingerprint: identity.signing.hostKeyFingerprint,
          rosterSigningPublicKey: this.#options.rosterKey.signer().publicKey,
          listenerPin: reading.pinDigest,
        },
        roster: signed,
      },
    };
  }

  /** Remove runs on the hub: it revokes the member's device and drops it from the next roster. */
  async removeMember(
    input: { readonly memberId: string },
    principal: AuditActingPrincipal,
  ): Promise<RemoveOutcome> {
    return this.#drop(input.memberId, "member-removed", principal, true);
  }

  /**
   * A member told the hub it left, signed with the key it joined with. The hub
   * drops it from the next roster and revokes its device, acting for that
   * member's device.
   */
  async receiveLeave(memberId: string): Promise<RemoveOutcome> {
    const hub = this.#options.state.load().hub;
    const record = hub?.members.find((member) => String(member.memberId) === memberId);
    const listed = hub?.roster?.roster.members.find(
      (member) => String(member.memberId) === memberId,
    );
    if (record === undefined && listed === undefined) {
      return { status: "refused", kind: "not-a-member" };
    }
    return this.#drop(
      memberId,
      "member-left",
      record?.deviceId === undefined
        ? { kind: "peer", memberId: decodeMemberId(memberId) }
        : { kind: "remote-device", deviceId: decodeDeviceId(record.deviceId) },
      false,
    );
  }

  /**
   * Names the standby hubs, in order. Each named spoke is asked, over a signed
   * request, whether its person ticked Standby; the order changes only if every
   * one says yes. The order is the hub's alone: a standby that stands in cannot
   * change it (decision H10).
   */
  async setStandbyOrder(
    memberIds: ReadonlyArray<HubMemberId>,
    principal: AuditActingPrincipal,
  ): Promise<StandbyOrderOutcome> {
    const before = this.#options.state.load().hub;
    if (before?.enabled !== true || before.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    const checked = orderStandbys({ roster: before.roster.roster, memberIds });
    if (checked.status === "refused") return checked;
    const identity = this.#options.identity();
    for (const id of memberIds) {
      const member = before.roster.roster.members.find(
        (entry) => String(entry.memberId) === String(id),
      );
      const origin =
        before.members.find((record) => String(record.memberId) === String(id))?.listenerOrigin ??
        (member === undefined ? undefined : memberOrigin(member));
      if (member === undefined || origin === undefined) {
        return { status: "refused", kind: "member-unreachable", memberId: String(id) };
      }
      const answer = await sendHubLinkRequest({
        transport: this.#options.transport,
        target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
        signHostPayload: identity.signing.signHostPayload,
        senderMemberId: String(hubMemberId(identity)),
        recipientMemberId: String(id),
        method: "PUT",
        path: "/api/hub/standby",
        body: "{}",
        now: this.#options.now(),
      });
      if (answer.status === "unreachable") {
        return { status: "refused", kind: "member-unreachable", memberId: String(id) };
      }
      if (answer.response.status === 403) {
        return { status: "refused", kind: "standby-not-granted", memberId: String(id) };
      }
      if (!answer.response.ok) {
        return { status: "refused", kind: "member-unreachable", memberId: String(id) };
      }
    }
    // The roster is read again: members may have joined or left while the
    // spokes were being asked, and their changes must not be overwritten.
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    const ordering = orderStandbys({ roster: hub.roster.roster, memberIds });
    if (ordering.status === "refused") return ordering;
    const signed = this.#sign(ordering.roster);
    this.#options.state.save({ ...current, hub: { ...hub, roster: signed } });
    this.#options.record({
      change: "standby-order-changed",
      actingPrincipal: principal,
      memberIds,
      sequence: signed.roster.sequence,
    });
    await this.#publish(signed, hub, signed.roster.members, []);
    return { status: "ordered", roster: signed };
  }

  /**
   * A standby that stood in hands back the membership changes it made. The
   * hub's next signed roster includes them, and a member either side removed
   * stays removed. Only a standby the hub's roster names is heard, so a spoke
   * that was never named cannot add or remove anyone this way.
   */
  async receiveHandback(
    senderMemberId: string,
    handback: HubStandInHandback,
  ): Promise<HandbackOutcome> {
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    const roster = hub.roster.roster;
    const sender = roster.members.find((member) => String(member.memberId) === senderMemberId);
    if (
      sender?.role !== "standby-hub" ||
      !roster.standbyOrder.some((id) => String(id) === senderMemberId)
    ) {
      return { status: "refused", kind: "not-a-named-standby" };
    }
    // The hub signs the merge, so a standby that names the hub or a standby in
    // its removals, or adds anything but a spoke, is refused whole.
    const decision = decideStandInHandback({
      hub: roster,
      senderMemberId: sender.memberId,
      standby: {
        sequence: handback.sequence,
        added: handback.added.map((entry) => entry.member),
        removed: handback.removed,
      },
    });
    if (decision.status === "refused") {
      this.#options.record({
        change: "stand-in-refused",
        actingPrincipal: { kind: "hub", memberId: sender.memberId },
        memberId: sender.memberId,
        sequence: roster.sequence,
      });
      return decision;
    }
    // The roster states what the hub checked: a standby's claim of an owner
    // mark, an unlock key, or a port the origin does not carry is not kept.
    const added: Array<{
      readonly member: RosterMember;
      readonly origin: string;
      readonly key: string;
    }> = [];
    for (const entry of handback.added) {
      if (
        entry.member.role !== "spoke" ||
        publicKeyFingerprint(entry.identityPublicKey) !== entry.member.identityKeyFingerprint ||
        !originIsPrivate(entry.listenerOrigin)
      ) {
        return { status: "refused", kind: "invalid-member" };
      }
      const { listenerPort: _port, ownerUnlockPublicKey: _unlock, ...claimed } = entry.member;
      added.push({
        member: { ...claimed, owner: false, ...listenerPortOf(entry.listenerOrigin) },
        origin: entry.listenerOrigin,
        key: entry.identityPublicKey,
      });
    }
    const merged = mergeStandInMembership({
      hub: roster,
      hubRemovedSinceBase: (hub.removals ?? [])
        .filter((removal) => removal.sequence > handback.baseSequence)
        .map((removal) => removal.memberId),
      standby: {
        sequence: handback.sequence,
        added: added.map((entry) => entry.member),
        removed: handback.removed,
      },
    });
    const kept = (memberId: string) =>
      merged.members.some((member) => String(member.memberId) === memberId);
    const dropped = roster.members.filter((member) => !kept(String(member.memberId)));
    for (const member of dropped) {
      this.#revokeMemberDevice(
        hub.members.find((record) => String(record.memberId) === String(member.memberId))?.deviceId,
      );
    }
    const known = new Set(hub.members.map((record) => String(record.memberId)));
    const signed = this.#sign(merged);
    const nextHub: HubSideState = {
      ...hub,
      roster: signed,
      members: [
        ...hub.members.filter((record) => kept(String(record.memberId))),
        ...added
          .filter(
            (entry) =>
              kept(String(entry.member.memberId)) && !known.has(String(entry.member.memberId)),
          )
          .map((entry) => ({
            memberId: entry.member.memberId,
            identityPublicKey: entry.key,
            listenerOrigin: entry.origin,
          })),
      ],
      ...(hub.owners === undefined
        ? {}
        : { owners: hub.owners.filter((owner) => kept(String(owner.memberId))) }),
      removals: [
        ...(hub.removals ?? []),
        ...dropped.map((member) => ({
          memberId: member.memberId,
          sequence: signed.roster.sequence,
        })),
      ].slice(-MAX_REMEMBERED_REMOVALS),
    };
    this.#options.state.save({ ...current, hub: nextHub });
    this.#options.record({
      change: "stand-in-merged",
      actingPrincipal: { kind: "hub", memberId: sender.memberId },
      memberId: sender.memberId,
      sequence: signed.roster.sequence,
    });
    // Members that were removed are told by the roster that no longer lists them.
    await this.#publish(signed, nextHub, [...roster.members, ...added.map((e) => e.member)], []);
    return { status: "merged", roster: signed };
  }

  /**
   * Replaces the hub for good: a named standby, on its own host and at the
   * person's confirmation, becomes the hub. The old hub leaves the roster, the
   * standbys are cleared, and the roster is signed with this host's own key. No
   * member follows by itself: each spoke's person accepts the new hub in their
   * own window (decision H11).
   */
  promote(principal: AuditActingPrincipal): PromoteOutcome {
    const current = this.#options.state.load();
    if (current.hub?.enabled === true) return { status: "refused", kind: "already-hub" };
    const link = current.link;
    if (link === undefined || link.removed === true) {
      return { status: "refused", kind: "not-a-spoke" };
    }
    const selfId = String(link.selfMemberId);
    const anchor = link.roster.signedBy.kind === "hub" ? link.roster : link.hubSignedRoster;
    const named =
      anchor !== undefined &&
      anchor.roster.standbyOrder.some((id) => String(id) === selfId) &&
      anchor.roster.members.some(
        (member) => String(member.memberId) === selfId && member.role === "standby-hub",
      );
    if (!named) return { status: "refused", kind: "not-a-named-standby" };
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    const held = link.roster.roster;
    const others = held.members
      .filter((member) => member.role !== "hub" && String(member.memberId) !== selfId)
      .map(
        (member): RosterMember =>
          member.role === "standby-hub" ? { ...member, role: "spoke" } : member,
      );
    const roster = this.#sign({
      sequence: held.sequence + 1,
      members: [this.#hubMember(this.#options.identity(), reading), ...others],
      standbyOrder: [],
      failoverAfterSeconds: held.failoverAfterSeconds,
    });
    // Guests this host admitted as a spoke are not a hub's to keep: each guest
    // knocks again on the spokes that accept it.
    for (const guest of link.guestDevices ?? []) this.#revokeMemberDevice(guest.deviceId);
    const owners = (link.owners ?? []).filter((owner) =>
      others.some((member) => String(member.memberId) === String(owner.memberId)),
    );
    const { link: _link, ...rest } = current;
    this.#options.state.save({
      ...rest,
      hub: {
        enabled: true,
        roster,
        members: (link.standIn?.added ?? [])
          .filter((entry) =>
            others.some((member) => String(member.memberId) === String(entry.member.memberId)),
          )
          .map((entry) => ({
            memberId: entry.member.memberId,
            identityPublicKey: entry.identityPublicKey,
            deviceId: entry.deviceId,
            listenerOrigin: entry.listenerOrigin,
          })),
        joinTickets: [],
        ...(owners.length === 0 ? {} : { owners }),
      },
    });
    this.#options.record({
      change: "hub-promoted",
      actingPrincipal: principal,
      memberId: link.selfMemberId,
      sequence: roster.roster.sequence,
    });
    return { status: "promoted", roster };
  }

  async #drop(
    memberId: string,
    change: "member-removed" | "member-left",
    principal: AuditActingPrincipal,
    tellMember: boolean,
  ): Promise<RemoveOutcome> {
    const current = this.#options.state.load();
    const hub = current.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    const roster = hub.roster.roster;
    const entry = roster.members.find((member) => String(member.memberId) === memberId);
    const record = hub.members.find((member) => String(member.memberId) === memberId);
    if (entry === undefined) return { status: "refused", kind: "not-a-member" };
    if (entry.role === "hub") return { status: "refused", kind: "cannot-remove-the-hub" };
    this.#revokeMemberDevice(record?.deviceId);
    const members = roster.members.filter((member) => String(member.memberId) !== memberId);
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members,
      standbyOrder: roster.standbyOrder.filter((id) => String(id) !== memberId),
    });
    this.#options.state.save({
      ...current,
      hub: {
        ...hub,
        roster: signed,
        members: hub.members.filter((member) => String(member.memberId) !== memberId),
        // A removed member loses its owner powers here with the roster entry.
        ...(hub.owners === undefined ? {} : { owners: withoutOwner(hub.owners, memberId) }),
        removals: [
          ...(hub.removals ?? []),
          { memberId: entry.memberId, sequence: signed.roster.sequence },
        ].slice(-MAX_REMEMBERED_REMOVALS),
      },
    });
    this.#options.record({
      change,
      actingPrincipal: principal,
      memberId: entry.memberId,
      sequence: signed.roster.sequence,
    });
    // The removed member learns of its removal from the roster that no longer
    // lists it, so it is told too. A member that left already knows.
    await this.#publish(signed, hub, roster.members, tellMember ? [] : [memberId]);
    return { status: "removed", sequence: signed.roster.sequence };
  }

  #revokeMemberDevice(deviceId: string | undefined): void {
    if (deviceId === undefined) return;
    try {
      this.#options.pairing()?.revokeDevice(deviceId);
    } catch {
      // A device already revoked, or one the host no longer holds, leaves nothing to revoke.
    }
  }

  /**
   * Sends the roster to the listed members that run a listener the hub can
   * reach, standbys included. A member's origin is the one it joined with, or
   * the one its roster entry names when the hub never held it. Failures are not
   * retried here: a member catches up on its next heartbeat.
   */
  async #publish(
    signed: SignedHubRoster,
    hub: HubSideState,
    recipients: ReadonlyArray<RosterMember>,
    skip: ReadonlyArray<string>,
  ): Promise<void> {
    const identity = this.#options.identity();
    const body = JSON.stringify(encodeSignedHubRoster(signed));
    const targets = recipients.filter(
      (member) =>
        member.role !== "hub" && member.role !== "guest" && !skip.includes(String(member.memberId)),
    );
    await Promise.allSettled(
      targets.map(async (member) => {
        const origin =
          hub.members.find((record) => String(record.memberId) === String(member.memberId))
            ?.listenerOrigin ?? memberOrigin(member);
        if (origin === undefined) return;
        await sendHubLinkRequest({
          transport: this.#options.transport,
          target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
          signHostPayload: identity.signing.signHostPayload,
          senderMemberId: String(hubMemberId(identity)),
          recipientMemberId: String(member.memberId),
          method: "PUT",
          path: "/api/hub/roster",
          body,
          now: this.#options.now(),
        });
      }),
    );
  }

  #hubMember(
    identity: HubHostIdentity,
    reading: Extract<ReturnType<typeof readPrivateListener>, { readonly status: "private" }>,
  ): RosterMember {
    return {
      memberId: hubMemberId(identity),
      name: identity.displayName,
      role: "hub",
      identityKeyFingerprint: identity.signing.hostKeyFingerprint,
      listenerPin: reading.pinDigest,
      privateNames: reading.privateNames,
      addresses: reading.addresses,
      ...(reading.port === undefined ? {} : { listenerPort: reading.port }),
      owner: false,
    };
  }

  #sign(roster: SignedHubRoster["roster"]): SignedHubRoster {
    const identity = this.#options.identity();
    const signer = this.#options.rosterKey.signer();
    return {
      roster,
      signedBy: { kind: "hub", memberId: hubMemberId(identity) },
      signature: signer.sign(hubRosterSigningPayload(roster)),
    };
  }
}
