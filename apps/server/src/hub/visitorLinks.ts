// The member-to-member requests behind visitor links, each signed with this
// host's identity key over the pinned private transport: a spoke handing the
// hub the grants it signed, and the acting hub asking the spoke that owns a
// link on every visitor request.

import {
  VISITOR_FETCH_ANSWER_MAX_BYTES,
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
import { publicCopyTargets, servingRosterMembers } from "./publicStandIn";
import type { HubTransport } from "./pinnedHubTransport";
import { grantConfirmTimeoutMs } from "./pushService";
import type { SpokeVisitorHubPort } from "./spokeVisitorService";

interface LinkDependencies {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  readonly transport: HubTransport;
  readonly now: () => number;
}

/**
 * What a spoke reaches its hub through for visitor links, and each named
 * standby when its person ticked Standby; nothing when it has no hub. Grants
 * carry no secret, so every recipient gets the same update.
 */
export function spokeVisitorHubPort(
  deps: LinkDependencies & { readonly standbyGranted: () => boolean },
): SpokeVisitorHubPort {
  return {
    target: () => {
      const link = deps.state.load().link;
      return link === undefined || link.removed === true
        ? undefined
        : { memberId: String(link.hubMemberId) };
    },
    recipients: () =>
      publicCopyTargets(deps.state.load().link, deps.standbyGranted())
        .map((target) => target.memberId)
        .join(","),
    sendGrants: async (update: HubVisitorGrantsUpdate) => {
      const link = deps.state.load().link;
      const targets = publicCopyTargets(link, deps.standbyGranted());
      if (link === undefined || targets.length === 0) return false;
      const identity = deps.identity();
      let complete = true;
      // A standby that no longer takes copies (Standby unticked, or out of the
      // order) gets an empty list, so it holds nothing the person withdrew.
      const current = new Set(targets.map((target) => target.memberId));
      const withdrawn = publicCopyTargets(link, true).filter(
        (target) => !current.has(target.memberId),
      );
      const sends = [
        ...targets.map((target) => ({ target, body: update })),
        ...withdrawn.map((target) => ({ target, body: { grants: [] } })),
      ];
      for (const { target, body } of sends) {
        const answer = await sendHubLinkRequest({
          transport: deps.transport,
          target: { origin: target.origin, pin: listenerPinFromDigest(target.pin) },
          signHostPayload: identity.signing.signHostPayload,
          senderMemberId: String(link.selfMemberId),
          recipientMemberId: target.memberId,
          method: "POST",
          path: HUB_LINK_ROUTES.publicVisitorGrants,
          body: JSON.stringify(body),
          headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
          now: deps.now(),
        });
        if (answer.status !== "answered" || !answer.response.ok) complete = false;
      }
      return complete;
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
    path: HUB_LINK_ROUTES.publicVisitorFetch,
    body: JSON.stringify(request),
    headers: { [HUB_PEER_KEY_HEADER]: identity.signing.hostPublicKey },
    now: deps.now(),
    // A spoke asked by a standby first probes the hub, which can take a whole
    // link deadline when the hub hangs; the answer gets that long and a margin.
    timeoutMs: grantConfirmTimeoutMs(),
    maxResponseBytes: VISITOR_FETCH_ANSWER_MAX_BYTES,
  });
  if (answer.status === "unreachable" || !answer.response.ok) return undefined;
  try {
    return decodeVisitorFetchAnswer(await answer.response.json());
  } catch {
    return undefined;
  }
}
