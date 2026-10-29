// Provisioning from the hub's side. The person, in the hub's own window, makes
// an offer: an update channel (with, if they like, a copy of the signed feed
// document), a plugin from the catalog by reference, an agent profile, a model
// endpoint row, or a routine. The hub signs it to each spoke over the pinned
// member link; the spoke decides whether it is even a proposal, and its person
// decides whether to apply it. An offer is data. It carries no secret (the
// schema has nowhere to put one), installs and trusts nothing, and the hub
// never learns what a spoke did with it. The hub serves the mirrored feed as
// plain bytes: the feed's own signature, checked by the spoke, is what makes an
// update trustworthy, never this host. The switch is the hub's own, off until a
// person turns it on in a window.

import { randomUUID } from "node:crypto";
import {
  HubMemberId,
  HubOfferId,
  HubProvisionReason,
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubOfferBody,
  type HubOfferDeliveryResult,
  type HubOfferRequest,
  type RosterMember,
} from "@octant/contracts";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type {
  HubStatePort,
  ProvisionDeliveryRecord,
  ProvisionOfferRecord,
} from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeOfferId = Schema.decodeUnknownSync(HubOfferId);
/** The hub keeps this many offers; making one past it forgets the oldest, which also stops serving its mirror. */
const MAX_OFFERS = 32;

export interface ProvisionServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly newOfferId?: () => string;
}

export type ProvisionSwitchOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "hub-role-off" };

export type OfferOutcome =
  | { readonly status: "offered"; readonly offerId: HubOfferId; readonly delivered: number }
  | { readonly status: "refused"; readonly kind: "hub-role-off" | "provision-service-off" }
  | { readonly status: "refused"; readonly kind: "malformed" | "unknown-member" };

export type WithdrawOutcome =
  | { readonly status: "withdrawn" }
  | { readonly status: "refused"; readonly kind: "hub-role-off" | "unknown-offer" };

export type MirrorOutcome =
  | { readonly status: "served"; readonly bytes: string }
  | {
      readonly status: "refused";
      readonly kind: "provision-service-off" | "unknown-offer" | "not-a-spoke";
    };

export interface ProvisionStatus {
  readonly enabled: boolean;
  readonly offers: ReadonlyArray<{
    readonly offerId: string;
    readonly kind: HubOfferBody["kind"];
    readonly createdAt: number;
    readonly mirrored: boolean;
    readonly deliveries: ReadonlyArray<{
      readonly memberId: string;
      readonly at: number;
      readonly result: HubOfferDeliveryResult;
      readonly reason?: HubProvisionReason;
    }>;
  }>;
}

const isSpoke = (member: RosterMember) => member.role === "spoke" || member.role === "standby-hub";

export class ProvisionService {
  readonly #options: ProvisionServiceOptions;

  constructor(options: ProvisionServiceOptions) {
    this.#options = options;
  }

  status(): ProvisionStatus {
    const provision = this.#options.state.load().hub?.provision;
    return {
      enabled: provision?.enabled === true,
      offers: (provision?.offers ?? []).map((record) => ({
        offerId: String(record.offerId),
        kind: record.offer.kind,
        createdAt: record.createdAt,
        mirrored: record.mirrorFeed !== undefined,
        deliveries: record.deliveries.map((delivery) => ({
          memberId: String(delivery.memberId),
          at: delivery.at,
          result: delivery.result,
          ...(delivery.reason === undefined ? {} : { reason: delivery.reason }),
        })),
      })),
    };
  }

