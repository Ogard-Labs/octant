// Loopback administration of the hub role and of this host's hub membership.
//
// Turning the hub role on or off, making a join code, removing a member,
// joining a hub, changing what the hub may do here, and leaving are a person's
// acts at this host. Like the private listener's own routes they answer only
// the loopback desktop bridge with an authenticated window capability, and
// refuse any request that carries an Origin header. A remote device, a peer, or
// the hub reaches them on no path: the private listener refuses this whole
// prefix, and a request signed as a member carries no window capability.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  decodeDelegationAcceptingRequest,
  decodeConfirmNewMembersRequest,
  decodeHubAcceptNewHubRequest,
  decodeHubActProjectsRequest,
  HubMemberId,
  decodeHubGrant,
  decodeHubWindowGuestRequest,
  type HubWindowComputers,
  decodeHubMemberReference,
  decodeHubPromoteRequest,
  decodeHubAutoApplyRequest,
  decodeHubDirectPushCredentialRemoveRequest,
  decodeHubDirectPushCredentialRequest,
  decodeHubDirectPushEnvironmentRequest,
  decodeHubDirectPushSwitchRequest,
  decodeHubOfferRequest,
  decodeHubOfferWithdrawRequest,
  decodeHubProposalDecisionRequest,
  decodeHubProvisionSwitchRequest,
  decodeHubPublicEntranceSwitchRequest,
  decodeHubPublicFunnelRequest,
  decodeHubPublicFrontsRequest,
  decodeHubPublicStandbyServeRequest,
  decodeHubWebhookCreateRequest,
  decodeHubVisitorCommentRequest,
  decodeHubVisitorLinkRequest,
  decodeHubVisitorShareRequest,
  decodeHubVisitorSwitchRequest,
  decodeHubRelaySwitchRequest,
  decodeHubRelayDeviceRequest,
  decodeHubWebhookEndpointRequest,
  decodeHubWebhookSecretRequest,
  decodeHubPushSwitchRequest,
  decodeHubSignInAsk,
  decodeHubSignInDecisionRequest,
  decodeHubStandbyOrderRequest,
  decodeHubWakeHardwareAddressRequest,
  decodeHubWakeSwitchRequest,
  decodeHubAcceptMovedThreadsRequest,
  decodeOwnerAdditionRequest,
  decodeOwnerAlertRequest,
  decodeOwnerMemberRequest,
  decodeOwnerRemovalRequest,
  decodePairedMergeUnlockRequest,
  decodeOwnerApprovalAnswerUnlockRequest,
  type AuditActingPrincipal,
} from "@octant/contracts";
import { Schema } from "effect";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { DirectPushService } from "./directPushService";
import type { FailoverService } from "./failoverService";
import type { HubService } from "./hubService";
import { windowComputersFrom } from "./memberOrigin";
import type { PairedMergeUnlockService } from "./pairedMergeUnlock";
import type { OwnerApprovalAnswerUnlock } from "./ownerApprovalAnswerUnlock";
import type { ProvisionService } from "./provisionService";
import type { HubWebhookService } from "./hubWebhookService";
import type { PublicEntranceService } from "./publicEntranceService";
import type { ServeWhileStandingInOutcome, standbyPublicUrls } from "./publicStandIn";
import type { SpokeWebhookService } from "./spokeWebhookService";
import type { HubRelayService } from "./hubRelayService";
import type { SpokeRelayService } from "./spokeRelayService";
import type { HubVisitorService } from "./hubVisitorService";
import type { SpokeVisitorService } from "./spokeVisitorService";
import type { PushService } from "./pushService";
import type { SignInService } from "./signInService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { SpokeProvisionService } from "./spokeProvisionService";
import type { SpokePushService } from "./spokePushService";
import type { SpokeSignInService } from "./spokeSignInService";
import type { SpokeWakeService } from "./spokeWakeService";
import type { TailscaleCertificateService } from "./tailscaleCertificate";
import type { WakeService } from "./wakeService";

