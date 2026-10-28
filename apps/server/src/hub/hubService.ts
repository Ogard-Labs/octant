// The hub role of a host: it keeps the roster, signs it with its own key, makes
// join codes, admits a member that paired with it, and removes one. Turning
// the role on or off, making a code, and removing a member are the loopback
// administration channel's alone (see hubAdministrationRoutes); a member's
// join and leave arrive signed with its identity key (see hubLinkRoutes).

import {
  EventActorDeviceId,
  HubMemberId,
  encodeSignedHubRoster,
  type AuditActingPrincipal,
  type HubJoinRequest,
  type HubJoinResponse,
  type HubMembershipChangedPayload,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import type { StableHostId } from "@octant/contracts/remote-access";
import { buildPairingCode, hubRosterSigningPayload } from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import type { HostSigningPort } from "../remote/remoteProtocolService";
import { listenerPinFromDigest, publicKeyFingerprint } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import type { HubSideState, HubStatePort } from "./hubStateStore";
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

  /** The key the hub trusts for a member's requests: the one the member joined with. */
  memberKey(memberId: string): string | undefined {
    const hub = this.#options.state.load().hub;
    if (hub?.enabled !== true) return undefined;
    return hub.members.find((member) => String(member.memberId) === memberId)?.identityPublicKey;
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
      hub: { enabled: true, roster, members: hub?.members ?? [], joinTickets: [] },
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

  /** A join code for the person to type or scan on the device that is joining. */
  mintJoinCode(input: { readonly owner: boolean }): JoinCodeOutcome {
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
    return {
      status: "minted",
      code: built.code,
      expiresAt: ticket.expiresAt,
      owner: input.owner,
    };
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
    if (!originIsPrivate(request.listenerOrigin)) {
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

    const member: RosterMember = { ...request.member, role: "spoke", owner: ticket.owner };
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members: [...roster.members, member],
    });
    this.#options.state.save({
      ...current,
      hub: {
        ...hub,
        roster: signed,
        members: [
          ...hub.members,
          {
            memberId: member.memberId,
            identityPublicKey: request.identityPublicKey,
            deviceId,
            listenerOrigin: request.listenerOrigin,
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
    void this.#publish(signed, hub, [String(member.memberId)]);
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
    const record = this.#options.state
      .load()
      .hub?.members.find((member) => String(member.memberId) === memberId);
    if (record === undefined) return { status: "refused", kind: "not-a-member" };
    return this.#drop(
      memberId,
      "member-left",
      { kind: "remote-device", deviceId: decodeDeviceId(record.deviceId) },
      false,
    );
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
    if (entry.role === "hub" || record === undefined) {
      return { status: "refused", kind: "cannot-remove-the-hub" };
    }
    try {
      this.#options.pairing()?.revokeDevice(record.deviceId);
    } catch {
      // A device already revoked, or one the host no longer holds, leaves nothing to revoke.
    }
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members: roster.members.filter((member) => String(member.memberId) !== memberId),
      standbyOrder: roster.standbyOrder.filter((id) => String(id) !== memberId),
    });
    this.#options.state.save({
      ...current,
      hub: {
        ...hub,
        roster: signed,
        members: hub.members.filter((member) => String(member.memberId) !== memberId),
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
    await this.#publish(signed, hub, tellMember ? [] : [memberId]);
    return { status: "removed", sequence: signed.roster.sequence };
  }

  /** Sends the roster to every member that holds a listener the hub can reach. Failures are not retried here. */
  async #publish(
    signed: SignedHubRoster,
    hub: HubSideState,
    skip: ReadonlyArray<string>,
  ): Promise<void> {
    const identity = this.#options.identity();
    const body = JSON.stringify(encodeSignedHubRoster(signed));
    const pins = new Map(
      (hub.roster?.roster.members ?? []).map((member) => [
        String(member.memberId),
        member.listenerPin,
      ]),
    );
    const targets = hub.members.filter((member) => !skip.includes(String(member.memberId)));
    await Promise.allSettled(
      targets.map(async (member) => {
        const pin = pins.get(String(member.memberId));
        if (pin === undefined) return;
        await sendHubLinkRequest({
          transport: this.#options.transport,
          target: { origin: member.listenerOrigin, pin: listenerPinFromDigest(pin) },
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
