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
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeWebhookHubPort } from "./spokeWebhookService";

interface LinkDependencies {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
}

/** What a spoke reaches its hub through for webhooks; nothing when it has no hub. */
export function spokeWebhookHubPort(deps: LinkDependencies): SpokeWebhookHubPort {
  const toHub = async (path: string, body: unknown) => {
    const link = deps.state.load().link;
    if (link === undefined || link.removed === true) return undefined;
    const identity = deps.identity();
    const answer = await sendHubLinkRequest({
      transport: deps.transport,
      target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
      signHostPayload: identity.signing.signHostPayload,
      senderMemberId: String(link.selfMemberId),
      recipientMemberId: String(link.hubMemberId),
      method: "POST",
      path,
      body: JSON.stringify(body),
      headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
      now: deps.now(),
    });
    return answer.status === "answered" && answer.response.ok ? answer.response : undefined;
  };
  return {
    target: () => {
      const link = deps.state.load().link;
      if (link === undefined || link.removed === true) return undefined;
      const hub = link.roster.roster.members.find(
        (member) => String(member.memberId) === String(link.hubMemberId),
      );
      return hub === undefined
        ? undefined
        : { memberId: String(link.hubMemberId), fingerprint: hub.identityKeyFingerprint };
    },
    sealingKey: async (): Promise<HubSealingKey | undefined> => {
      const response = await toHub(HUB_LINK_ROUTES.publicSealingKey, {});
      try {
        return response === undefined ? undefined : decodeHubSealingKey(await response.json());
      } catch {
        return undefined;
      }
    },
    sendEndpoints: async (update: HubWebhookEndpointsUpdate) =>
      (await toHub(HUB_LINK_ROUTES.publicWebhookEndpoints, update)) !== undefined,
  };
}

/** Hands one queued delivery to its spoke; undefined when the spoke cannot be reached. */
export async function sendWebhookDelivery(
  deps: LinkDependencies & { readonly selfMemberId: () => string },
  spokeMemberId: string,
  envelope: WebhookDeliveryEnvelope,
): Promise<WebhookDeliveryAnswer | undefined> {
  const state = deps.state.load();
  const member = state.hub?.roster?.roster.members.find(
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
