// The spoke side of a hub: joining one, the hub grant, leaving, and what a
// request from the hub may do here. Only this host, through its loopback
// administration channel, joins, leaves, or changes the grant. The hub is a
// principal of kind `hub` whose authority is exactly that grant; it never
// carries a window's authority and never answers an approval.

import {
  HubMemberId as HubMemberIdSchema,
  decodeHubJoinResponse,
  type AuditActingPrincipal,
  type HubGrant,
  type HubGrantItem,
  type HubGuestAdmissionRequest,
  type HubJoinRequest,
  type HubMemberId,
  type HubPrincipal,
  type HubSpokeStatus,
  type SignedHubRoster,
} from "@octant/contracts";
import {
  authorizeHubRequest,
  decideRosterReplacement,
  defaultHubGrant,
  hubRosterSigningPayload,
  introduceGuests,
  reconcileHeldGrants,
  type RosterReplacement,
} from "@octant/domain";
import { Schema } from "effect";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import { listenerPinFromDigest, publicKeyFingerprint, verifySignature } from "./hubCrypto";
import { HubLinkVerifier, sendHubLinkRequest } from "./hubLink";
import { openHubPairing, type HubPairingRefusal, type HubPairingSession } from "./hubPairing";
import type { HubHostIdentity } from "./hubService";
import type { HubLinkState, HubStatePort } from "./hubStateStore";
import type { HubTransport } from "./pinnedHubTransport";
import { readPrivateListener } from "./privateListenerReading";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberIdSchema);

/** What the spoke needs of its own device pairing to admit and drop a guest. */
export interface SpokeDevicePort {
  readonly admitIntroducedDevice: (input: {
    readonly devicePublicKey: string;
    readonly deviceLabel: string;
    readonly origin: string;
    readonly sourceClass: "lan-private" | "tailscale";
  }) => { readonly deviceId: string };
  readonly revokeDevice: (deviceId: string) => void;
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
        | "listener-not-running"
        | "listener-not-private"
        | "listener-has-no-pin"
        | "devices-unavailable";
    };

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
      | "guest-dropped";
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
    const link = this.#options.state.load().link;
    if (link === undefined) return { membership: "none" };
    return {
      membership: link.removed === true ? "removed" : "member",
      hub: { memberId: link.hubMemberId, name: link.hubName },
      grant: link.grant,
      roster: link.roster,
    };
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
  async finishJoin(principal: AuditActingPrincipal): Promise<JoinFinishOutcome> {
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
    this.#options.state.save(state.hub === undefined ? {} : { hub: state.hub });
    this.#revokeGuestDevices(link.guestDevices ?? [], link.hubMemberId);
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
    // A spoke that ticked Introduce accepts a guest the verified roster adds;
    // one that did not leaves it unaccepted, and the guest's knock is refused.
    const introduced = introduceGuests({
      spokeId: link.selfMemberId,
      roster: candidate.roster,
      grants: kept,
      introduce: link.grant.items.includes("introduce"),
      confirmNewMembers: false,
    });
    const guestDevices = link.guestDevices ?? [];
    const listed = (memberId: HubMemberId) =>
      candidate.roster.members.some((member) => String(member.memberId) === String(memberId));
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
        }
      : { ...link, roster: candidate, peerGrants: [], guestDevices: [], removed: true };
    this.#options.state.save({ ...state, link: next });
    this.#revokeGuestDevices(droppedDevices, link.hubMemberId);
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
    const state = this.#options.state.load();
    const link = state.link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
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
    const accepted = link.peerGrants.some(
      (grant) => String(grant.memberId) === String(request.memberId),
    );
    if (!accepted) return { status: "refused", kind: "guest-not-accepted" };
    const existing = link.guestDevices?.find(
      (entry) => String(entry.memberId) === String(request.memberId),
    );
    if (existing !== undefined) {
      return {
        status: "admitted",
        spokeMemberId: link.selfMemberId,
        deviceId: existing.deviceId,
      };
    }
    const own = readPrivateListener(this.#options.listener());
    if (own.status === "refused") return { status: "refused", kind: own.kind };
    const devices = this.#options.devices();
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
          ...(link.guestDevices ?? []),
          { memberId: request.memberId, deviceId: device.deviceId },
        ],
      },
    });
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
    const devices = this.#options.devices();
    for (const entry of entries) {
      try {
        devices?.revokeDevice(entry.deviceId);
      } catch {
        // A device already revoked, or one this host no longer holds, leaves nothing to revoke.
      }
      this.#options.record({
        change: "guest-dropped",
        actingPrincipal: { kind: "hub", memberId: hubMemberId },
        memberId: entry.memberId,
      });
    }
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
