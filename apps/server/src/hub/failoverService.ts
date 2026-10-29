// Failover from the member's side and the standby's. A member that cannot reach
// the hub for the failover time tries the standbys in the order the hub named
// them. A named standby that sees no hub for that time stands in: it serves the
// roster it holds, tells members it is standing in, and adds and removes
// members, signing each roster with its own identity key. When the hub answers
// again it hands those changes back and steps down. Nothing here changes the
// standby order or promotes anyone (decisions H10 and H11); the hub's window
// owns the order, and promotion is the standby's own window's act.

import {
  EventActorDeviceId,
  HubMemberId,
  decodeHubHeartbeatResponse,
  decodeHubStandInHandbackResponse,
  encodeSignedHubRoster,
  type AuditActingPrincipal,
  type HubHeartbeatResponse,
  type HubJoinRequest,
  type HubJoinResponse,
  type HubMembershipChangedPayload,
  type HubStandInHandback,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import { buildPairingCode, decideStandIn, hubRosterSigningPayload } from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import { listenerPinFromDigest, publicKeyFingerprint } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { listenerPortOf, type HubHostIdentity, type HubPairingPort } from "./hubService";
import type { HubLinkState, HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import { originIsPrivate, readPrivateListener } from "./privateListenerReading";
import { hubSignedAnchor, type SpokeLinkService } from "./spokeLinkService";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);
const DEFAULT_FAILOVER_AFTER_MS = 300_000;

export interface FailoverOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly listener: () => PrivateListenerHostStatus;
  readonly pairing: () => HubPairingPort | undefined;
  readonly transport: HubTransport;
  readonly spoke: SpokeLinkService;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  /** Replaces the failover time the hub's roster carries; tests cannot wait minutes. */
  readonly failoverAfterMs?: () => number | undefined;
}

export type StandInJoinCodeOutcome =
  | { readonly status: "minted"; readonly code: string; readonly expiresAt: number }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-standing-in"
        | "pairing-unavailable"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin";
    };

export type StandInJoinOutcome =
  | { readonly status: "joined"; readonly response: HubJoinResponse }
  | {
      readonly status: "refused";
      readonly kind:
        | "not-standing-in"
        | "guest-not-during-stand-in"
        | "identity-mismatch"
        | "member-origin-not-private"
        | "not-a-join-code"
        | "not-approved"
        | "already-member"
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin";
    };

export type StandInRemovalOutcome =
  | { readonly status: "removed"; readonly sequence: number }
  | {
      readonly status: "refused";
      readonly kind: "not-standing-in" | "not-a-member" | "cannot-remove-hub-or-standby";
    };

export interface FailoverStatus {
  readonly standingIn: boolean;
  /** The standby this member follows because it cannot reach the hub. */
  readonly followingStandby?: string;
}

export class FailoverService {
  readonly #options: FailoverOptions;
  #lastHubContact: number | undefined;
  #followingStandby: string | undefined;
  #ticking = false;

  constructor(options: FailoverOptions) {
    this.#options = options;
  }

  status(): FailoverStatus {
    return {
      standingIn: this.standingIn(),
      ...(this.#followingStandby === undefined ? {} : { followingStandby: this.#followingStandby }),
    };
  }

  standingIn(): boolean {
    const link = this.#options.state.load().link;
    return link !== undefined && link.removed !== true && link.standIn !== undefined;
  }

  /**
   * The key a member's request to a standing-in standby is checked against: the
   * one the member presents, if its fingerprint is the one the standby's own
   * signed roster lists for it. Guests and the hub use other routes.
   */
  memberKey(memberId: string, presentedKey: string | undefined): string | undefined {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true || link.standIn === undefined) return undefined;
    const listed = link.roster.roster.members.find(
      (member) => String(member.memberId) === memberId,
    );
    return listed !== undefined &&
      listed.role !== "guest" &&
      listed.role !== "hub" &&
      presentedKey !== undefined &&
      publicKeyFingerprint(presentedKey) === listed.identityKeyFingerprint
      ? presentedKey
      : undefined;
  }

