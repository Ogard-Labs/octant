// Provisioning from a spoke's side. The hub offers; this spoke holds each offer
// as a proposal its person sees in Settings and applies or dismisses. Applying
// goes through the same services the person would use themselves, one port per
// kind, so an offered plugin arrives installed but untrusted and disabled, a
// profile or endpoint row is added without a secret, and a routine is authored
// by this spoke's own principal under its ordinary ceiling and revalidation. A
// person may let three kinds apply on arrival (an update channel, an untrusted
// plugin install, a profile without secrets); that does exactly what Apply does
// and never more. An offer the spoke cannot apply, or that asks for more than
// its person could do, is refused on arrival.

import {
  AppUpdateFeed,
  HUB_OFFER_KINDS,
  UtcTimestamp,
  type AppReleaseRing,
  type AuditActingPrincipal,
  type HubAutoApplyKind,
  type HubMembershipChangedPayload,
  type HubMemberId,
  type HubOfferBody,
  type HubOfferDelivery,
  type HubOfferId,
  type HubOfferKind,
  type HubProposalView,
  type HubProvisionMode,
  type HubProvisionReason,
  type ModelEndpointOffer,
  type PluginOffer,
  type AgentProfileOffer,
  type RoutineOffer,
} from "@octant/contracts";
import {
  allowedUpdateChannels,
  canonicalReleaseBytes,
  decideAutoApply,
  decideOfferAdmission,
  settleProposals,
} from "@octant/domain";
import { Schema } from "effect";
import { listenerPinFromDigest } from "./hubCrypto";
import { sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type {
  HubLinkState,
  HubStatePort,
  ProvisionProposalRecord,
  SpokeProvisionState,
} from "./hubStateStore";
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeLinkService } from "./spokeLinkService";

const decodeFeed = Schema.decodeUnknownSync(AppUpdateFeed);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const DEFAULT_PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_PROPOSALS = 32;
const MAX_MIRROR_BYTES = 16_384;

export type ApplyOutcome =
  | { readonly status: "applied" }
  | { readonly status: "failed"; readonly kind: HubProvisionReason };

/**
 * What this host can do for each kind of offer, as the person would. A kind
 * with no port here is a kind this spoke refuses on arrival. None of these takes
 * a secret, and the plugin port only installs: trusting and enabling stay with
 * the person on this host.
 */
export interface ProvisionHostPorts {
  readonly updateChannel?: {
    readonly current: () => AppReleaseRing | undefined;
    readonly set: (channel: AppReleaseRing) => Promise<ApplyOutcome>;
  };
  readonly plugin?: { readonly install: (offer: PluginOffer) => Promise<ApplyOutcome> };
  readonly agentProfile?: { readonly add: (offer: AgentProfileOffer) => Promise<ApplyOutcome> };
  readonly modelEndpoint?: { readonly add: (offer: ModelEndpointOffer) => Promise<ApplyOutcome> };
  readonly routine?: {
    readonly author: (offer: RoutineOffer, projectId: string) => Promise<ApplyOutcome>;
  };
  /** Checks a feed signature against the release keys this build trusts; absent, a mirrored feed cannot be checked and is refused. */
  readonly verifyUpdateSignature?: (
    message: Uint8Array,
    signature: string,
    ring: AppReleaseRing,
  ) => boolean;
}

export interface SpokeProvisionOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly spoke: Pick<SpokeLinkService, "hubMayUse">;
  readonly ports: ProvisionHostPorts;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
  readonly proposalLifetimeMs?: number;
  readonly maxProposals?: number;
}

export type OfferReceipt =
  | { readonly status: "proposed"; readonly applied: boolean }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | HubProvisionReason;
    };

export type DecisionOutcome =
  | { readonly status: "applied" }
  | { readonly status: "dismissed" }
  | {
      readonly status: "refused";
      readonly kind: "not-a-spoke" | "hub-revoked" | HubProvisionReason;
    };

export interface SpokeProvisionView {
  /** Whether this spoke's hub grant ticks Provision, which is the only reason it keeps a proposal. */
  readonly offering: boolean;
  readonly supportedKinds: ReadonlyArray<HubOfferKind>;
  readonly autoApply: ReadonlyArray<HubAutoApplyKind>;
  readonly proposals: ReadonlyArray<HubProposalView>;
}

