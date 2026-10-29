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
  decodeConfirmNewMembersRequest,
  decodeHubAcceptNewHubRequest,
  decodeHubGrant,
  decodeHubMemberReference,
  decodeHubPromoteRequest,
  decodeHubPushSwitchRequest,
  decodeHubStandbyOrderRequest,
  decodeHubWakeHardwareAddressRequest,
  decodeHubWakeSwitchRequest,
  decodeOwnerAdditionRequest,
  decodeOwnerAlertRequest,
  decodeOwnerMemberRequest,
  decodeOwnerRemovalRequest,
  type AuditActingPrincipal,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { FailoverService } from "./failoverService";
import type { HubService } from "./hubService";
import type { PushService } from "./pushService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { SpokePushService } from "./spokePushService";
import type { SpokeWakeService } from "./spokeWakeService";
import type { TailscaleCertificateService } from "./tailscaleCertificate";
import type { WakeService } from "./wakeService";

const DEFAULT_BODY_LIMIT = 64 * 1_024;
const WINDOW_PRINCIPAL: AuditActingPrincipal = { kind: "local-window" };

export const HUB_ADMINISTRATION_ROUTES = {
  status: "/api/desktop/hub/status",
  enable: "/api/desktop/hub/enable",
  disable: "/api/desktop/hub/disable",
  joinCode: "/api/desktop/hub/join-codes",
  remove: "/api/desktop/hub/members/remove",
  join: "/api/desktop/hub/join",
  joinFinish: "/api/desktop/hub/join/finish",
  grant: "/api/desktop/hub/grant",
  leave: "/api/desktop/hub/leave",
  /** A window adds owner devices to this host's owner list: the hub's, or a spoke's after the person confirmed them by name and fingerprint. */
  ownersAdd: "/api/desktop/hub/owners/add",
  ownersRemove: "/api/desktop/hub/owners/remove",
  confirmNewMembers: "/api/desktop/hub/confirm-new-members",
  confirmMember: "/api/desktop/hub/members/confirm",
  /** GET: the members this host holds status-only under Confirm new members. */
  heldMembers: "/api/desktop/hub/members/held",
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
  /** A spoke's own window enters or clears this computer's hardware address. */
  wakeHardwareAddress: "/api/desktop/hub/wake/hardware-address",
  /** The hub's push switch: only a window on the hub turns it on or off. */
  push: "/api/desktop/hub/push",
} as const;

type RouteValue = (typeof HUB_ADMINISTRATION_ROUTES)[keyof typeof HUB_ADMINISTRATION_ROUTES];

export interface HubAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly failover: FailoverService;
  readonly wake: WakeService;
  readonly spokeWake: SpokeWakeService;
  readonly push: PushService;
  readonly spokePush: SpokePushService;
  readonly certificate: TailscaleCertificateService;
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
        },
        spoke: options.spoke.status(),
        failover: options.failover.status(),
        wake: { hub: options.wake.status(), spoke: options.spokeWake.status() },
        push: { hub: options.push.status(), spoke: { handing: options.spokePush.granted() } },
      });
    }
    if (route === HUB_ADMINISTRATION_ROUTES.heldMembers) {
      if (request.method !== "GET") return failure("invalid", 400);
      return Response.json(
        { members: options.spoke.heldMembers() },
        { headers: { "cache-control": "no-store" } },
      );
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
        case HUB_ADMINISTRATION_ROUTES.confirmNewMembers: {
          const value = decodeConfirmNewMembersRequest(parseJson(request, body.text));
          return outcome(options.spoke.setConfirmNewMembers(value.enabled, WINDOW_PRINCIPAL));
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
        case HUB_ADMINISTRATION_ROUTES.push: {
          const value = decodeHubPushSwitchRequest(parseJson(request, body.text));
          return outcome(await options.push.setEnabled(value.enabled, WINDOW_PRINCIPAL));
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
