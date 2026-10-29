// Pure rules of provisioning through the hub: whether a spoke takes an offer as
// a proposal, which release channels it follows, which kinds may apply without
// asking, and when a proposal lapses. An offer is data the spoke weighs; none
// of these rules lets one install, trust, enable, or widen anything.

import {
  HUB_AUTO_APPLY_KINDS,
  type AppReleaseRing,
  type HubAutoApplyKind,
  type HubOfferBody,
  type HubOfferKind,
  type HubProvisionReason,
} from "@octant/contracts";

export type OfferAdmission =
  | { readonly status: "propose" }
  | { readonly status: "refuse"; readonly kind: HubProvisionReason };

/**
 * The channels a spoke follows on an offer's word: stable and preview, and the
 * candidate channel only for a spoke already on it. A candidate build is a test
 * stream, so no offer moves a computer onto it.
 */
export function allowedUpdateChannels(
  current: AppReleaseRing | undefined,
): ReadonlyArray<AppReleaseRing> {
  return current === "candidate" ? ["stable", "preview", "candidate"] : ["stable", "preview"];
}

/**
 * Whether the spoke takes an offer as a proposal. The checks run in the order
 * a person would ask them: is the hub allowed to offer, can this spoke apply
 * the kind at all, does the offer ask for more than the spoke's person could
 * do, and is there room.
 */
export function decideOfferAdmission(input: {
  readonly offer: HubOfferBody;
  readonly offerHeld: boolean;
  readonly provisionGranted: boolean;
  readonly supportedKinds: ReadonlyArray<HubOfferKind>;
  readonly currentChannel: AppReleaseRing | undefined;
  /** Whether this spoke can check a mirrored feed's signature. */
  readonly canVerifyMirror: boolean;
  readonly heldCount: number;
  readonly maxProposals: number;
}): OfferAdmission {
  if (!input.provisionGranted) return { status: "refuse", kind: "provision-not-granted" };
  if (!input.supportedKinds.includes(input.offer.kind)) {
    return { status: "refuse", kind: "kind-unsupported" };
  }
  const offer = input.offer;
  if (offer.kind === "update-channel") {
    if (!allowedUpdateChannels(input.currentChannel).includes(offer.channel)) {
      return { status: "refuse", kind: "channel-not-allowed" };
    }
    if (offer.mirror === true && !input.canVerifyMirror) {
      return { status: "refuse", kind: "mirror-unverifiable" };
    }
  }
  // A profile from the hub never carries Full access or a remembered permission:
  // those are decided by a person on the spoke, never offered.
  if (
    offer.kind === "agent-profile" &&
    (offer.defaultExecutionPolicy === "full-access" ||
      offer.defaultPermissionPersistence === "project-default")
  ) {
    return { status: "refuse", kind: "widens-authority" };
  }
  if (input.offerHeld) return { status: "refuse", kind: "duplicate" };
  if (input.heldCount >= input.maxProposals) return { status: "refuse", kind: "proposals-full" };
  return { status: "propose" };
}

export function isAutoApplyKind(kind: HubOfferKind): kind is HubAutoApplyKind {
  return (HUB_AUTO_APPLY_KINDS as ReadonlyArray<string>).includes(kind);
}

/**
 * Whether a proposal applies on arrival. Only the three kinds decision H5 names
 * can, and only where the spoke's person turned that kind on; a routine and an
 * endpoint row always wait for the person.
 */
export function decideAutoApply(input: {
  readonly kind: HubOfferKind;
  readonly autoApply: ReadonlyArray<HubAutoApplyKind>;
}): boolean {
  return isAutoApplyKind(input.kind) && input.autoApply.includes(input.kind);
}

/** Splits proposals into those still open and those that lapsed. */
export function settleProposals<T extends { readonly expiresAtMs: number }>(
  proposals: ReadonlyArray<T>,
  nowMs: number,
): { readonly open: ReadonlyArray<T>; readonly expired: ReadonlyArray<T> } {
  return {
    open: proposals.filter((proposal) => proposal.expiresAtMs > nowMs),
    expired: proposals.filter((proposal) => proposal.expiresAtMs <= nowMs),
  };
}