const DEFAULT_BODY_LIMIT = 64 * 1_024;
const WINDOW_PRINCIPAL: AuditActingPrincipal = { kind: "local-window" };
const decodeHubMemberId = Schema.decodeUnknownSync(HubMemberId);

export const HUB_ADMINISTRATION_ROUTES = {
  status: "/api/desktop/hub/status",
  enable: "/api/desktop/hub/enable",
  disable: "/api/desktop/hub/disable",
  joinCode: "/api/desktop/hub/join-codes",
  remove: "/api/desktop/hub/members/remove",
  join: "/api/desktop/hub/join",
  joinFinish: "/api/desktop/hub/join/finish",
  grant: "/api/desktop/hub/grant",
  /**
   * This host's desktop window asks to be listed as a guest of the hub (by the
   * hub itself, or through this spoke's signed request), and reads the members
   * it may then reach directly.
   */
  windowGuest: "/api/desktop/hub/window-guest",
  leave: "/api/desktop/hub/leave",
  /** A window adds owner devices to this host's owner list: the hub's, or a spoke's after the person confirmed them by name and fingerprint. */
  ownersAdd: "/api/desktop/hub/owners/add",
  ownersRemove: "/api/desktop/hub/owners/remove",
  confirmNewMembers: "/api/desktop/hub/confirm-new-members",
  /** Whether this member takes delegated work from other members: a window turns it on or off. */
  delegationAccepting: "/api/desktop/hub/delegation-accepting",
  /** Whether a paired phone or web client's merge needs an owner unlock: only a window on this host turns it on or off. */
  pairedMergeUnlock: "/api/desktop/hub/paired-merge-unlock",
  ownerApprovalAnswerUnlock: "/api/desktop/hub/owner-approval-answer-unlock",
  confirmMember: "/api/desktop/hub/members/confirm",
  alertDismiss: "/api/desktop/hub/alerts/dismiss",
  alertRemove: "/api/desktop/hub/alerts/remove",
  /** The `*.ts.net` certificate for the web app: GET reads it, POST turns it on or off or renews it. */
  certificate: "/api/desktop/hub/certificate",
  /** The hub's window names the standby hubs in order. A standby never reaches this route for itself. */
  standbyOrder: "/api/desktop/hub/standby-order",
  /** A standby's own window, confirmed by the person, makes that host the hub for good. */
  promote: "/api/desktop/hub/promote",
  /** A spoke's own window accepts the standby that was promoted to hub. */
  acceptNewHub: "/api/desktop/hub/accept-new-hub",
  /** A standing-in standby's window makes a join code for a new member. */
  standInJoinCode: "/api/desktop/hub/stand-in/join-codes",
  /** A standing-in standby's window removes a member. */
  standInRemove: "/api/desktop/hub/stand-in/members/remove",
  /** The hub's wake service switch: only a window on the hub turns it on or off. */
  wake: "/api/desktop/hub/wake",
  /** Accept moved threads: only a window on the hub turns it on or off. */
  acceptMovedThreads: "/api/desktop/hub/accept-moved-threads",
  /** A window on the hub names the Projects here a member's desktop window may act in. */
  actProjects: "/api/desktop/hub/act-projects",
  /** A spoke's own window enters or clears this computer's hardware address. */
  wakeHardwareAddress: "/api/desktop/hub/wake/hardware-address",
  /** The hub's push switch: only a window on the hub turns it on or off. */
  push: "/api/desktop/hub/push",
  /** Direct sending: only a window on the hub turns it on, picks the Apple environment, or stores or removes a credential. */
  directPush: "/api/desktop/hub/direct-push",
  directPushEnvironment: "/api/desktop/hub/direct-push/environment",
  directPushCredential: "/api/desktop/hub/direct-push/credential",
  directPushCredentialRemove: "/api/desktop/hub/direct-push/credential/remove",
  /** This host's public entrance and its Funnel front: only a window on this host turns them on or off. */
  publicEntrance: "/api/desktop/hub/public",
  publicFunnel: "/api/desktop/hub/public/funnel",
  /** This host's own choice, as a standby, to serve the entrance while it stands in for the hub. */
  publicStandby: "/api/desktop/hub/public/standby",
  /** The Tailscale addresses of the person's own proxy on another machine; only a window on this host lists them. */
  publicFronts: "/api/desktop/hub/public/fronts",
  /** This spoke's webhook endpoints: only a window on this host mints, rotates or removes one. */
  webhookCreate: "/api/desktop/hub/webhooks/create",
  webhookRotate: "/api/desktop/hub/webhooks/rotate",
  webhookRemove: "/api/desktop/hub/webhooks/remove",
  /** The secret Stripe minted for one of this spoke's Stripe endpoints, pasted in a window on this host. */
  webhookSecret: "/api/desktop/hub/webhooks/secret",
  /** The hub's visitor-link switch, and this spoke's links and their comments: only a window on this host changes them. */
  visitorSwitch: "/api/desktop/hub/visitors",
  visitorShare: "/api/desktop/hub/visitors/share",
  visitorStop: "/api/desktop/hub/visitors/stop",
  visitorComment: "/api/desktop/hub/visitors/comment",
  /** The hub's device relay switch, and which of this host's paired devices may come through it. */
  relaySwitch: "/api/desktop/hub/relay",
  relayDevice: "/api/desktop/hub/relay/devices",
  /** The hub's offer switch: only a window on the hub turns it on or off. */
  provision: "/api/desktop/hub/provision",
  /** The hub's window makes an offer for its spokes. */
  provisionOffer: "/api/desktop/hub/provision/offers",
  provisionWithdraw: "/api/desktop/hub/provision/offers/withdraw",
  /** A spoke's own window applies or dismisses a proposal, and sets which kinds apply on arrival. */
  provisionApply: "/api/desktop/hub/provision/apply",
  provisionDismiss: "/api/desktop/hub/provision/dismiss",
  provisionAutoApply: "/api/desktop/hub/provision/auto-apply",
  /** The hub's window asks one spoke to sign in to a provider account. */
  signInAsk: "/api/desktop/hub/sign-in/ask",
  /** A spoke's own window accepts, declines, or checks a sign-in request. */
  signInAccept: "/api/desktop/hub/sign-in/accept",
  signInDecline: "/api/desktop/hub/sign-in/decline",
  signInCheck: "/api/desktop/hub/sign-in/check",
} as const;