  /**
   * Whether this host has not reached the hub for the whole failover time,
   * checked now. A standby-signed roster is accepted only while this holds.
   */
  async hubUnreachable(): Promise<boolean> {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) return false;
    const now = this.#options.now();
    this.#lastHubContact ??= now;
    if (await this.#probeHub(link)) {
      this.#lastHubContact = this.#options.now();
      return false;
    }
    return this.#options.now() - this.#lastHubContact >= this.#failoverAfterMs(link);
  }

  /** What a standing-in standby answers a member that asks whether anyone is there. */
  heartbeat(): HubHeartbeatResponse | undefined {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true || link.standIn === undefined) return undefined;
    return {
      standingIn: true,
      roster: link.roster,
      signerPublicKey: this.#options.identity().signing.hostPublicKey,
    };
  }

  /** A join code for a new member to type or scan, made on the standing-in standby's own window. */
  mintJoinCode(): StandInJoinCodeOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined || link.removed === true || link.standIn === undefined) {
      return { status: "refused", kind: "not-standing-in" };
    }
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    const pairing = this.#options.pairing();
    if (pairing === undefined) return { status: "refused", kind: "pairing-unavailable" };
    const pin = this.#options.listener().tlsPin;
    if (pin === null) return { status: "refused", kind: "listener-has-no-pin" };
    const ticket = pairing.createTicket(reading.sourceClass);
    const built = buildPairingCode({
      origin: reading.origin,
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
      pin,
    });
    if (built.status === "refused") return { status: "refused", kind: "listener-not-private" };
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        standIn: { ...link.standIn, joinTickets: [...link.standIn.joinTickets, ticket.ticketId] },
      },
    });
    return { status: "minted", code: built.code, expiresAt: ticket.expiresAt };
  }

  /**
   * Admits the member that paired with this standby's join code. It joins as a
   * spoke only, and never as an owner: a stand-in code makes no owner and takes
   * no unlock key. The answer carries the hub-signed roster that names this
   * standby, so the new member can judge the standby's update and reach the hub.
   */
  acceptJoin(request: HubJoinRequest): StandInJoinOutcome {
    const state = this.#options.state.load();
    const link = state.link;
    const standIn = link?.standIn;
    const anchor = link === undefined ? undefined : hubSignedAnchor(link);
    if (
      link === undefined ||
      link.removed === true ||
      standIn === undefined ||
      anchor === undefined
    ) {
      return { status: "refused", kind: "not-standing-in" };
    }
    if (request.asGuest === true) return { status: "refused", kind: "guest-not-during-stand-in" };
    if (publicKeyFingerprint(request.identityPublicKey) !== request.member.identityKeyFingerprint) {
      return { status: "refused", kind: "identity-mismatch" };
    }
    if (request.listenerOrigin === undefined || !originIsPrivate(request.listenerOrigin)) {
      return { status: "refused", kind: "member-origin-not-private" };
    }
    if (!standIn.joinTickets.includes(request.ticketId)) {
      return { status: "refused", kind: "not-a-join-code" };
    }
    const deviceId = this.#options.pairing()?.approvedDeviceFor({
      ticketId: request.ticketId,
      ticketProof: request.ticketProof,
    });
    if (deviceId === undefined) return { status: "refused", kind: "not-approved" };
    const roster = link.roster.roster;
    if (
      roster.members.some((member) => String(member.memberId) === String(request.member.memberId))
    ) {
      return { status: "refused", kind: "already-member" };
    }
    const reading = readPrivateListener(this.#options.listener());
    if (reading.status === "refused") return { status: "refused", kind: reading.kind };
    const { listenerPort: _claimedPort, ...claimed } = request.member;
    const member: RosterMember = {
      ...claimed,
      role: "spoke",
      ...listenerPortOf(request.listenerOrigin),
      owner: false,
    };
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members: [...roster.members, member],
    });
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        roster: signed,
        standIn: {
          ...standIn,
          joinTickets: standIn.joinTickets.filter((ticketId) => ticketId !== request.ticketId),
          added: [
            ...standIn.added,
            {
              member,
              identityPublicKey: request.identityPublicKey,
              listenerOrigin: request.listenerOrigin,
              deviceId,
            },
          ],
        },
      },
    });
    this.#options.record({
      change: "member-added",
      actingPrincipal: { kind: "remote-device", deviceId: decodeDeviceId(deviceId) },
      memberId: member.memberId,
      sequence: signed.roster.sequence,
    });
    void this.#publish(signed, roster.members);
    return {
      status: "joined",
      response: {
        hub: {
          memberId: link.hubMemberId,
          name: link.hubName,
          identityPublicKey: link.hubIdentityPublicKey,
          identityKeyFingerprint: publicKeyFingerprint(link.hubIdentityPublicKey),
          rosterSigningPublicKey: link.rosterSigningPublicKey,
          listenerPin: link.hubListenerPin,
        },
        roster: signed,
        standIn: { hubOrigin: link.hubOrigin, hubRoster: anchor },
      },
    };
  }

  /**
   * Removes a member while standing in. The hub and the standbys stay: the
   * standby order and every hub and standby role are the hub's to change, and a
   * roster that moved them would be refused by every member.
   */
  async removeMember(
    memberId: string,
    principal: AuditActingPrincipal,
  ): Promise<StandInRemovalOutcome> {
    const state = this.#options.state.load();
    const link = state.link;
    const standIn = link?.standIn;
    if (link === undefined || link.removed === true || standIn === undefined) {
      return { status: "refused", kind: "not-standing-in" };
    }
    const roster = link.roster.roster;
    const entry = roster.members.find((member) => String(member.memberId) === memberId);
    if (entry === undefined) return { status: "refused", kind: "not-a-member" };
    if (
      entry.role === "hub" ||
      entry.role === "standby-hub" ||
      memberId === String(link.selfMemberId)
    ) {
      return { status: "refused", kind: "cannot-remove-hub-or-standby" };
    }
    // Only a device this standby made can be revoked here; every other member's
    // device belongs to the hub, which revokes it when it takes the removal back.
    const device = standIn.added.find((added) => String(added.member.memberId) === memberId);
    if (device !== undefined) {
      try {
        this.#options.pairing()?.revokeDevice(device.deviceId);
      } catch {
        // A device already revoked, or one the host no longer holds, leaves nothing to revoke.
      }
    }
    const signed = this.#sign({
      ...roster,
      sequence: roster.sequence + 1,
      members: roster.members.filter((member) => String(member.memberId) !== memberId),
    });
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        roster: signed,
        standIn: { ...standIn, removed: [...standIn.removed, entry.memberId] },
      },
    });
    this.#options.record({
      change: "member-removed",
      actingPrincipal: principal,
      memberId: entry.memberId,
      sequence: signed.roster.sequence,
    });
    // The removed member learns of it from the roster that no longer lists it.
    await this.#publish(signed, roster.members);
    return { status: "removed", sequence: signed.roster.sequence };
  }

  /**
   * One look at the hub. Called on a timer by the server and directly by tests.
   * A reachable hub ends any stand-in and any following of a standby; a hub
   * unreachable for the whole failover time starts a stand-in on a named
   * standby, and makes any other member try the standbys in order.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#look();
    } finally {
      this.#ticking = false;
    }
  }

  async #look(): Promise<void> {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true || link.leaving === true) {
      this.#lastHubContact = undefined;
      this.#followingStandby = undefined;
      return;
    }
    const started = this.#options.now();
    this.#lastHubContact ??= started;
    if (await this.#probeHub(link)) {
      this.#lastHubContact = this.#options.now();
      this.#followingStandby = undefined;
      if (link.standIn !== undefined) await this.#stepDown();
      return;
    }
    const current = this.#options.state.load().link;
    if (current === undefined || current.removed === true) return;
    const silentForMs = this.#options.now() - this.#lastHubContact;
    const failoverAfterMs = this.#failoverAfterMs(current);
    const anchor = hubSignedAnchor(current);
    const decision = decideStandIn({
      anchor,
      selfMemberId: current.selfMemberId,
      grant: current.grant,
      silentForMs,
      failoverAfterMs,
      standingIn: current.standIn !== undefined,
    });
    if (decision.status === "stand-in" && anchor !== undefined) {
      this.#startStandIn(current);
      return;
    }
    if (current.standIn !== undefined || silentForMs < failoverAfterMs) return;
    await this.#followStandby(current, anchor);
  }

  #failoverAfterMs(link: HubLinkState): number {
    const override = this.#options.failoverAfterMs?.();
    if (override !== undefined) return override;
    const seconds = hubSignedAnchor(link)?.roster.failoverAfterSeconds;
    return seconds === undefined ? DEFAULT_FAILOVER_AFTER_MS : seconds * 1_000;
  }

  /**
   * Whether the hub answered. A newer hub-signed roster in its answer is taken
   * like a pushed one, so a spoke whose person unticked Roster still reads
   * reachability from the answer but installs nothing from it.
   */
  async #probeHub(link: HubLinkState): Promise<boolean> {
    const answer = await this.#askHeartbeat({
      origin: link.hubOrigin,
      pin: link.hubListenerPin,
      recipientMemberId: String(link.hubMemberId),
      selfMemberId: String(link.selfMemberId),
    });
    if (answer === undefined) return false;
    if (answer.heartbeat !== undefined && !answer.heartbeat.standingIn) {
      const { roster } = answer.heartbeat;
      if (roster.signedBy.kind === "hub" && roster.roster.sequence > link.roster.roster.sequence) {
        this.#options.spoke.receiveRoster(roster);
      }
    }
    return true;
  }

  async #askHeartbeat(target: {
    readonly origin: string;
    readonly pin: string;
    readonly recipientMemberId: string;
    readonly selfMemberId: string;
  }): Promise<{ readonly heartbeat: HubHeartbeatResponse | undefined } | undefined> {
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: target.origin, pin: listenerPinFromDigest(target.pin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: target.selfMemberId,
      recipientMemberId: target.recipientMemberId,
      method: "GET",
      path: "/api/hub/heartbeat",
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return undefined;
    if (!answer.response.ok) return { heartbeat: undefined };
    try {
      return { heartbeat: decodeHubHeartbeatResponse(await answer.response.json()) };
    } catch {
      return { heartbeat: undefined };
    }
  }

  /** Takes the first standby, in the hub's order, that says it is standing in and signs a roster this member may accept. */
  async #followStandby(link: HubLinkState, anchor: SignedHubRoster | undefined): Promise<void> {
    if (anchor === undefined) return;
    for (const id of anchor.roster.standbyOrder) {
      if (String(id) === String(link.selfMemberId)) continue;
      const entry = anchor.roster.members.find(
        (member) => member.role === "standby-hub" && String(member.memberId) === String(id),
      );
      const origin = entry === undefined ? undefined : memberOrigin(entry);
      if (entry === undefined || origin === undefined) continue;
      const answer = await this.#askHeartbeat({
        origin,
        pin: entry.listenerPin,
        recipientMemberId: String(id),
        selfMemberId: String(link.selfMemberId),
      });
      const heartbeat = answer?.heartbeat;
      if (
        heartbeat === undefined ||
        !heartbeat.standingIn ||
        heartbeat.signerPublicKey === undefined ||
        heartbeat.roster.signedBy.kind !== "standby" ||
        String(heartbeat.roster.signedBy.memberId) !== String(id)
      ) {
        continue;
      }
      const receipt = this.#options.spoke.receiveRoster(heartbeat.roster, {
        publicKey: heartbeat.signerPublicKey,
        // The probe just failed and the whole failover time has passed.
        hubReachable: false,
      });
      // A roster this member already holds is the standby it already follows.
      if (
        receipt.status === "accepted" ||
        (receipt.status === "refused" && receipt.kind === "stale-sequence")
      ) {
        this.#followingStandby = String(id);
        return;
      }
    }
  }

  #startStandIn(link: HubLinkState): void {
    const anchor = hubSignedAnchor(link);
    if (anchor === undefined) return;
    const state = this.#options.state.load();
    // The first stand-in roster changes nothing but the sequence: it is how a
    // standby tells every member that it is standing in.
    const signed = this.#sign({ ...link.roster.roster, sequence: link.roster.roster.sequence + 1 });
    this.#options.state.save({
      ...state,
      link: {
        ...link,
        roster: signed,
        hubSignedRoster: anchor,
        standIn: {
          startedAt: this.#options.now(),
          baseSequence: anchor.roster.sequence,
          added: [],
          removed: [],
          joinTickets: [],
        },
      },
    });
    this.#options.record({
      change: "stand-in-started",
      actingPrincipal: { kind: "hub", memberId: link.selfMemberId },
      memberId: link.hubMemberId,
      sequence: signed.roster.sequence,
    });
    void this.#publish(signed, link.roster.roster.members);
  }

  /** The hub answered: hand back the membership changes and the wake times, and stop standing in. */
  async #stepDown(): Promise<void> {
    const link = this.#options.state.load().link;
    const standIn = link?.standIn;
    if (link === undefined || standIn === undefined) return;
    const handback: HubStandInHandback = {
      baseSequence: standIn.baseSequence,
      sequence: link.roster.roster.sequence,
      added: standIn.added.map(({ member, identityPublicKey, listenerOrigin }) => ({
        member,
        identityPublicKey,
        listenerOrigin,
      })),
      removed: standIn.removed,
      // Slice 8 fills this: no wake times exist to hand back yet.
      wakeTimes: [],
    };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: String(link.hubMemberId),
      method: "POST",
      path: "/api/hub/handback",
      body: JSON.stringify(handback),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: this.#options.now(),
    });
    // Still standing in until the hub has taken the changes: try again next look.
    if (answer.status === "unreachable") return;
    if (answer.response.ok) {
      try {
        const merged = decodeHubStandInHandbackResponse(await answer.response.json());
        this.#options.spoke.receiveRoster(merged.roster);
      } catch {
        return;
      }
    } else if (answer.response.status !== 403) {
      return;
    }
    // A hub that no longer names this host a standby cannot take changes back;
    // its refusal ends the stand-in with the changes dropped, which the record shows.
    const state = this.#options.state.load();
    const latest = state.link;
    if (latest === undefined) return;
    const { standIn: _ended, ...rest } = latest;
    this.#options.state.save({ ...state, link: rest });
    this.#options.record({
      change: "stand-in-ended",
      actingPrincipal: { kind: "hub", memberId: link.selfMemberId },
      memberId: link.hubMemberId,
      sequence: latest.roster.roster.sequence,
    });
  }

  #sign(roster: SignedHubRoster["roster"]): SignedHubRoster {
    const identity = this.#options.identity();
    return {
      roster,
      signedBy: { kind: "standby", memberId: decodeMemberId(String(identity.hostId)) },
      signature: identity.signing.signHostPayload(hubRosterSigningPayload(roster)),
    };
  }

  /** Sends a standby-signed roster to the members that run a listener. The hub is not asked: it is the one that cannot be reached. */
  async #publish(signed: SignedHubRoster, recipients: ReadonlyArray<RosterMember>): Promise<void> {
    const identity = this.#options.identity();
    const body = JSON.stringify(encodeSignedHubRoster(signed));
    const self = String(identity.hostId);
    await Promise.allSettled(
      recipients
        .filter(
          (member) =>
            member.role !== "hub" && member.role !== "guest" && String(member.memberId) !== self,
        )
        .map(async (member) => {
          const origin = memberOrigin(member);
          if (origin === undefined) return;
          await sendHubLinkRequest({
            transport: this.#options.transport,
            target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
            signHostPayload: identity.signing.signHostPayload,
            senderMemberId: self,
            recipientMemberId: String(member.memberId),
            method: "PUT",
            path: "/api/hub/roster",
            body,
            headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
            now: this.#options.now(),
          });
        }),
    );
  }
}
