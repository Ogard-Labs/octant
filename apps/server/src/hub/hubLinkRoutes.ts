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
  decodeHubStandInHandback,
  decodeHubWakeCopy,
  decodeHubWakeNudge,
  decodeHubWakeReport,
  decodeSignedHubRoster,
  encodeSignedHubRoster,
} from "@octant/contracts";
import type { FailoverService } from "./failoverService";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { SpokeWakeService } from "./spokeWakeService";
import type { WakeService } from "./wakeService";

export const HUB_LINK_ROUTES = {
  join: "/api/hub/join",
  leave: "/api/hub/leave",
  roster: "/api/hub/roster",
  status: "/api/hub/status",
  /** The hub asks a spoke whether its person ticked Standby, when the person names it a standby. */
  standby: "/api/hub/standby",
  /** A member asks the hub, or a standby that is standing in, whether it is there. */
  heartbeat: "/api/hub/heartbeat",
  /** A standby that stood in hands its membership changes back to the hub. */
  handback: "/api/hub/handback",
  /** A guest reads the current signed roster from the hub. */
  guestRoster: "/api/hub/guest-roster",
  /** A guest asks a spoke to admit it as a paired device. */
  guest: "/api/hub/guest",
  /** A spoke whose hub grant ticks Wake tells the hub, or a standing-in standby, its routines' next times. */
  wakeTimes: "/api/hub/wake-times",
  /** The hub, or a standing-in standby, nudges a spoke shortly before one of its routines is due. */
  wakeNudge: "/api/hub/wake-nudge",
  /** The hub hands a standby the wake times it holds. */
  wakeCopy: "/api/hub/wake-copy",
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
  readonly failover: FailoverService;
  readonly wake: WakeService;
  readonly spokeWake: SpokeWakeService;
  readonly now?: () => number;
}