type RouteValue = (typeof HUB_ADMINISTRATION_ROUTES)[keyof typeof HUB_ADMINISTRATION_ROUTES];

export interface HubAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  /** This member's switch for taking delegated work; absent where delegation is not composed. */
  readonly delegationAccepting?: {
    readonly read: () => boolean;
    readonly set: (accepting: boolean) => void;
  };
  readonly pairedMergeUnlock: PairedMergeUnlockService;
  readonly ownerApprovalAnswerUnlock: OwnerApprovalAnswerUnlock;
  readonly failover: FailoverService;
  readonly wake: WakeService;
  readonly spokeWake: SpokeWakeService;
  readonly push: PushService;
  readonly spokePush: SpokePushService;
  readonly directPush: DirectPushService;
  readonly provision: ProvisionService;
  readonly spokeProvision: SpokeProvisionService;
  readonly signIn: SignInService;
  readonly spokeSignIn: SpokeSignInService;
  readonly certificate: TailscaleCertificateService;
  /** Absent where the public entrance is not composed; its routes then answer unavailable. */
  readonly publicEntrance?: PublicEntranceService;
  /** A standby's own choice to serve the entrance while it stands in, and the standbys' public URLs. */
  readonly publicStandby?: {
    readonly set: (
      enabled: boolean,
      principal: AuditActingPrincipal,
    ) => ServeWhileStandingInOutcome;
    readonly standbyUrls: () => ReturnType<typeof standbyPublicUrls>;
  };
  /** The hub's webhook receipt and this host's own endpoints; absent, their routes answer unavailable. */
  readonly webhooks?: Pick<HubWebhookService, "status">;
  readonly spokeWebhooks?: Pick<
    SpokeWebhookService,
    "view" | "create" | "rotate" | "remove" | "setSecret"
  >;
  /** The hub's visitor links and this host's own; absent, their routes answer unavailable. */
  readonly visitors?: Pick<HubVisitorService, "status" | "setEnabled">;
  readonly spokeVisitors?: Pick<SpokeVisitorService, "view" | "share" | "stop" | "decideComment">;
  /** The hub's device relay and this host's own relay list; absent, their routes answer unavailable. */
  readonly relay?: Pick<HubRelayService, "status" | "setEnabled">;
  readonly spokeRelay?: Pick<SpokeRelayService, "view" | "allow">;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createHubAdministrationRouteHandler(
  options: HubAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const maxBody = options.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (
      !(Object.values(HUB_ADMINISTRATION_ROUTES) as ReadonlyArray<string>).includes(url.pathname)
    ) {
      return undefined;
    }
    const route = url.pathname as RouteValue;
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", 401);
    }
    if (url.search !== "") return failure("invalid", 400);
    try {
      options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }

    if (route === HUB_ADMINISTRATION_ROUTES.status) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json({
        hub: {
          ...options.hub.status(),
          owners: options.hub.listOwners(),
          ownerCandidates: options.hub.ownerCandidates(),
          acceptMovedThreads: options.hub.acceptsMovedThreads(),
          actProjects: options.hub.ownActProjects() ?? [],
        },
        spoke: options.spoke.status(),
        ...(options.delegationAccepting === undefined
          ? {}
          : { delegation: { accepting: options.delegationAccepting.read() } }),
        failover: options.failover.status(),
        wake: { hub: options.wake.status(), spoke: options.spokeWake.status() },
        push: { hub: options.push.status(), spoke: { handing: options.spokePush.granted() } },
        directPush: await options.directPush.status(),
        provision: { hub: options.provision.status(), spoke: options.spokeProvision.view() },
        signIn: { hub: options.signIn.status(), spoke: options.spokeSignIn.view() },
        pairedMergeUnlock: options.pairedMergeUnlock.required(),
        ownerApprovalAnswerUnlock: options.ownerApprovalAnswerUnlock.required(),
        ...(options.publicEntrance === undefined
          ? {}
          : { publicEntrance: options.publicEntrance.status() }),
        ...(options.publicStandby === undefined
          ? {}
          : { publicStandbyUrls: options.publicStandby.standbyUrls() }),
        ...(options.spokeWebhooks === undefined || options.webhooks === undefined
          ? {}
          : {
              webhooks: { hub: options.webhooks.status(), spoke: options.spokeWebhooks.view() },
            }),
        ...(options.visitors === undefined || options.spokeVisitors === undefined
          ? {}
          : {
              visitors: { hub: options.visitors.status(), spoke: options.spokeVisitors.view() },
            }),
        ...(options.relay === undefined || options.spokeRelay === undefined
          ? {}
          : { relay: { hub: options.relay.status(), devices: options.spokeRelay.view() } }),
      });
    }
    if (route === HUB_ADMINISTRATION_ROUTES.certificate && request.method === "GET") {
      return Response.json(options.certificate.status(), {
        headers: { "cache-control": "no-store" },
      });
    }
    if (request.method !== "POST") return failure("invalid", 400);
    const body = await readBody(request, maxBody);
    if (body.kind !== "ok") return failure("invalid", body.kind === "too-large" ? 413 : 400);

    try {
      switch (route) {
        case HUB_ADMINISTRATION_ROUTES.enable: {
          requireNoBody(body.text);
          return outcome(options.hub.enable(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.disable: {
          requireNoBody(body.text);
          return outcome(options.hub.disable(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.joinCode: {
          const value = requireJson(request, body.text, ["owner"]);
          if (typeof value.owner !== "boolean") throw new Error("invalid");
          return outcome(options.hub.mintJoinCode({ owner: value.owner }));
        }
        case HUB_ADMINISTRATION_ROUTES.remove: {
          const value = requireJson(request, body.text, ["memberId"]);
          if (typeof value.memberId !== "string") throw new Error("invalid");
          return outcome(
            await options.hub.removeMember({ memberId: value.memberId }, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.join: {
          const value = requireJson(request, body.text, ["code"]);
          if (typeof value.code !== "string" || value.code.length > 4_096)
            throw new Error("invalid");
          return outcome(await options.spoke.startJoin({ code: value.code }));
        }
        case HUB_ADMINISTRATION_ROUTES.joinFinish: {
          // The unlock public key is optional: the device that joins with an
          // owner code presents the one it made for this hub.
          if (body.text.trim() === "")
            return outcome(await options.spoke.finishJoin(WINDOW_PRINCIPAL));
          const value = requireJson(request, body.text, ["unlockPublicKey"]);
          if (typeof value.unlockPublicKey !== "string") throw new Error("invalid");
          return outcome(
            await options.spoke.finishJoin(WINDOW_PRINCIPAL, {
              unlockPublicKey: value.unlockPublicKey,
            }),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.ownersAdd: {
          const added = decodeOwnerAdditionRequest(parseJson(request, body.text));
          // A window decides who this host's owners are: the hub's list while the
          // hub role is on, otherwise the spoke's, after the person confirmed the
          // devices by name and fingerprint. A former hub keeps its roster, so
          // the role, not the roster, picks the list.
          return outcome(
            options.hub.status().enabled
              ? options.hub.addOwners(added.owners, WINDOW_PRINCIPAL)
              : options.spoke.addOwners(added.owners, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.ownersRemove: {
          const memberId = String(
            decodeOwnerRemovalRequest(parseJson(request, body.text)).memberId,
          );
          return outcome(
            options.hub.status().enabled
              ? options.hub.removeOwner(memberId, WINDOW_PRINCIPAL)
              : options.spoke.removeOwner(memberId, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.pairedMergeUnlock: {
          const value = decodePairedMergeUnlockRequest(parseJson(request, body.text));
          return outcome(options.pairedMergeUnlock.setRequired(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.ownerApprovalAnswerUnlock: {
          const value = decodeOwnerApprovalAnswerUnlockRequest(parseJson(request, body.text));
          return outcome(
            options.ownerApprovalAnswerUnlock.setRequired(value.enabled, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.confirmNewMembers: {
          const value = decodeConfirmNewMembersRequest(parseJson(request, body.text));
          return outcome(options.spoke.setConfirmNewMembers(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.delegationAccepting: {
          if (options.delegationAccepting === undefined) return failure("invalid", 404);
          const value = decodeDelegationAcceptingRequest(parseJson(request, body.text));
          options.delegationAccepting.set(value.accepting);
          return outcome({ status: "changed" });
        }
        case HUB_ADMINISTRATION_ROUTES.confirmMember: {
          const value = decodeOwnerMemberRequest(parseJson(request, body.text));
          return outcome(
            options.spoke.confirmMemberFromWindow(String(value.memberId), WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.alertDismiss: {
          const value = decodeOwnerAlertRequest(parseJson(request, body.text));
          return outcome(options.spoke.dismissAlert(String(value.alertId), WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.alertRemove: {
          const value = decodeOwnerAlertRequest(parseJson(request, body.text));
          return outcome(options.spoke.removeFromAlert(String(value.alertId), WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.grant: {
          return outcome(
            options.spoke.setGrant(decodeHubGrant(parseJson(request, body.text)), WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.windowGuest: {
          const asked = decodeHubWindowGuestRequest(parseJson(request, body.text));
          if (!options.hub.status().enabled) {
            return Response.json(await options.spoke.introduceWindow(asked), {
              headers: { "cache-control": "no-store" },
            });
          }
          const hubMemberId = options.hub.hubMemberId();
          const introduced = await options.hub.introduceWindowGuest(
            { ...asked, introducedBy: hubMemberId },
            WINDOW_PRINCIPAL,
          );
          const roster = options.hub.status().roster;
          const answer: HubWindowComputers = {
            membership: "member",
            introduction: introduced.status,
            hubMemberId: decodeHubMemberId(hubMemberId),
            members:
              roster === undefined
                ? []
                : windowComputersFrom({ roster, selfMemberId: hubMemberId }),
          };
          return Response.json(answer, { headers: { "cache-control": "no-store" } });
        }
        case HUB_ADMINISTRATION_ROUTES.leave: {
          requireNoBody(body.text);
          return outcome(await options.spoke.leave(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.standbyOrder: {
          const value = decodeHubStandbyOrderRequest(parseJson(request, body.text));
          return outcome(await options.hub.setStandbyOrder(value.memberIds, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.promote: {
          // The literal `confirmed: true` is the person's confirmation in this window.
          decodeHubPromoteRequest(parseJson(request, body.text));
          return outcome(options.hub.promote(WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.acceptNewHub: {
          const value = decodeHubAcceptNewHubRequest(parseJson(request, body.text));
          return outcome(
            await options.spoke.acceptNewHub(String(value.hubMemberId), WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.standInJoinCode: {
          requireNoBody(body.text);
          return outcome(options.failover.mintJoinCode());
        }
        case HUB_ADMINISTRATION_ROUTES.standInRemove: {
          const value = decodeHubMemberReference(parseJson(request, body.text));
          return outcome(
            await options.failover.removeMember(String(value.memberId), WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.wake: {
          const value = decodeHubWakeSwitchRequest(parseJson(request, body.text));
          return outcome(await options.wake.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.acceptMovedThreads: {
          const value = decodeHubAcceptMovedThreadsRequest(parseJson(request, body.text));
          return outcome(options.hub.setAcceptMovedThreads(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.actProjects: {
          const value = decodeHubActProjectsRequest(parseJson(request, body.text));
          return outcome(options.hub.setActProjects(value.actProjects, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.push: {
          const value = decodeHubPushSwitchRequest(parseJson(request, body.text));
          return outcome(await options.push.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.publicEntrance: {
          const value = decodeHubPublicEntranceSwitchRequest(parseJson(request, body.text));
          if (options.publicEntrance === undefined) return failure("unavailable", 503);
          return outcome(await options.publicEntrance.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.publicFunnel: {
          const value = decodeHubPublicFunnelRequest(parseJson(request, body.text));
          if (options.publicEntrance === undefined) return failure("unavailable", 503);
          return outcome(
            await options.publicEntrance.setFunnel(
              { enabled: value.enabled, ...(value.port === undefined ? {} : { port: value.port }) },
              WINDOW_PRINCIPAL,
            ),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.publicFronts: {
          const value = decodeHubPublicFrontsRequest(parseJson(request, body.text));
          if (options.publicEntrance === undefined) return failure("unavailable", 503);
          return outcome(await options.publicEntrance.setFronts(value.addresses, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.publicStandby: {
          const value = decodeHubPublicStandbyServeRequest(parseJson(request, body.text));
          if (options.publicStandby === undefined) return failure("unavailable", 503);
          const changed = options.publicStandby.set(value.enabled, WINDOW_PRINCIPAL);
          if (changed.status === "changed") await options.publicEntrance?.reconcile();
          return outcome(changed);
        }
        case HUB_ADMINISTRATION_ROUTES.webhookCreate: {
          const value = decodeHubWebhookCreateRequest(parseJson(request, body.text));
          if (options.spokeWebhooks === undefined) return failure("unavailable", 503);
          return outcome(await options.spokeWebhooks.create(value));
        }
        case HUB_ADMINISTRATION_ROUTES.webhookSecret: {
          const value = decodeHubWebhookSecretRequest(parseJson(request, body.text));
          if (options.spokeWebhooks === undefined) return failure("unavailable", 503);
          return outcome(
            await options.spokeWebhooks.setSecret(String(value.endpointId), value.secret),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.webhookRotate:
        case HUB_ADMINISTRATION_ROUTES.webhookRemove: {
          const value = decodeHubWebhookEndpointRequest(parseJson(request, body.text));
          if (options.spokeWebhooks === undefined) return failure("unavailable", 503);
          return outcome(
            route === HUB_ADMINISTRATION_ROUTES.webhookRotate
              ? await options.spokeWebhooks.rotate(String(value.endpointId))
              : await options.spokeWebhooks.remove(String(value.endpointId)),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.visitorSwitch: {
          const value = decodeHubVisitorSwitchRequest(parseJson(request, body.text));
          if (options.visitors === undefined) return failure("unavailable", 503);
          return outcome(await options.visitors.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.visitorShare: {
          const value = decodeHubVisitorShareRequest(parseJson(request, body.text));
          if (options.spokeVisitors === undefined) return failure("unavailable", 503);
          return outcome(await options.spokeVisitors.share(value));
        }
        case HUB_ADMINISTRATION_ROUTES.visitorStop: {
          const value = decodeHubVisitorLinkRequest(parseJson(request, body.text));
          if (options.spokeVisitors === undefined) return failure("unavailable", 503);
          return outcome(await options.spokeVisitors.stop(String(value.linkId)));
        }
        case HUB_ADMINISTRATION_ROUTES.visitorComment: {
          const value = decodeHubVisitorCommentRequest(parseJson(request, body.text));
          if (options.spokeVisitors === undefined) return failure("unavailable", 503);
          return outcome(options.spokeVisitors.decideComment(value.commentId, value.action));
        }
        case HUB_ADMINISTRATION_ROUTES.relaySwitch: {
          const value = decodeHubRelaySwitchRequest(parseJson(request, body.text));
          if (options.relay === undefined) return failure("unavailable", 503);
          return outcome(options.relay.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.relayDevice: {
          const value = decodeHubRelayDeviceRequest(parseJson(request, body.text));
          if (options.spokeRelay === undefined) return failure("unavailable", 503);
          return outcome(
            await options.spokeRelay.allow(value.deviceId, value.allowed, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.directPush: {
          const value = decodeHubDirectPushSwitchRequest(parseJson(request, body.text));
          return outcome(options.directPush.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.directPushEnvironment: {
          const value = decodeHubDirectPushEnvironmentRequest(parseJson(request, body.text));
          return outcome(options.directPush.setEnvironment(value.environment, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.directPushCredential: {
          const value = decodeHubDirectPushCredentialRequest(parseJson(request, body.text));
          return outcome(await options.directPush.storeCredential(value, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.directPushCredentialRemove: {
          const value = decodeHubDirectPushCredentialRemoveRequest(parseJson(request, body.text));
          return outcome(
            await options.directPush.removeCredential(value.platform, WINDOW_PRINCIPAL),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.provision: {
          const value = decodeHubProvisionSwitchRequest(parseJson(request, body.text));
          return outcome(options.provision.setEnabled(value.enabled, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.provisionOffer: {
          const value = decodeHubOfferRequest(parseJson(request, body.text));
          return outcome(await options.provision.offer(value, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.provisionWithdraw: {
          const value = decodeHubOfferWithdrawRequest(parseJson(request, body.text));
          return outcome(options.provision.withdraw(value.offerId, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.provisionApply: {
          const value = decodeHubProposalDecisionRequest(parseJson(request, body.text));
          return outcome(
            await options.spokeProvision.apply(value.offerId, WINDOW_PRINCIPAL, value.projectId),
          );
        }
        case HUB_ADMINISTRATION_ROUTES.provisionDismiss: {
          const value = decodeHubProposalDecisionRequest(parseJson(request, body.text));
          return outcome(options.spokeProvision.dismiss(value.offerId, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.provisionAutoApply: {
          const value = decodeHubAutoApplyRequest(parseJson(request, body.text));
          return outcome(options.spokeProvision.setAutoApply(value.kind, value.enabled));
        }
        case HUB_ADMINISTRATION_ROUTES.signInAsk: {
          const value = decodeHubSignInAsk(parseJson(request, body.text));
          return outcome(await options.signIn.ask(value, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.signInAccept: {
          const value = decodeHubSignInDecisionRequest(parseJson(request, body.text));
          return outcome(options.spokeSignIn.accept(value.requestId, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.signInDecline: {
          const value = decodeHubSignInDecisionRequest(parseJson(request, body.text));
          return outcome(await options.spokeSignIn.decline(value.requestId, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.signInCheck: {
          const value = decodeHubSignInDecisionRequest(parseJson(request, body.text));
          return outcome(await options.spokeSignIn.check(value.requestId, WINDOW_PRINCIPAL));
        }
        case HUB_ADMINISTRATION_ROUTES.wakeHardwareAddress: {
          const value = decodeHubWakeHardwareAddressRequest(parseJson(request, body.text));
          return outcome(options.spokeWake.setHardwareAddress(value.address));
        }
        case HUB_ADMINISTRATION_ROUTES.certificate: {
          const value = parseJson(request, body.text);
          if (typeof value !== "object" || value === null || Array.isArray(value)) {
            throw new Error("invalid");
          }
          const { action, acknowledgedCertificateTransparency, ...rest } = value as Record<
            string,
            unknown
          >;
          if (Object.keys(rest).length !== 0) throw new Error("invalid");
          if (action === "enable") {
            // Anything but a literal true is not the person saying they read the note.
            return outcome(
              options.certificate.enable({
                acknowledgedCertificateTransparency: acknowledgedCertificateTransparency === true,
              }),
            );
          }
          if (acknowledgedCertificateTransparency !== undefined) throw new Error("invalid");
          if (action === "disable") return outcome(await options.certificate.disable());
          if (action === "renew") return outcome(await options.certificate.renewIfDue());
          throw new Error("invalid");
        }
        default:
          return failure("invalid", 400);
      }
    } catch {
      return failure("invalid", 400);
    }
  };
}

/** A refusal is a state the person can act on, so it answers 409 with its kind; anything else is the outcome. */
function outcome(value: { readonly status: string; readonly kind?: string }): Response {
  if (value.status === "refused") {
    return Response.json(value, { status: 409, headers: { "cache-control": "no-store" } });
  }
  return Response.json(value, { headers: { "cache-control": "no-store" } });
}

function requireNoBody(text: string): void {
  if (text.trim() !== "") throw new Error("invalid");
}

function parseJson(request: Request, text: string): unknown {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new Error("invalid");
  }
  return JSON.parse(text);
}

function requireJson(
  request: Request,
  text: string,
  keys: ReadonlyArray<string>,
): Record<string, unknown> {
  const value = parseJson(request, text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("invalid");
  }
  return value as Record<string, unknown>;
}

async function readBody(
  request: Request,
  maxBody: number,
): Promise<
  { readonly kind: "ok"; readonly text: string } | { readonly kind: "invalid" | "too-large" }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBody) return { kind: "too-large" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid" };
  }
  return Buffer.byteLength(text, "utf8") > maxBody ? { kind: "too-large" } : { kind: "ok", text };
}

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "Hub administration is unavailable."
          : category === "unauthorized"
            ? "Hub administration is unauthorized."
            : "Hub administration request is invalid.",
    },
    { status },
  );
}