/** Who a proposal is applied by, and how. The principal is this spoke's own, never the hub. */
const WINDOW: AuditActingPrincipal = { kind: "local-window" };

export class SpokeProvisionService {
  readonly #options: SpokeProvisionOptions;

  constructor(options: SpokeProvisionOptions) {
    this.#options = options;
  }

  view(): SpokeProvisionView {
    const link = this.#options.state.load().link;
    if (link === undefined || link.removed === true) {
      return { offering: false, supportedKinds: this.#supportedKinds(), autoApply: [], proposals: [] };
    }
    this.#settle();
    const provision = this.#options.state.load().link?.provision;
    return {
      offering: this.#granted(),
      supportedKinds: this.#supportedKinds(),
      autoApply: provision?.autoApply ?? [],
      proposals: (provision?.proposals ?? []).map((proposal) => ({
        offerId: proposal.offerId,
        offer: proposal.offer,
        receivedAt: decodeTimestamp(new Date(proposal.receivedAtMs).toISOString()),
        expiresAt: decodeTimestamp(new Date(proposal.expiresAtMs).toISOString()),
      })),
    };
  }

  /**
   * The hub's offer, already authenticated as the hub's. This decides whether it
   * is a proposal at all; a proposal waits for the person unless they turned on
   * applying that kind, which does exactly what Apply does.
   */
  async receive(sender: HubMemberId, delivery: HubOfferDelivery): Promise<OfferReceipt> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#settle();
    const provision = this.#options.state.load().link?.provision;
    const decision = decideOfferAdmission({
      offer: delivery.offer,
      offerHeld: (provision?.proposals ?? []).some(
        (proposal) => String(proposal.offerId) === String(delivery.offerId),
      ),
      provisionGranted: this.#granted(),
      supportedKinds: this.#supportedKinds(),
      currentChannel: this.#options.ports.updateChannel?.current(),
      canVerifyMirror: this.#options.ports.verifyUpdateSignature !== undefined,
      heldCount: provision?.proposals.length ?? 0,
      maxProposals: this.#options.maxProposals ?? DEFAULT_MAX_PROPOSALS,
    });
    const principal: AuditActingPrincipal = { kind: "hub", memberId: sender };
    if (decision.status === "refuse") {
      this.#journal("provision-refused", principal, delivery.offerId, delivery.offer.kind, {
        reason: decision.kind,
      });
      return { status: "refused", kind: decision.kind };
    }
    const now = this.#options.now();
    this.#updateProvision((current) => ({
      ...current,
      proposals: [
        ...current.proposals,
        {
          offerId: delivery.offerId,
          offer: delivery.offer,
          receivedAtMs: now,
          expiresAtMs: now + (this.#options.proposalLifetimeMs ?? DEFAULT_PROPOSAL_LIFETIME_MS),
        },
      ],
    }));
    this.#journal("provision-proposed", principal, delivery.offerId, delivery.offer.kind, {});
    if (
      !decideAutoApply({
        kind: delivery.offer.kind,
        autoApply: provision?.autoApply ?? [],
      })
    ) {
      return { status: "proposed", applied: false };
    }
    const applied = await this.#apply(delivery.offerId, WINDOW, "auto", undefined);
    return { status: "proposed", applied: applied.status === "applied" };
  }

  /** The person applying a proposal in this spoke's own window. */
  apply(
    offerId: HubOfferId,
    principal: AuditActingPrincipal,
    projectId?: string,
  ): Promise<DecisionOutcome> {
    return this.#apply(offerId, principal, "manual", projectId);
  }

  dismiss(offerId: HubOfferId, principal: AuditActingPrincipal): DecisionOutcome {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#settle();
    const proposal = this.#find(offerId);
    if (proposal === undefined) return { status: "refused", kind: "unknown-offer" };
    this.#drop(offerId);
    this.#journal("provision-dismissed", principal, offerId, proposal.offer.kind, {
      mode: "manual",
    });
    return { status: "dismissed" };
  }

  /** The person's standing choice for one kind. Every kind starts off. */
  setAutoApply(
    kind: HubAutoApplyKind,
    enabled: boolean,
  ): { readonly status: "changed" } | { readonly status: "refused"; readonly kind: "not-a-spoke" } {
    if (this.#options.state.load().link === undefined) {
      return { status: "refused", kind: "not-a-spoke" };
    }
    this.#updateProvision((current) => ({
      ...current,
      autoApply: enabled
        ? [...current.autoApply.filter((entry) => entry !== kind), kind]
        : current.autoApply.filter((entry) => entry !== kind),
    }));
    return { status: "changed" };
  }

  async #apply(
    offerId: HubOfferId,
    principal: AuditActingPrincipal,
    mode: HubProvisionMode,
    projectId: string | undefined,
  ): Promise<DecisionOutcome> {
    const link = this.#options.state.load().link;
    if (link === undefined) return { status: "refused", kind: "not-a-spoke" };
    if (link.removed === true) return { status: "refused", kind: "hub-revoked" };
    this.#settle();
    const proposal = this.#find(offerId);
    if (proposal === undefined) return { status: "refused", kind: "unknown-offer" };
    const offer = proposal.offer;
    // A routine and an endpoint row never apply unasked, whatever called this.
    if (
      mode === "auto" &&
      !decideAutoApply({
        kind: offer.kind,
        autoApply: link.provision?.autoApply ?? [],
      })
    ) {
      return { status: "refused", kind: "needs-person" };
    }
    const outcome = await this.#performApply(offerId, offer, link, projectId);
    if (outcome.status === "failed") {
      // The proposal stays, so the person can see it and try again or dismiss it.
      this.#journal("provision-refused", principal, offerId, offer.kind, {
        reason: outcome.kind,
        mode,
      });
      return { status: "refused", kind: outcome.kind };
    }
    this.#drop(offerId);
    this.#journal("provision-applied", principal, offerId, offer.kind, { mode });
    return { status: "applied" };
  }

  async #performApply(
    offerId: HubOfferId,
    offer: HubOfferBody,
    link: HubLinkState,
    projectId: string | undefined,
  ): Promise<ApplyOutcome> {
    const ports = this.#options.ports;
    switch (offer.kind) {
      case "update-channel": {
        const port = ports.updateChannel;
        if (port === undefined) return { status: "failed", kind: "kind-unsupported" };
        // The channel is judged again against where this spoke is now, not where it was when the offer came.
        if (!allowedUpdateChannels(port.current()).includes(offer.channel)) {
          return { status: "failed", kind: "channel-not-allowed" };
        }
        let verified: AppUpdateFeed | undefined;
        if (offer.mirror === true) {
          const mirrored = await this.#verifiedMirror(link, offerId, offer.channel);
          if (mirrored.status === "failed") return mirrored;
          verified = mirrored.feed;
        }
        const set = await port.set(offer.channel);
        if (set.status === "applied" && verified !== undefined) {
          const feed = verified;
          this.#updateProvision((current) => ({ ...current, verifiedFeed: feed }));
        }
        return set;
      }
      case "plugin":
        return ports.plugin === undefined
          ? { status: "failed", kind: "kind-unsupported" }
          : ports.plugin.install(offer);
      case "agent-profile":
        return ports.agentProfile === undefined
          ? { status: "failed", kind: "kind-unsupported" }
          : ports.agentProfile.add(offer);
      case "model-endpoint":
        return ports.modelEndpoint === undefined
          ? { status: "failed", kind: "kind-unsupported" }
          : ports.modelEndpoint.add(offer);
      case "routine": {
        if (ports.routine === undefined) return { status: "failed", kind: "kind-unsupported" };
        // The person binds a routine to one of their own Projects when they apply it.
        if (projectId === undefined) return { status: "failed", kind: "needs-person" };
        return ports.routine.author(offer, projectId);
      }
    }
  }

  /**
   * Fetches the feed document the hub mirrors and believes it only if the feed's
   * own signature checks against the release keys this build trusts, for the
   * channel the offer names. The hub is a courier: bytes it altered, or signed
   * itself, fail here.
   */
  async #verifiedMirror(
    link: HubLinkState,
    offerId: HubOfferId,
    channel: AppReleaseRing,
  ): Promise<
    | { readonly status: "ok"; readonly feed: AppUpdateFeed }
    | { readonly status: "failed"; readonly kind: HubProvisionReason }
  > {
    const verify = this.#options.ports.verifyUpdateSignature;
    if (verify === undefined) return { status: "failed", kind: "mirror-unverifiable" };
    const identity = this.#options.identity();
    const answer = await sendHubLinkRequest({
      transport: this.#options.transport,
      target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: String(link.hubMemberId),
      method: "POST",
      path: "/api/hub/provision-mirror",
      body: JSON.stringify({ offerId }),
      now: this.#options.now(),
    });
    if (answer.status === "unreachable" || !answer.response.ok) {
      return { status: "failed", kind: "mirror-unreachable" };
    }
    let feed: AppUpdateFeed;
    try {
      const text = await answer.response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_MIRROR_BYTES) {
        return { status: "failed", kind: "mirror-untrusted" };
      }
      feed = decodeFeed(JSON.parse(text));
    } catch {
      return { status: "failed", kind: "mirror-untrusted" };
    }
    let trusted = false;
    try {
      trusted =
        feed.release.ring === channel &&
        verify(canonicalReleaseBytes(feed.release), feed.signature, feed.release.ring);
    } catch {
      trusted = false;
    }
    return trusted
      ? { status: "ok", feed }
      : { status: "failed", kind: "mirror-untrusted" };
  }

  #granted(): boolean {
    return this.#options.spoke.hubMayUse("provision").status === "allowed";
  }

  #supportedKinds(): ReadonlyArray<HubOfferKind> {
    const ports = this.#options.ports;
    return HUB_OFFER_KINDS.filter((kind) => {
      switch (kind) {
        case "update-channel":
          return ports.updateChannel !== undefined;
        case "plugin":
          return ports.plugin !== undefined;
        case "agent-profile":
          return ports.agentProfile !== undefined;
        case "model-endpoint":
          return ports.modelEndpoint !== undefined;
        case "routine":
          return ports.routine !== undefined;
      }
    });
  }

  #find(offerId: HubOfferId): ProvisionProposalRecord | undefined {
    return this.#options.state
      .load()
      .link?.provision?.proposals.find((entry) => String(entry.offerId) === String(offerId));
  }

  #drop(offerId: HubOfferId): void {
    this.#updateProvision((current) => ({
      ...current,
      proposals: current.proposals.filter((entry) => String(entry.offerId) !== String(offerId)),
    }));
  }

  /**
   * Forgets proposals that lapsed, and every proposal once the person no longer
   * ticks Provision: what a hub may offer is the grant's to say, not the
   * moment the offer arrived.
   */
  #settle(): void {
    const provision = this.#options.state.load().link?.provision;
    if (provision === undefined || provision.proposals.length === 0) return;
    const granted = this.#granted();
    const { open, expired } = settleProposals(provision.proposals, this.#options.now());
    const lapsed = granted ? expired : provision.proposals;
    if (lapsed.length === 0) return;
    this.#updateProvision((current) => ({
      ...current,
      proposals: granted ? open : [],
    }));
    for (const proposal of lapsed) {
      this.#journal("provision-dismissed", WINDOW, proposal.offerId, proposal.offer.kind, {
        reason: granted ? "expired" : "provision-not-granted",
      });
    }
  }

  #updateProvision(change: (current: SpokeProvisionState) => SpokeProvisionState): void {
    const state = this.#options.state.load();
    if (state.link === undefined) return;
    this.#options.state.save({
      ...state,
      link: {
        ...state.link,
        provision: change(state.link.provision ?? { proposals: [], autoApply: [] }),
      },
    });
  }

  #journal(
    change: HubMembershipChangedPayload["change"],
    principal: AuditActingPrincipal,
    offerId: HubOfferId,
    kind: HubOfferKind,
    extra: { readonly reason?: HubProvisionReason; readonly mode?: HubProvisionMode },
  ): void {
    this.#options.record({
      change,
      actingPrincipal: principal,
      offerId,
      provisionKind: kind,
      ...(extra.reason === undefined ? {} : { provisionReason: extra.reason }),
      ...(extra.mode === undefined ? {} : { provisionMode: extra.mode }),
    });
  }
}
