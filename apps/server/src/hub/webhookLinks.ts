// The member-to-member requests behind webhook receipt, each signed with this
// host's identity key over the pinned private transport: a spoke asking the
// hub for its sealing key and handing it its endpoints, and the acting hub
// handing a spoke one delivery it queued.

import {
  decodeHubSealingKey,
  decodeWebhookDeliveryAnswer,
  type HubSealingKey,
  type HubWebhookEndpointsUpdate,
  type WebhookDeliveryAnswer,
  type WebhookDeliveryEnvelope,
} from "@octant/contracts";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import {
  isSelf,
  publicCopyTargets,
  servingRosterMembers,
  type OwnPublicServices,
} from "./publicStandIn";
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeWebhookHubPort } from "./spokeWebhookService";

interface LinkDependencies {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
  /** This host's own services, for the copies and deliveries that name it. */
  readonly own?: () => OwnPublicServices;
}

/**
 * What a spoke reaches its hub through for webhooks, and each named standby
 * when its person ticked Standby; nothing when it has no hub.
 */
export function spokeWebhookHubPort(
  deps: LinkDependencies & { readonly standbyGranted: () => boolean },
): SpokeWebhookHubPort {
  const targets = () => publicCopyTargets(deps.state.load().link, deps.standbyGranted());
  const toMember = async (memberId: string, path: string, body: unknown) => {
    const link = deps.state.load().link;
    // Any named standby is reachable, so one the person withdrew can be sent
    // an empty list; the service sends endpoints only to `targets`.
    const target = publicCopyTargets(link, true).find((entry) => entry.memberId === memberId);
    if (link === undefined || target === undefined) return undefined;
    const identity = deps.identity();
    const answer = await sendHubLinkRequest({
      transport: deps.transport,
      target: { origin: target.origin, pin: listenerPinFromDigest(target.pin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: memberId,
      method: "POST",
      path,
      body: JSON.stringify(body),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: deps.now(),
    });
    return answer.status === "answered" && answer.response.ok ? answer.response : undefined;
  };
  return {
    targets: () => targets().map(({ memberId, fingerprint }) => ({ memberId, fingerprint })),
    named: () => publicCopyTargets(deps.state.load().link, true).map((entry) => entry.memberId),
    sealingKey: async (memberId): Promise<HubSealingKey | undefined> => {
      const own = deps.own?.();
      if (own !== undefined && isSelf(deps.state.load(), memberId))
        return own.webhooks.sealingKey();
      const response = await toMember(memberId, HUB_LINK_ROUTES.publicSealingKey, {});
      try {
        return response === undefined ? undefined : decodeHubSealingKey(await response.json());
      } catch {
        return undefined;
      }
    },
    sendEndpoints: async (memberId, update: HubWebhookEndpointsUpdate) => {
      const own = deps.own?.();
      if (own !== undefined && isSelf(deps.state.load(), memberId)) {
        own.webhooks.receiveEndpoints(memberId, update);
        return true;
      }
      return (
        (await toMember(memberId, HUB_LINK_ROUTES.publicWebhookEndpoints, update)) !== undefined
      );
    },
  };
}

/** Hands one queued delivery to its spoke; undefined when the spoke cannot be reached. */
export async function sendWebhookDelivery(
  deps: LinkDependencies & { readonly selfMemberId: () => string },
  spokeMemberId: string,
  envelope: WebhookDeliveryEnvelope,
): Promise<WebhookDeliveryAnswer | undefined> {
  const state = deps.state.load();
  const own = deps.own?.();
  if (own !== undefined && isSelf(state, spokeMemberId)) return own.spokeWebhooks.receive(envelope);
  // A standing-in standby reads the roster it holds as a member.
  const member = servingRosterMembers(state).find(
    (entry) => String(entry.memberId) === spokeMemberId,
  );
  if (member === undefined) return undefined;
  const origin =
    state.hub?.members.find((record) => String(record.memberId) === spokeMemberId)
      ?.listenerOrigin ?? memberOrigin(member);
  if (origin === undefined) return undefined;
  const identity = deps.identity();
  const answer = await sendHubLinkRequest({
    transport: deps.transport,
    target: { origin, pin: listenerPinFromDigest(member.listenerPin) },
    signHostPayload: identity.signing.signHostPayload,
    senderMemberId: deps.selfMemberId(),
    recipientMemberId: spokeMemberId,
    method: "POST",
    path: HUB_LINK_ROUTES.publicWebhookDelivery,
    body: JSON.stringify(envelope),
    headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
    now: deps.now(),
  });
  // A refusal of the request itself (a stale signature, a roster the spoke has
  // not taken yet) is not the spoke's answer: the delivery waits for the next look.
  if (answer.status === "unreachable" || !answer.response.ok) return undefined;
  try {
    return decodeWebhookDeliveryAnswer(await answer.response.json());
  } catch {
    return undefined;
  }
}
