// The public entrance during failover (decision H30). A standby serves the
// entrance only while it stands in for the hub, only while it is not handing
// the stand-in back, and only if its own person chose to; the hub serves it
// whenever its role is on. A standby holds copies of the endpoints and grants
// of the spokes that ticked both Public and Standby, so it can serve the
// moment it stands in, and hands the hub back what it still queues.

import type { HubVisitorService } from "./hubVisitorService";
import type { HubWebhookService } from "./hubWebhookService";
import type { SpokeVisitorService } from "./spokeVisitorService";
import type { SpokeWebhookService } from "./spokeWebhookService";
import {
  type AuditActingPrincipal,
  type HubMembershipChangedPayload,
  type HubWebhookHandback,
  type RosterMember,
} from "@octant/contracts";
import { listenerPinFromDigest, publicKeyFingerprint } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubLinkState, HubState, HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import { hubSignedAnchor } from "./spokeLinkService";

export const PUBLIC_WEBHOOK_HANDBACK_ROUTE = "/api/hub/public/webhook-handback";

/**
 * Whether this host serves the public entrance now: it is the hub, or it is a
 * standby standing in, not yet handing back, whose own person chose to serve.
 * During the hand-back its entrance forwards to the returned hub like any
 * member's, so nothing new lands in a queue that is being emptied.
 */
export function servesPublicEntrance(input: {
  readonly hubEnabled: boolean;
  readonly state: HubState;
}): boolean {
  if (input.hubEnabled) return true;
  const link = input.state.link;
  return (
    link !== undefined &&
    link.removed !== true &&
    link.standIn !== undefined &&
    link.standIn.handingBack !== true &&
    input.state.publicEntrance?.serveWhileStandingIn === true
  );
}

/**
 * Whether this host may hold copies of spokes' public endpoints and grants: it
 * is the hub, or a standby the hub-signed roster names. A member the hub took
 * out of the order, or one that left, forgets them, since the spokes can no
 * longer reach it to withdraw them.
 */
export function holdsPublicCopies(input: {
  readonly hubEnabled: boolean;
  readonly state: HubState;
}): boolean {
  if (input.hubEnabled) return true;
  // A host that was a hub and is in no hub now keeps what it held, so turning
  // the role back on does not lose every spoke's endpoints.
  if (input.state.link === undefined) return true;
  return isNamedStandby(input.state.link);
}

/** Whether this host is a standby the latest hub-signed roster names. */
export function isNamedStandby(link: HubLinkState | undefined): boolean {
  if (link === undefined || link.removed === true) return false;
  const anchor = hubSignedAnchor(link);
  return (
    anchor !== undefined &&
    anchor.roster.standbyOrder.some((id) => String(id) === String(link.selfMemberId))
  );
}

/**
 * The key a spoke's copy request to a standby is checked against: the one it
 * presents, when this host is a named standby and its hub-signed roster lists
 * that spoke with that key's fingerprint. Guests and the hub hand no copies.
 */
export function copyHolderMemberKey(
  state: HubState,
  memberId: string,
  presentedKey: string | undefined,
): string | undefined {
  const link = state.link;
  if (link === undefined || !isNamedStandby(link) || presentedKey === undefined) return undefined;
  const listed = hubSignedAnchor(link)?.roster.members.find(
    (member) => String(member.memberId) === memberId,
  );
  return listed !== undefined &&
    listed.role !== "guest" &&
    listed.role !== "hub" &&
    publicKeyFingerprint(presentedKey) === listed.identityKeyFingerprint
    ? presentedKey
    : undefined;
}

/**
 * This host's own public services. A standby is a spoke too, and the copies of
 * its own endpoints and grants, and the deliveries and fetches for them, stay
 * on this host instead of going out and back over its own listener.
 */
export interface OwnPublicServices {
  readonly webhooks: Pick<HubWebhookService, "sealingKey" | "receiveEndpoints">;
  readonly visitors: Pick<HubVisitorService, "receiveGrants">;
  readonly spokeWebhooks: Pick<SpokeWebhookService, "receive">;
  readonly spokeVisitors: Pick<SpokeVisitorService, "fetch">;
}

/** The sequence of the hub-signed roster copy targets come from; empty without one. */
export function copyEpoch(link: HubLinkState | undefined): string {
  const anchor = link === undefined ? undefined : hubSignedAnchor(link);
  return anchor === undefined ? "" : String(anchor.roster.sequence);
}

