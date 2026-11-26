// The public entrance during failover (decision H30). A standby serves the
// entrance only while it stands in for the hub, only while it is not handing
// the stand-in back, and only if its own person chose to; the hub serves it
// whenever its role is on. A standby holds copies of the endpoints and grants
// of the spokes that ticked both Public and Standby, so it can serve the
// moment it stands in, and hands the hub back what it still queues.

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
 * A delivery that arrives during the hand-back is answered 404 so the sender
 * retries at the hub rather than into a queue that is being emptied.
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

/** A member a spoke hands its public copies to: the hub, and each named standby when the spoke ticked Standby. */
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
    if (String(id) === String(link.selfMemberId)) continue;
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
  return state.hub?.roster?.roster.members ?? state.link?.roster.roster.members ?? [];
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

/** Where a standby's public URL would be, for senders that accept a fallback: its Tailscale name on 443. */
export function standbyPublicUrls(
  link: HubLinkState | undefined,
): ReadonlyArray<{ readonly memberId: string; readonly name: string; readonly url: string }> {
  const anchor = link === undefined ? undefined : hubSignedAnchor(link);
  if (anchor === undefined) return [];
  return anchor.roster.standbyOrder.flatMap((id) => {
    const entry = anchor.roster.members.find(
      (member) => String(member.memberId) === String(id) && member.role === "standby-hub",
    );
    const name = entry?.privateNames.find((candidate) => candidate.endsWith(".ts.net"));
    return entry === undefined || name === undefined
      ? []
      : [{ memberId: String(id), name: entry.name, url: `https://${name}` }];
  });
}

/**
 * Hands the hub every delivery this standby still queues, one request each, and
 * reports which the hub took. A delivery the hub refuses as one it already
 * holds counts as taken: the spoke's claims are the final dedupe either way.
 */
export async function handBackWebhookQueue(input: {
  readonly link: HubLinkState;
  readonly identity: HubHostIdentity;
  readonly transport: HubTransport;
  readonly queue: ReadonlyArray<HubWebhookHandback>;
  readonly now: () => number;
}): Promise<{
  readonly taken: ReadonlyArray<HubWebhookHandback>;
  readonly complete: boolean;
}> {
  const taken: HubWebhookHandback[] = [];
  for (const queued of input.queue) {
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
    if (answer.status === "unreachable" || !answer.response.ok) {
      return { taken, complete: false };
    }
    taken.push(queued);
  }
  return { taken, complete: true };
}