  /** The offer switch. Turning it off forgets every offer, so no mirror is served and nothing is resent. */
  setEnabled(enabled: boolean, principal: AuditActingPrincipal): ProvisionSwitchOutcome {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        provision: { enabled, offers: enabled ? (hub.provision?.offers ?? []) : [] },
      },
    });
    this.#options.record({ change: "provision-switch-changed", actingPrincipal: principal });
    return { status: "changed", enabled };
  }

  /**
   * Makes one offer and hands it to each spoke the person named (every spoke,
   * when none is). Reaching a spoke is not the same as the spoke taking it: each
   * answers for itself, and the hub keeps only that answer.
   */
  async offer(request: HubOfferRequest, principal: AuditActingPrincipal): Promise<OfferOutcome> {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "hub-role-off" };
    }
    if (hub.provision?.enabled !== true) {
      return { status: "refused", kind: "provision-service-off" };
    }
    // A mirror belongs to an update-channel offer that says so, and only that offer.
    const wantsMirror = request.offer.kind === "update-channel" && request.offer.mirror === true;
    if (
      wantsMirror !== (request.mirrorFeed !== undefined) ||
      (request.offer.kind === "update-channel" &&
        request.mirrorFeed !== undefined &&
        request.mirrorFeed.release.ring !== request.offer.channel)
    ) {
      return { status: "refused", kind: "malformed" };
    }
    const roster = hub.roster.roster;
    const targets =
      request.memberIds === undefined
        ? roster.members.filter(isSpoke)
        : request.memberIds.map((id) =>
            roster.members.find((member) => String(member.memberId) === String(id)),
          );
    if (targets.some((member) => member === undefined || !isSpoke(member))) {
      return { status: "refused", kind: "unknown-member" };
    }
    const offerId = decodeOfferId((this.#options.newOfferId ?? randomUUID)());
    const record: ProvisionOfferRecord = {
      offerId,
      createdAt: this.#options.now(),
      offer: request.offer,
      ...(request.mirrorFeed === undefined ? {} : { mirrorFeed: request.mirrorFeed }),
      deliveries: [],
    };
    // Held before it is sent, because a spoke asks for the mirror while it is still answering.
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        provision: {
          enabled: true,
          offers: [...(hub.provision.offers ?? []), record].slice(-MAX_OFFERS),
        },
      },
    });
    this.#options.record({
      change: "provision-offered",
      actingPrincipal: principal,
      offerId,
      provisionKind: request.offer.kind,
    });
    const members = targets.flatMap((member) => (member === undefined ? [] : [member]));
    const outcomes = await Promise.all(
      members.map((member) => this.#deliver(record, member, hub.members)),
    );
    this.#noteDeliveries(offerId, outcomes);
    return {
      status: "offered",
      offerId,
      delivered: outcomes.filter((outcome) => outcome.result === "proposed").length,
    };
  }

  withdraw(offerId: HubOfferId, principal: AuditActingPrincipal): WithdrawOutcome {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    const offers = hub.provision?.offers ?? [];
    if (!offers.some((record) => String(record.offerId) === String(offerId))) {
      return { status: "refused", kind: "unknown-offer" };
    }
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        provision: {
          enabled: hub.provision?.enabled === true,
          offers: offers.filter((record) => String(record.offerId) !== String(offerId)),
        },
      },
    });
    this.#options.record({ change: "provision-withdrawn", actingPrincipal: principal, offerId });
    return { status: "withdrawn" };
  }

  /**
   * A spoke asks for the feed document an offer mirrors, signed with its own
   * key. The hub answers only a spoke in its roster, and only with the document
   * it was given, unchanged.
   */
  serveMirror(senderMemberId: string, offerId: HubOfferId): MirrorOutcome {
    const hub = this.#options.state.load().hub;
    if (hub?.enabled !== true || hub.provision?.enabled !== true || hub.roster === undefined) {
      return { status: "refused", kind: "provision-service-off" };
    }
    const sender = hub.roster.roster.members.find(
      (member) => String(member.memberId) === senderMemberId,
    );
    if (sender === undefined || !isSpoke(sender)) return { status: "refused", kind: "not-a-spoke" };
    const record = hub.provision.offers.find((entry) => String(entry.offerId) === String(offerId));
    if (record?.mirrorFeed === undefined) return { status: "refused", kind: "unknown-offer" };
    return { status: "served", bytes: JSON.stringify(record.mirrorFeed) };
  }

  async #deliver(
    record: ProvisionOfferRecord,
    member: RosterMember,
    members: ReadonlyArray<{ memberId: HubMemberId; listenerOrigin?: string | undefined }>,
  ): Promise<{
    readonly memberId: HubMemberId;
    readonly result: HubOfferDeliveryResult;
    readonly reason?: HubProvisionReason;
  }> {
    const memberId = decodeMemberId(String(member.memberId));
    const origin =
      members.find((entry) => String(entry.memberId) === String(member.memberId))
        ?.listenerOrigin ?? memberOrigin(member);
    if (origin === undefined) return { memberId, result: "unreachable" };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(identity.hostId),
      recipientMemberId: String(member.memberId),
      method: "POST",
      path: "/api/hub/provision-offer",
      body: JSON.stringify({ offerId: record.offerId, offer: record.offer }),
      now: this.#options.now(),
    });
    if (answer.status === "unreachable") return { memberId, result: "unreachable" };
    if (answer.response.ok) return { memberId, result: "proposed" };
    const reason = await refusalReason(answer.response);
    this.#options.record({
      change: "provision-offer-refused",
      actingPrincipal: { kind: "hub", memberId },
      memberId,
      offerId: record.offerId,
      provisionKind: record.offer.kind,
      provisionReason: reason,
    });
    return { memberId, result: "refused", reason };
  }

  #noteDeliveries(
    offerId: HubOfferId,
    outcomes: ReadonlyArray<{
      readonly memberId: HubMemberId;
      readonly result: HubOfferDeliveryResult;
      readonly reason?: HubProvisionReason;
    }>,
  ): void {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.provision === undefined) return;
    const at = this.#options.now();
    const deliveries: ProvisionDeliveryRecord[] = outcomes.map((outcome) => ({
      memberId: outcome.memberId,
      at,
      result: outcome.result,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    }));
    this.#options.state.save({
      ...state,
      hub: {
        ...hub,
        provision: {
          ...hub.provision,
          offers: hub.provision.offers.map((record) =>
            String(record.offerId) === String(offerId) ? { ...record, deliveries } : record,
          ),
        },
      },
    });
  }
}

const isProvisionReason = Schema.is(HubProvisionReason);

/** The spoke's own word for why it did not take the offer, when the journal knows it. */
async function refusalReason(response: Response): Promise<HubProvisionReason> {
  try {
    const body: unknown = await response.json();
    const kind = typeof body === "object" && body !== null && "kind" in body ? body.kind : "";
    if (isProvisionReason(kind)) return kind;
  } catch {
    // An answer that is not JSON is a refusal without a reason.
  }
  return "answer-refused";
}