/** Whether a member id names this host, as its hub link knows it. */
export function isSelf(state: HubState, memberId: string): boolean {
  const self = state.link?.selfMemberId;
  return self !== undefined && String(self) === memberId;
}

/**
 * A member a spoke hands its public copies to: the hub, and each named standby
 * when the spoke ticked Standby, this host included when it is one, so it can
 * serve its own links and endpoints while it stands in.
 */
export interface PublicCopyTarget {
  readonly memberId: string;
  readonly fingerprint: string;
  readonly origin: string;
  readonly pin: string;
}

export function publicCopyTargets(
  link: HubLinkState | undefined,
  standbyGranted: boolean,
): ReadonlyArray<PublicCopyTarget> {
  if (link === undefined || link.removed === true) return [];
  const anchor = hubSignedAnchor(link);
  const members = anchor?.roster.members ?? link.roster.roster.members;
  const hub = members.find((member) => String(member.memberId) === String(link.hubMemberId));
  const targets: PublicCopyTarget[] = [];
  if (hub !== undefined) {
    targets.push({
      memberId: String(link.hubMemberId),
      fingerprint: hub.identityKeyFingerprint,
      origin: link.hubOrigin,
      pin: link.hubListenerPin,
    });
  }
  if (!standbyGranted || anchor === undefined) return targets;
  for (const id of anchor.roster.standbyOrder) {
    const entry: RosterMember | undefined = members.find(
      (member) => String(member.memberId) === String(id) && member.role === "standby-hub",
    );
    const origin = entry === undefined ? undefined : memberOrigin(entry);
    if (entry === undefined || origin === undefined) continue;
    targets.push({
      memberId: String(id),
      fingerprint: entry.identityKeyFingerprint,
      origin,
      pin: entry.listenerPin,
    });
  }
  return targets;
}

/** The roster a serving host reads members from: the hub's own, or the one a standby holds. */
export function servingRosterMembers(state: HubState): ReadonlyArray<RosterMember> {
  // A host that was once a hub keeps its old roster on disk; only a hub role
  // that is on makes it the one to read.
  const own = state.hub?.enabled === true ? state.hub.roster?.roster.members : undefined;
  return own ?? state.link?.roster.roster.members ?? [];
}

/** The member ids of that roster, or nothing to prune by while this host serves from none. */
export function servingRosterMemberIds(state: HubState): ReadonlyArray<string> | undefined {
  const members = servingRosterMembers(state);
  return members.length === 0 ? undefined : members.map((member) => String(member.memberId));
}

export type ServeWhileStandingInOutcome =
  | { readonly status: "changed"; readonly enabled: boolean }
  | { readonly status: "refused"; readonly kind: "not-a-named-standby" };

/** The standby's own choice, made only in its own window or CLI and journaled with who made it. */
export function setServeWhileStandingIn(input: {
  readonly state: HubStatePort;
  readonly enabled: boolean;
  readonly principal: AuditActingPrincipal;
  readonly record: (change: HubMembershipChangedPayload) => void;
}): ServeWhileStandingInOutcome {
  const state = input.state.load();
  if (input.enabled && !isNamedStandby(state.link)) {
    return { status: "refused", kind: "not-a-named-standby" };
  }
  const current = state.publicEntrance ?? { enabled: false };
  const { serveWhileStandingIn: _was, ...rest } = current;
  input.state.save({
    ...state,
    publicEntrance: input.enabled ? { ...rest, serveWhileStandingIn: true } : rest,
  });
  input.record({ change: "public-standby-serve-changed", actingPrincipal: input.principal });
  return { status: "changed", enabled: input.enabled };
}

/**
 * Where a standby's public URL would be, for senders that accept a fallback:
 * its Tailscale name, on the Funnel port this host turned on when the standby
 * is this host, and on 443 for another standby, whose port only its own
 * person knows (`portKnown` says which).
 */
export function standbyPublicUrls(
  link: HubLinkState | undefined,
  ownFunnelPort?: number,
): ReadonlyArray<{
  readonly memberId: string;
  readonly name: string;
  readonly url: string;
  readonly portKnown: boolean;
}> {
  const anchor = link === undefined ? undefined : hubSignedAnchor(link);
  if (anchor === undefined) return [];
  return anchor.roster.standbyOrder.flatMap((id) => {
    const entry = anchor.roster.members.find(
      (member) => String(member.memberId) === String(id) && member.role === "standby-hub",
    );
    const name = entry?.privateNames.find((candidate) => candidate.endsWith(".ts.net"));
    if (entry === undefined || name === undefined) return [];
    const own = link !== undefined && String(id) === String(link.selfMemberId);
    const port = own ? (ownFunnelPort ?? 443) : 443;
    return [
      {
        memberId: String(id),
        name: entry.name,
        url: port === 443 ? `https://${name}` : `https://${name}:${port}`,
        portKnown: own && ownFunnelPort !== undefined,
      },
    ];
  });
}

