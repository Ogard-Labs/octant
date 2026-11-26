// The member-to-member requests behind visitor links, each signed with this
// host's identity key over the pinned private transport: a spoke handing the
// hub the grants it signed, and the acting hub asking the spoke that owns a
// link on every visitor request.

import {
  decodeVisitorFetchAnswer,
  type HubVisitorGrantsUpdate,
  type VisitorFetchAnswer,
  type VisitorFetchRequest,
} from "@octant/contracts";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort } from "./hubStateStore";
import { memberOrigin } from "./memberOrigin";
import type { HubTransport } from "./pinnedHubTransport";
import type { SpokeVisitorHubPort } from "./spokeVisitorService";

interface LinkDependencies {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
}

/** What a spoke reaches its hub through for visitor links; nothing when it has no hub. */
export function spokeVisitorHubPort(deps: LinkDependencies): SpokeVisitorHubPort {
  return {
    target: () => {
      const link = deps.state.load().link;
      return link === undefined || link.removed === true
        ? undefined
        : { memberId: String(link.hubMemberId) };
    },
    sendGrants: async (update: HubVisitorGrantsUpdate) => {
      const link = deps.state.load().link;
      if (link === undefined || link.removed === true) return false;
      const identity = deps.identity();
      const answer = await sendHubLinkRequest({
        transport: deps.transport,
        target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
        signHostPayload: identity.signing.signHostPayload,
        senderMemberId: String(link.selfMemberId),
        recipientMemberId: String(link.hubMemberId),
        method: "POST",
        path: HUB_LINK_ROUTES.publicVisitorGrants,
        body: JSON.stringify(update),
        headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
        now: deps.now(),
      });
      return answer.status === "answered" && answer.response.ok;
    },
  };
}

/** Asks the spoke that owns a link; undefined when it cannot be reached or did not answer. */
export async function askVisitorSpoke(
  deps: LinkDependencies & { readonly selfMemberId: () => string },
  spokeMemberId: string,
  request: VisitorFetchRequest,
): Promise<VisitorFetchAnswer | undefined> {
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
    path: HUB_LINK_ROUTES.publicVisitorFetch,
    body: JSON.stringify(request),
    headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
    now: deps.now(),
  });
  if (answer.status === "unreachable" || !answer.response.ok) return undefined;
  try {
    return decodeVisitorFetchAnswer(await answer.response.json());
  } catch {
    return undefined;
  }
}
