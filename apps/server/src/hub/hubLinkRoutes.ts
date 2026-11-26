// What members ask of each other on the private listener, outside any paired
// device's session: a joining member completing its join, a member leaving, and
// the hub sending a spoke a roster or reading its status. Every request is
// signed with the sender's identity key (see hubLink). A request from the hub
// resolves to the `hub` principal and is held to the hub grant; it reaches
// nothing else, because these are the only routes that accept that signature
// and the product routes never read it.

import {
  HubMemberId,
  decodeHubGuestAdmissionRequest,
  decodeHubJoinRequest,
  decodeHubLeaveRequest,
  decodeHubMirrorRequest,
  decodeHubOfferDelivery,
  decodeHubPushCopy,
  decodeHubSignInDelivery,
  decodeHubSignInOutcomeReport,
  decodeHubStandInHandback,
  decodeHubWakeCopy,
  decodeHubWakeNudge,
  decodeHubWakeReport,
  decodeHubWindowGuestRequest,
  decodeSignedHubRoster,
  encodeSignedHubRoster,
  ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { Schema } from "effect";
import { HUB_HANDBACK_MAX_BODY_BYTES, HUB_WAKE_COPY_MAX_BODY_BYTES } from "../remoteRoutePolicy";
import {
  PUBLIC_FORWARD_MAX_BODY_BYTES,
  decodeHubWebhookEndpointsUpdate,
  decodeWebhookDeliveryEnvelope,
  decodeHubVisitorGrantsUpdate,
  decodeVisitorFetchRequest,
} from "@octant/contracts";
import type { FailoverService } from "./failoverService";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { ProvisionService } from "./provisionService";
import type { HubWebhookService } from "./hubWebhookService";
import type { PublicEntranceService } from "./publicEntranceService";
import type { SpokeWebhookService } from "./spokeWebhookService";
import type { HubVisitorService } from "./hubVisitorService";
import type { SpokeVisitorService } from "./spokeVisitorService";
import { readForwardedRequest } from "./publicEntranceForwarding";
import type { PushService } from "./pushService";
import type { SignInService } from "./signInService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { SpokeProvisionService } from "./spokeProvisionService";
import type { SpokePushService } from "./spokePushService";
import type { SpokeSignInService } from "./spokeSignInService";
import type { SpokeWakeService } from "./spokeWakeService";
import type { WakeService } from "./wakeService";

export const HUB_LINK_ROUTES = {
  join: "/api/hub/join",
  leave: "/api/hub/leave",
  roster: "/api/hub/roster",
  status: "/api/hub/status",
  /**
   * The hub reads a spoke's plan-limit readings while its grant ticks Usage:
   * the provider-reported windows, never a credential, a thread or a cost.
   */
  usage: "/api/hub/usage",
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
  /** A spoke asks the hub to list its own desktop window as a guest. */
  windowGuest: "/api/hub/window-guest",
  /** A spoke whose hub grant ticks Wake tells the hub, or a standing-in standby, its routines' next times. */
  wakeTimes: "/api/hub/wake-times",
  /** The hub, or a standing-in standby, nudges a spoke shortly before one of its routines is due. */
  wakeNudge: "/api/hub/wake-nudge",
  /** The hub hands a standby the wake times it holds. */
  wakeCopy: "/api/hub/wake-copy",
  /** A spoke whose hub grant ticks Push hands the hub, or a standing-in standby, a sealed delivery request to forward. */
  push: "/api/hub/push",
  /** The hub, or a standing-in standby, asks a spoke whether its grant ticks Push before it forwards. */
  pushGrant: "/api/hub/push-grant",
  /** The hub tells a standby whether its push switch is on. */
  pushCopy: "/api/hub/push-copy",
  /** The hub hands a spoke whose grant ticks Provision an offer, which the spoke holds as a proposal. */
  provisionOffer: "/api/hub/provision-offer",
  /** A spoke asks the hub for the signed update feed document an offer mirrors. */
  provisionMirror: "/api/hub/provision-mirror",
  /** The hub asks a spoke whose grant ticks Sign-in to sign in to a provider account; the spoke's person decides. */
  signInRequest: "/api/hub/sign-in-request",
  /** A spoke tells the hub one word about how a sign-in request ended. */
  signInOutcome: "/api/hub/sign-in-outcome",
  /** A member's public entrance hands the acting hub a request it admitted from the internet. */
  publicForward: "/api/hub/public/forward",
  /** A spoke asks the hub for the key it seals webhook secrets to. */
  publicSealingKey: "/api/hub/public/sealing-key",
  /** A spoke whose person ticked Public hands the hub its webhook endpoints, secrets sealed. */
  publicWebhookEndpoints: "/api/hub/public/webhook-endpoints",
  /** The acting hub hands a spoke a webhook delivery it queued for it. */
  publicWebhookDelivery: "/api/hub/public/webhook-delivery",
  /** A spoke whose person ticked Public hands the hub the visitor-link grants it signed. */
  publicVisitorGrants: "/api/hub/public/visitor-grants",
  /** The acting hub asks the spoke that owns a link on every visitor request. */
  publicVisitorFetch: "/api/hub/public/visitor-fetch",
} as const;

const decodeHubMemberId = Schema.decodeUnknownSync(HubMemberId);
const encodeProviderUsageLimitsSnapshot = Schema.encodeSync(ProviderUsageLimitsSnapshot);

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
/** A forwarded request carries its body as base64 inside JSON. */
const FORWARD_MAX_BODY_BYTES = Math.ceil((PUBLIC_FORWARD_MAX_BODY_BYTES * 4) / 3) + 16 * 1_024;
const NO_STORE = { "cache-control": "no-store" } as const;

export interface HubLinkRouteOptions {
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly failover: FailoverService;
  readonly wake: WakeService;
  readonly spokeWake: SpokeWakeService;
  readonly push: PushService;
  readonly spokePush: SpokePushService;
  readonly provision: ProvisionService;
  readonly spokeProvision: SpokeProvisionService;
  readonly signIn: SignInService;
  readonly spokeSignIn: SpokeSignInService;
  /** This computer's provider plan-limit readings, as its own Limits view reads them. */
  readonly readUsageLimits?: () => ProviderUsageLimitsSnapshot;
  /** This host's public entrance, which runs a request another member's entrance forwarded. */
  readonly publicEntrance?: Pick<PublicEntranceService, "dispatchForwarded">;
  /** The acting hub's webhook receipt: its sealing key and each spoke's endpoints. */
  readonly webhooks?: Pick<HubWebhookService, "sealingKey" | "receiveEndpoints">;
  /** This host's own webhook endpoints, as a spoke. */
  readonly spokeWebhooks?: Pick<SpokeWebhookService, "receive">;
  /** The acting hub's visitor links: each spoke's signed grants. */
  readonly visitors?: Pick<HubVisitorService, "receiveGrants">;
  /** This host's own visitor links, as a spoke. */
  readonly spokeVisitors?: Pick<SpokeVisitorService, "fetch">;
  readonly now?: () => number;
}

/** The HTTP status a forward's refusal answers with; every one is data the spoke reads, none an error to retry blindly. */
const PUSH_REFUSAL_STATUS: ReadonlyMap<string, number> = new Map([
  ["malformed", 400],
  ["too-large", 413],
  ["rate-limited", 429],
  ["gateway-mismatch", 409],
  ["handing-back", 409],
  ["gateway-unreachable", 502],
]);

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
): (
  request: Request,
  facts?: { readonly privateAddress?: string },
) => Promise<Response | undefined> {
  const memberVerifier = new HubLinkVerifier({ now: options.now ?? Date.now });
  return async (request, facts) => {
    const url = new URL(request.url);
    const route = (Object.values(HUB_LINK_ROUTES) as ReadonlyArray<string>).includes(url.pathname)
      ? (url.pathname as RouteValue)
      : undefined;
    if (route === undefined) return undefined;
    const expectedMethod =
      route === HUB_LINK_ROUTES.roster ||
      route === HUB_LINK_ROUTES.standby ||
      route === HUB_LINK_ROUTES.wakeCopy ||
      route === HUB_LINK_ROUTES.pushCopy
        ? "PUT"
        : route === HUB_LINK_ROUTES.status ||
            route === HUB_LINK_ROUTES.usage ||
            route === HUB_LINK_ROUTES.guestRoster ||
            route === HUB_LINK_ROUTES.heartbeat
          ? "GET"
          : "POST";
    if (request.method !== expectedMethod || url.search !== "") return refused(405, "invalid");
    const body = await readBody(
      request,
      route === HUB_LINK_ROUTES.handback
        ? HUB_HANDBACK_MAX_BODY_BYTES
        : route === HUB_LINK_ROUTES.wakeCopy
          ? HUB_WAKE_COPY_MAX_BODY_BYTES
          : route === HUB_LINK_ROUTES.publicForward ||
              route === HUB_LINK_ROUTES.publicWebhookDelivery ||
              route === HUB_LINK_ROUTES.publicWebhookEndpoints ||
              route === HUB_LINK_ROUTES.publicVisitorGrants
            ? FORWARD_MAX_BODY_BYTES
            : MAX_BODY_BYTES,
    );
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

    if (route === HUB_LINK_ROUTES.usage) {
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      // Off unless the person ticked Usage: the readings name this computer's
      // provider accounts, which the Status item never lets the hub see.
      const allowed = options.spoke.hubMayUse("usage");
      if (allowed.status === "refused") return refused(403, allowed.kind);
      if (options.readUsageLimits === undefined) return refused(404, "unavailable");
      return Response.json(
        { limits: encodeProviderUsageLimitsSnapshot(options.readUsageLimits()) },
        { headers: NO_STORE },
      );
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
      if (held.status === "recorded") return Response.json(held, { headers: NO_STORE });
      return refused(held.kind === "stale-copy" ? 409 : 403, held.kind);
    }

    if (route === HUB_LINK_ROUTES.pushGrant) {
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
      // Only the hub, or a named standby, reaches this far; the spoke's own grant answers.
      const result = await options.spokePush.checkGrant(
        sender.status === "hub"
          ? { kind: "hub", memberId: sender.principal.memberId }
          : { kind: "standby", memberId: sender.memberId },
      );
      return result.status === "refused"
        ? refused(403, result.kind)
        : Response.json(result, { headers: NO_STORE });
    }

    if (route === HUB_LINK_ROUTES.provisionOffer) {
      // Only the hub makes offers: a standby, a peer, and a guest are not the hub's key.
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      let delivery;
      try {
        delivery = decodeHubOfferDelivery(JSON.parse(body));
      } catch {
        // A secret-shaped field, an unknown field, or a malformed value never gets as far as a proposal.
        return refused(400, "malformed");
      }
      const receipt = await options.spokeProvision.receive(
        authenticated.principal.memberId,
        delivery,
      );
      return receipt.status === "proposed"
        ? Response.json(receipt, { status: 201, headers: NO_STORE })
        : refused(
            receipt.kind === "not-a-spoke" || receipt.kind === "hub-revoked" ? 401 : 403,
            receipt.kind,
          );
    }

    if (route === HUB_LINK_ROUTES.signInRequest) {
      // Only the hub asks: a standby, a peer, and a guest are not the hub's key.
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      let delivery;
      try {
        delivery = decodeHubSignInDelivery(JSON.parse(body));
      } catch {
        // A field that could carry a code, an address, or a name never gets as far as a question.
        return refused(400, "malformed");
      }
      const receipt = await options.spokeSignIn.receive(authenticated.principal.memberId, delivery);
      return receipt.status === "asked"
        ? Response.json(receipt, { status: 201, headers: NO_STORE })
        : refused(
            receipt.kind === "not-a-spoke" || receipt.kind === "hub-revoked" ? 401 : 403,
            receipt.kind,
          );
    }

    if (route === HUB_LINK_ROUTES.signInOutcome) {
      const hubOn = options.hub.status().enabled;
      if (!hubOn) return refused(403, "hub-role-off");
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) => options.hub.memberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      let report;
      try {
        report = decodeHubSignInOutcomeReport(JSON.parse(body));
      } catch {
        return refused(400, "malformed");
      }
      const receipt = options.signIn.receiveOutcome(verified.senderMemberId, report);
      return receipt.status === "recorded"
        ? Response.json(receipt, { headers: NO_STORE })
        : refused(403, receipt.kind);
    }

    if (route === HUB_LINK_ROUTES.provisionMirror) {
      const hubOn = options.hub.status().enabled;
      if (!hubOn) return refused(403, "hub-role-off");
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) => options.hub.memberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      let mirrorRequest;
      try {
        mirrorRequest = decodeHubMirrorRequest(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const served = options.provision.serveMirror(verified.senderMemberId, mirrorRequest.offerId);
      // The bytes go out exactly as the hub holds them; the spoke checks their signature.
      return served.status === "served"
        ? new Response(served.bytes, {
            headers: { ...NO_STORE, "content-type": "application/json" },
          })
        : refused(403, served.kind);
    }

    if (route === HUB_LINK_ROUTES.pushCopy) {
      const authenticated = options.spoke.authenticateHub({
        header,
        method: request.method,
        path: route,
        body,
      });
      if (authenticated.status === "refused") return refused(401, authenticated.kind);
      // Whether the switch is on matters only to a standby, so only a spoke whose person ticked Standby takes it.
      const allowed = options.spoke.hubMayUse("standby");
      if (allowed.status === "refused") return refused(403, allowed.kind);
      let copy;
      try {
        copy = decodeHubPushCopy(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const held = options.push.receiveCopy(copy);
      return held.status === "recorded"
        ? Response.json(held, { headers: NO_STORE })
        : refused(403, held.kind);
    }

    if (route === HUB_LINK_ROUTES.publicForward) {
      // Only the acting hub serves the entrance; a member that is not forwards here.
      if (!options.hub.status().enabled) return refused(403, "hub-role-off");
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) => options.hub.memberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      const envelope = readForwardedRequest(body);
      if (envelope === undefined || options.publicEntrance === undefined) {
        return refused(envelope === undefined ? 400 : 404, "invalid");
      }
      return Response.json(await options.publicEntrance.dispatchForwarded(envelope), {
        headers: NO_STORE,
      });
    }

    if (
      route === HUB_LINK_ROUTES.publicSealingKey ||
      route === HUB_LINK_ROUTES.publicWebhookEndpoints
    ) {
      if (!options.hub.status().enabled || options.webhooks === undefined) {
        return refused(403, "hub-role-off");
      }
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        // A guest owns no routine, so it cannot put a webhook on the internet.
        publicKeyFor: (sender) => options.hub.hostMemberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      if (route === HUB_LINK_ROUTES.publicSealingKey) {
        return Response.json(options.webhooks.sealingKey(), { headers: NO_STORE });
      }
      let update;
      try {
        update = decodeHubWebhookEndpointsUpdate(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // A spoke hands over only its own endpoints; any other is dropped.
      return Response.json(options.webhooks.receiveEndpoints(verified.senderMemberId, update), {
        headers: NO_STORE,
      });
    }

    if (route === HUB_LINK_ROUTES.publicVisitorGrants) {
      if (!options.hub.status().enabled || options.visitors === undefined) {
        return refused(403, "hub-role-off");
      }
      const verified = memberVerifier.verify({
        header,
        method: request.method,
        path: route,
        body,
        recipientMemberId: options.hub.hubMemberId(),
        // A guest owns no thread, so it cannot put a visitor link on the internet.
        publicKeyFor: (sender) => options.hub.hostMemberKey(sender, presentedKey ?? undefined),
      });
      if (verified.status === "refused") return refused(401, verified.kind);
      let update;
      try {
        update = decodeHubVisitorGrantsUpdate(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // A spoke hands over only grants it signed for itself; any other is dropped.
      return Response.json(options.visitors.receiveGrants(verified.senderMemberId, update), {
        headers: NO_STORE,
      });
    }

    if (route === HUB_LINK_ROUTES.publicVisitorFetch) {
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
      // A named standby serves a visitor only while it stands in: for a spoke
      // whose person ticked Standby, and only while this spoke cannot reach the
      // hub. Roster identity alone would let it read a shared thread any time.
      if (sender.status === "standby") {
        const allowed = options.spoke.hubMayUse("standby");
        if (allowed.status === "refused") return refused(403, allowed.kind);
        if (!(await options.failover.hubUnreachable())) return refused(403, "hub-reachable");
      }
      if (options.spokeVisitors === undefined) return refused(404, "invalid");
      let fetchRequest;
      try {
        fetchRequest = decodeVisitorFetchRequest(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      const askedBy =
        sender.status === "hub" ? String(sender.principal.memberId) : String(sender.memberId);
      // The spoke checks its Public item, the link, its thread, and the browser itself.
      return Response.json(options.spokeVisitors.fetch(fetchRequest, askedBy), {
        headers: NO_STORE,
      });
    }

    if (route === HUB_LINK_ROUTES.publicWebhookDelivery) {
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
      if (options.spokeWebhooks === undefined) return refused(404, "invalid");
      let envelope;
      try {
        envelope = decodeWebhookDeliveryEnvelope(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // The spoke checks its Public item, the bytes, and its own claims itself.
      return Response.json(options.spokeWebhooks.receive(envelope), { headers: NO_STORE });
    }

    if (route === HUB_LINK_ROUTES.push) {
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return refused(400, "invalid");
      }
      // The delivery request is filed under the member whose key signed the link request; the body names no one.
      const forwarded = await options.push.forward(verified.senderMemberId, parsed);
      return forwarded.status === "forwarded"
        ? Response.json(forwarded.answer, { headers: NO_STORE })
        : refused(PUSH_REFUSAL_STATUS.get(forwarded.kind) ?? 403, forwarded.kind);
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
      return recorded.status === "refused"
        ? refused(403, recorded.kind)
        : Response.json(recorded, { headers: NO_STORE });
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
      const signed = { header, method: request.method, path: route, body, request: admission };
      // The hub admits only a member's own desktop window, which its own Act
      // list then bounds; a spoke admits the guests it accepted.
      if (options.hub.status().enabled) {
        const admitted = options.hub.admitWindowGuest({
          ...signed,
          ...(facts?.privateAddress === undefined ? {} : { privateAddress: facts.privateAddress }),
        });
        return admitted.status === "admitted"
          ? Response.json(
              { spokeMemberId: admitted.hubMemberId, deviceId: admitted.deviceId },
              { status: 201, headers: NO_STORE },
            )
          : refused(GUEST_REFUSAL_STATUS.has(admitted.kind) ? 401 : 403, admitted.kind);
      }
      const admitted = options.spoke.admitGuest({
        ...signed,
        ...(facts?.privateAddress === undefined ? {} : { privateAddress: facts.privateAddress }),
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
    if (route === HUB_LINK_ROUTES.windowGuest) {
      let asked;
      try {
        asked = decodeHubWindowGuestRequest(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // The window is the signing member's own: a member never names another's.
      const introduced = await options.hub.introduceWindowGuest(
        { ...asked, introducedBy: verified.senderMemberId },
        { kind: "peer", memberId: decodeHubMemberId(verified.senderMemberId) },
      );
      return introduced.status === "refused"
        ? refused(403, introduced.kind)
        : Response.json(introduced, { headers: NO_STORE });
    }
    if (route === HUB_LINK_ROUTES.handback) {
      let handback;
      try {
        handback = decodeHubStandInHandback(JSON.parse(body));
      } catch {
        return refused(400, "invalid");
      }
      // The wake times the standby gathered are taken once the roster merge accepted it, and
      // before the roster reaches any spoke, so a report a spoke then sends the hub is not
      // overwritten.
      const merged = await options.hub.receiveHandback(verified.senderMemberId, handback, () => {
        options.wake.mergeHandback(verified.senderMemberId, handback.wakeTimes);
      });
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
export async function readBody(
  request: Request,
  limit: number = MAX_BODY_BYTES,
): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  return Buffer.byteLength(text, "utf8") > limit ? undefined : text;
}

export function refused(status: number, kind: string): Response {
  return Response.json({ status: "refused", kind }, { status, headers: NO_STORE });
}
