// A member's public entrance hands each admitted request to the acting hub over
// the pinned private transport (decision H30), so a front with connectors on
// several machines keeps one address and only the acting hub serves. The
// request travels on a member-to-member route signed with this host's identity
// key; the acting hub runs it through its own entrance as if it had arrived there.

import {
  decodePublicForwardAnswer,
  decodePublicForwardEnvelope,
  PUBLIC_FORWARD_MAX_WIRE_BYTES,
  type PublicForwardAnswer,
  type PublicForwardEnvelope,
} from "@octant/contracts";
import { listenerPinFromDigest } from "./hubCrypto";
import { HUB_PEER_KEY_HEADER, sendHubLinkRequest } from "./hubLink";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort } from "./hubStateStore";
import type { HubTransport } from "./pinnedHubTransport";

export const PUBLIC_FORWARD_ROUTE = "/api/hub/public/forward";

/** Sends one request to the hub this member follows; undefined when it cannot be reached or answers wrongly. */
export async function forwardToActingHub(input: {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly envelope: PublicForwardEnvelope;
  readonly now: number;
}): Promise<PublicForwardAnswer | undefined> {
  const link = input.state.load().link;
  if (link === undefined || link.removed === true) return undefined;
  const identity = input.identity();
  const answer = await sendHubLinkRequest({
    transport: input.transport,
    target: { origin: link.hubOrigin, pin: listenerPinFromDigest(link.hubListenerPin) },
    signHostPayload: identity.signing.signHostPayload,
    senderMemberId: String(link.selfMemberId),
    recipientMemberId: String(link.hubMemberId),
    method: "POST",
    path: PUBLIC_FORWARD_ROUTE,
    body: JSON.stringify(input.envelope),
    headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
    now: input.now,
    maxResponseBytes: PUBLIC_FORWARD_MAX_WIRE_BYTES,
  });
  if (answer.status === "unreachable" || !answer.response.ok) return undefined;
  try {
    return decodePublicForwardAnswer(await answer.response.json());
  } catch {
    return undefined;
  }
}

/** Reads a forwarded request on the acting hub; undefined for a body that is not one. */
export function readForwardedRequest(body: string): PublicForwardEnvelope | undefined {
  try {
    return decodePublicForwardEnvelope(JSON.parse(body));
  } catch {
    return undefined;
  }
}