/** Refusals that mean the sender is not who a spoke trusts, as opposed to a grant it did not give. */
const SENDER_REFUSAL_STATUS: ReadonlySet<string> = new Set([
  "missing",
  "malformed",
  "stale",
  "unknown-sender",
  "signature-invalid",
  "replayed",
  "not-a-spoke",
  "hub-revoked",
]);

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
      route === HUB_LINK_ROUTES.roster ||
      route === HUB_LINK_ROUTES.standby ||
      route === HUB_LINK_ROUTES.wakeCopy
        ? "PUT"
        : route === HUB_LINK_ROUTES.status ||
            route === HUB_LINK_ROUTES.guestRoster ||
            route === HUB_LINK_ROUTES.heartbeat
          ? "GET"
          : "POST";
    if (request.method !== expectedMethod || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request);
    if (body === undefined) return refused(413, "invalid");
    const header = request.headers.get(HUB_LINK_HEADER);
    const presentedKey = request.headers.get(HUB_PEER_KEY_HEADER);

    if (route === HUB_LINK_ROUTES.status || route === HUB_LINK_ROUTES.standby) {
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      // The hub asks whether this spoke's person ticked Standby before it names
      // the spoke one; the answer is the grant, nothing more.
      const allowed = options.spoke.hubMayUse(
        route === HUB_LINK_ROUTES.status ? "status" : "standby",
      );
      if (allowed.status === "refused") return refused(403, allowed.kind);
      if (route === HUB_LINK_ROUTES.standby) {
        return Response.json({ status: "accepted" }, { headers: NO_STORE });
      }
      const status = options.spoke.readStatus();
      return status === undefined
        ? refused(403, "not-a-spoke")
        : Response.json({ status }, { headers: NO_STORE });
    }

    if (route === HUB_LINK_ROUTES.roster) {
      const sender = options.spoke.authenticateRosterSender({
        header,
        publicKey: presentedKey,
        method: request.method,
        path: route,
        body,
      });
      if (sender.status === "refused") {
        return refused(SENDER_REFUSAL_STATUS.has(sender.kind) ? 401 : 403, sender.kind);
      }
      const allowed = options.spoke.hubMayUse("roster");
      if (allowed.status === "refused") return refused(403, allowed.kind);
      let candidate;
      try {
        candidate = decodeSignedHubRoster(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // The roster must be signed by the very member that sent it.
      const signer = candidate.signedBy;
      if (
        sender.status === "hub"
          ? signer.kind !== "hub"
          : signer.kind !== "standby" || String(signer.memberId) !== String(sender.memberId)
      ) {
        return refused(403, "signer-not-sender");
      }
      // A standby's roster is accepted only while this spoke cannot reach the hub.
      const receipt =
        sender.status === "standby" && presentedKey !== null
          ? options.spoke.receiveRoster(candidate, {
              publicKey: presentedKey,
              hubReachable: !(await options.failover.hubUnreachable()),
            })
          : options.spoke.receiveRoster(candidate);
      return receipt.status === "accepted"
        ? Response.json(receipt, { headers: NO_STORE })
        : refused(409, receipt.kind);
    }

    if (route === HUB_LINK_ROUTES.wakeNudge) {
      const sender = options.spoke.authenticateRosterSender({
        header,
        publicKey: presentedKey,
        method: request.method,
        path: route,
        body,
      });
      if (sender.status === "refused") {
        return refused(SENDER_REFUSAL_STATUS.has(sender.kind) ? 401 : 403, sender.kind);
      }
      let nudge;
      try {
        nudge = decodeHubWakeNudge(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // Only the hub, or a named standby, reaches this far; the spoke's own grant
      // and its own routines decide what the nudge is worth.
      const result = await options.spokeWake.receiveNudge(
        sender.status === "hub"
          ? { kind: "hub", memberId: sender.principal.memberId }
          : { kind: "standby", memberId: sender.memberId },
        nudge,
      );
      return result.status === "refused"
        ? refused(403, result.kind)
        : Response.json(result, { headers: NO_STORE });
    }

    if (route === HUB_LINK_ROUTES.wakeCopy) {
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      // A copy of the wake times is what a standby holds, so only a spoke whose person ticked Standby takes one.
      const allowed = options.spoke.hubMayUse("standby");
      if (allowed.status === "refused") return refused(403, allowed.kind);
      let copy;
      try {
        copy = decodeHubWakeCopy(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const held = options.wake.receiveCopy(copy);
      return held.status === "recorded"
        ? Response.json(held, { headers: NO_STORE })
        : refused(403, held.kind);
    }

    if (route === HUB_LINK_ROUTES.wakeTimes) {
      const hubOn = options.hub.status().enabled;
      if (!hubOn && !options.failover.standingIn()) return refused(403, "hub-role-off");
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) =>
          hubOn
            ? options.hub.memberKey(sender, presentedKey ?? undefined)
            : options.failover.memberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      let report;
      try {
        report = decodeHubWakeReport(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // The report is filed under the member whose key signed it; the body names no one.
      const recorded = await options.wake.receiveReport(verified.senderMemberId, report);
      return recorded.status === "recorded"
        ? Response.json(recorded, { headers: NO_STORE })
        : refused(403, recorded.kind);
    }

    if (route === HUB_LINK_ROUTES.heartbeat) {
      const hubOn = options.hub.status().enabled;
      if (!hubOn && !options.failover.standingIn()) return refused(403, "hub-role-off");
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) =>
          hubOn
            ? options.hub.memberKey(sender, presentedKey ?? undefined)
            : options.failover.memberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      const answer = hubOn ? options.hub.heartbeat() : options.failover.heartbeat();
      return answer === undefined
        ? refused(403, "hub-role-off")
        : Response.json(answer, { headers: NO_STORE });
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

    // The hub's side: a member completing its join or leaving. A standby that
    // is standing in answers a join too; nothing else of the hub's is its to serve.
    const hubOn = options.hub.status().enabled;
    const standsIn = !hubOn && route === HUB_LINK_ROUTES.join && options.failover.standingIn();
    if (!hubOn && !standsIn) return refused(403, "hub-role-off");
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
      const joined = standsIn
        ? options.failover.acceptJoin(joining)
        : options.hub.acceptJoin(joining);
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
      publicKeyFor: (sender) => options.hub.memberKey(sender, presentedKey ?? undefined),
    });
    if (verified.status === "refused") return refused(401, verified.kind);
    if (route === HUB_LINK_ROUTES.handback) {
      let handback;
      try {
        handback = decodeHubStandInHandback(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const merged = await options.hub.receiveHandback(verified.senderMemberId, handback);
      // The wake times the standby gathered are taken once the roster merge accepted it.
      if (merged.status === "merged") {
        options.wake.mergeHandback(verified.senderMemberId, handback.wakeTimes);
      }
      return merged.status === "merged"
        ? Response.json({ roster: encodeSignedHubRoster(merged.roster) }, { headers: NO_STORE })
        : refused(403, merged.kind);
    }
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

/** The request body as text, or undefined when it is over the member-link limit or cannot be read. */
export async function readBody(request: Request): Promise<string | undefined> {
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

export function refused(status: number, kind: string): Response {
  return Response.json({ status: "refused", kind }, { status, headers: NO_STORE });
}
