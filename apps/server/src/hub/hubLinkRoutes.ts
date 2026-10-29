// What members ask of each other on the private listener, outside any paired
// device's session: a joining member completing its join, a member leaving, and
// the hub sending a spoke a roster or reading its status. Every request is
// signed with the sender's identity key (see hubLink). A request from the hub
// resolves to the `hub` principal and is held to the hub grant; it reaches
// nothing else, because these are the only routes that accept that signature
// and the product routes never read it.

import {
  decodeHubGuestAdmissionRequest,
  decodeHubJoinRequest,
  decodeHubLeaveRequest,
  decodeSignedHubRoster,
  encodeSignedHubRoster,
} from "@octant/contracts";
import { HUB_LINK_HEADER, HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { SpokeLinkService } from "./spokeLinkService";

export const HUB_LINK_ROUTES = {
  join: "/api/hub/join",
  leave: "/api/hub/leave",
  roster: "/api/hub/roster",
  status: "/api/hub/status",
  /** A guest reads the current signed roster from the hub. */
  guestRoster: "/api/hub/guest-roster",
  /** A guest asks a spoke to admit it as a paired device. */
  guest: "/api/hub/guest",
} as const;

type RouteValue = (typeof HUB_LINK_ROUTES)[keyof typeof HUB_LINK_ROUTES];

/** Refusals that mean the request did not prove who sent it, as opposed to a refusal of what it asked. */
const GUEST_REFUSAL_STATUS: ReadonlySet<string> = new Set([
  "missing",
  "malformed",
  "stale",
  "unknown-sender",
  "signature-invalid",
  "replayed",
]);

const MAX_BODY_BYTES = 64 * 1_024;
const NO_STORE = { "cache-control": "no-store" } as const;

export interface HubLinkRouteOptions {
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly now?: () => number;
}

export function createHubLinkRouteHandler(
  options: HubLinkRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const memberVerifier = new HubLinkVerifier({ now: options.now ?? Date.now });
  return async (request) => {
    const url = new URL(request.url);
    const route = (Object.values(HUB_LINK_ROUTES) as ReadonlyArray<string>).includes(url.pathname)
      ? (url.pathname as RouteValue)
      : undefined;
    if (route === undefined) return undefined;
    const expectedMethod =
      route === HUB_LINK_ROUTES.roster
        ? "PUT"
        : route === HUB_LINK_ROUTES.status || route === HUB_LINK_ROUTES.guestRoster
          ? "GET"
          : "POST";
    if (request.method !== expectedMethod || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request);
    if (body === undefined) return refused(413, "invalid");
    const header = request.headers.get(HUB_LINK_HEADER);

    if (route === HUB_LINK_ROUTES.roster || route === HUB_LINK_ROUTES.status) {
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      const item = route === HUB_LINK_ROUTES.roster ? "roster" : "status";
      const allowed = options.spoke.hubMayUse(item);
      if (allowed.status === "refused") return refused(403, allowed.kind);
      if (route === HUB_LINK_ROUTES.status) {
        const status = options.spoke.readStatus();
        return status === undefined
          ? refused(403, "not-a-spoke")
          : Response.json({ status }, { headers: NO_STORE });
      }
      let candidate;
      try {
        candidate = decodeSignedHubRoster(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const receipt = options.spoke.receiveRoster(candidate);
      return receipt.status === "accepted"
        ? Response.json(receipt, { headers: NO_STORE })
        : refused(409, receipt.kind);
    }

    if (route === HUB_LINK_ROUTES.guest) {
      let admission;
      try {
        admission = decodeHubGuestAdmissionRequest(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const admitted = options.spoke.admitGuest({
        header,
        method: request.method,
        path: route,
        body,
        request: admission,
      });
      return admitted.status === "admitted"
        ? Response.json(
            { spokeMemberId: admitted.spokeMemberId, deviceId: admitted.deviceId },
            { status: 201, headers: NO_STORE },
          )
        : refused(GUEST_REFUSAL_STATUS.has(admitted.kind) ? 401 : 403, admitted.kind);
    }

    // The hub's side: a member completing its join or leaving.
    if (!options.hub.status().enabled) return refused(403, "hub-role-off");
    if (route === HUB_LINK_ROUTES.guestRoster) {
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) => options.hub.guestKey(sender),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      const roster = options.hub.rosterForGuest();
      return roster === undefined
        ? refused(403, "hub-role-off")
        : Response.json({ roster: encodeSignedHubRoster(roster) }, { headers: NO_STORE });
    }
    if (route === HUB_LINK_ROUTES.join) {
      let joining;
      try {
        joining = decodeHubJoinRequest(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // A joining member is not known yet; its request is signed with the key
      // it names, which proves it holds that key.
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) =>
          sender === String(joining.member.memberId) ? joining.identityPublicKey : undefined,
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      const joined = options.hub.acceptJoin(joining);
      return joined.status === "joined"
        ? Response.json(
            {
              ...joined.response,
              roster: encodeSignedHubRoster(joined.response.roster),
            },
            { status: 201, headers: NO_STORE },
          )
        : refused(403, joined.kind);
    }
    const verified = memberVerifier.verify({
      header,
      method: request.method,
      path: route,
      body,
      recipientMemberId: options.hub.hubMemberId(),
      publicKeyFor: (sender) => options.hub.memberKey(sender),
    });
    if (verified.status === "refused") return refused(401, verified.kind);
    let leaving;
    try {
      leaving = decodeHubLeaveRequest(JSON.parse(body));
    } catch {
      return refused(400, "invalid");
    }
    // A member can only say that it left, never that another did.
    if (String(leaving.memberId) !== verified.senderMemberId) return refused(403, "not-the-sender");
    const left = await options.hub.receiveLeave(verified.senderMemberId);
    return left.status === "removed"
      ? Response.json({ status: "left", sequence: left.sequence }, { headers: NO_STORE })
      : refused(403, left.kind);
  };
}

async function readBody(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? undefined : text;
}

function refused(status: number, kind: string): Response {
  return Response.json({ status: "refused", kind }, { status, headers: NO_STORE });
}