/**
 * Hands the hub every delivery this standby still queues, one request each,
 * and reports what the hub took, what it can never take, and whether the hub
 * refuses hand-back altogether. Only a delivery the hub queued, or already
 * holds, is taken: the spoke's claims are the final dedupe either way. A hub
 * whose queue is full leaves the rest for the next attempt.
 */
export async function handBackWebhookQueue(input: {
  readonly link: HubLinkState;
  readonly identity: HubHostIdentity;
  readonly transport: HubTransport;
  readonly queue: ReadonlyArray<HubWebhookHandback>;
  readonly now: () => number;
}): Promise<{
  readonly taken: ReadonlyArray<HubWebhookHandback>;
  /** Deliveries the hub can never take: their endpoint is gone, or the entry is unreadable. */
  readonly dropped: ReadonlyArray<HubWebhookHandback>;
  /** `refused`: the hub no longer takes hand-back from this host at all. */
  readonly outcome: "complete" | "incomplete" | "refused";
}> {
  const taken: HubWebhookHandback[] = [];
  const dropped: HubWebhookHandback[] = [];
  // The hub counts room per endpoint, so one full endpoint waits for the next
  // attempt while the others are handed back now.
  const full = new Set<string>();
  for (const queued of input.queue) {
    const endpointId = String(queued.envelope.endpointId);
    if (full.has(endpointId)) continue;
    const answer = await sendHubLinkRequest({
      transport: input.transport,
      target: {
        origin: input.link.hubOrigin,
        pin: listenerPinFromDigest(input.link.hubListenerPin),
      },
      signHostPayload: input.identity.signing.signHostPayload,
      senderMemberId: String(input.link.selfMemberId),
      recipientMemberId: String(input.link.hubMemberId),
      method: "POST",
      path: PUBLIC_WEBHOOK_HANDBACK_ROUTE,
      body: JSON.stringify(queued),
      headers: { [HUB_PEER_KEY_HEADER]: input.identity.signing.hostPublicKey },
      now: input.now(),
    });
    if (answer.status === "unreachable") return { taken, dropped, outcome: "incomplete" };
    // A hub from before hand-back has no such route and answers 404. It can
    // never take the queue, so it counts as refusing it, rather than keeping
    // this host standing in until the hub is upgraded.
    if (answer.response.status === 403 || answer.response.status === 404) {
      return { taken, dropped, outcome: "refused" };
    }
    if (answer.response.status === 400) {
      dropped.push(queued);
      continue;
    }
    if (!answer.response.ok) return { taken, dropped, outcome: "incomplete" };
    const status = await answer.response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "status" in body ? body.status : undefined,
      )
      .catch(() => undefined);
    if (status === "queued" || status === "duplicate") taken.push(queued);
    // An endpoint the hub no longer holds, or a delivery whose signature its
    // own copy of the secret does not match, is one the hub will never take.
    else if (status === "unknown-endpoint" || status === "refused") dropped.push(queued);
    else if (status === "queue-full") full.add(endpointId);
    else return { taken, dropped, outcome: "incomplete" };
  }
  return { taken, dropped, outcome: full.size > 0 ? "incomplete" : "complete" };
}

/**
 * One hand-back attempt for the webhook queue, true when the stand-in may go
 * on to hand back its membership. A hub that refuses hand-back (it no longer
 * names this host a standby, or runs without webhooks) cannot take what is
 * left, and holding on would keep this host standing in forever, so what it
 * cannot take is dropped on the record.
 */
export async function handBackPublicQueue(input: {
  readonly webhooks: Pick<HubWebhookService, "handbackQueue" | "handedBack" | "dropHandback">;
  readonly link: HubLinkState;
  readonly identity: HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
}): Promise<boolean> {
  const queue = input.webhooks.handbackQueue();
  if (queue.length === 0) return true;
  const result = await handBackWebhookQueue({ ...input, queue });
  input.webhooks.handedBack(result.taken);
  input.webhooks.dropHandback(
    result.outcome === "refused" ? input.webhooks.handbackQueue() : result.dropped,
  );
  return result.outcome !== "incomplete";
}
