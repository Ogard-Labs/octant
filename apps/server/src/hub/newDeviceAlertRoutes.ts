import {
  NEW_DEVICE_ALERTS_PATH,
  decodeNewDeviceAlertList,
  type NewDeviceAlertList,
  type NewMemberAlert,
  type PairedDeviceAlert,
} from "@octant/contracts";
import { isAgentGrantSession } from "../clientPrincipal";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

export { NEW_DEVICE_ALERTS_PATH };

export interface NewDeviceAlertRouteDependencies {
  /** The alerts this host raised as a spoke for members a newer roster added. */
  readonly memberAlerts: () => ReadonlyArray<NewMemberAlert>;
  /** The alerts this host raised for devices that paired directly with it. */
  readonly pairedAlerts?: () => ReadonlyArray<PairedDeviceAlert>;
  /** Clears one of those alerts; asked only from a window on this host. */
  readonly dismissPaired?: (alertId: string) => { readonly status: "dismissed" | "refused" };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/new-device-alerts`: every device connected to this host is told
 * when a new device joins, with its name and private address (maintainer
 * decision, 2026-11-19). Unlike the person's own reads, a hub guest is admitted
 * too: telling more devices is the point, and the read changes nothing. An
 * agent grant is no device and is refused. Remove stays with a window on this
 * host and an owner device with an unlock, on their own routes.
 */
export function createNewDeviceAlertRouteHandler(dependencies: NewDeviceAlertRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === `${NEW_DEVICE_ALERTS_PATH}/dismiss`) return dismiss(request, url);
    if (url.pathname !== NEW_DEVICE_ALERTS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return refuse(400, "New-device alerts are read over loopback.", null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" || url.search !== "") {
      return refuse(405, "New-device alerts take a plain GET.", origin);
    }
    let removesHere: boolean;
    try {
      const { principal } = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (isAgentGrantSession(principal)) {
        return refuse(403, "New-device alerts are for devices, not agent grants.", origin);
      }
      removesHere = principal.kind === "local-window";
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return refuse(401, "New-device alert read is unauthorized.", origin);
      }
      throw error;
    }
    const list: NewDeviceAlertList = decodeNewDeviceAlertList({
      alerts: [
        ...dependencies.memberAlerts().map(({ memberId: _memberId, ...alert }) => ({
          kind: "hub-member",
          ...alert,
        })),
        ...(dependencies.pairedAlerts?.() ?? []).map((alert) => ({
          kind: "paired-device",
          ...alert,
        })),
      ],
      removesHere,
    });
    return Response.json(list, { status: 200, headers: corsHeaders(origin) });
  };

  // Clearing an alert for a device that paired here is the host's own act, so
  // only a window on this host may do it; the private listener never forwards
  // this path.
  async function dismiss(request: Request, url: URL): Promise<Response> {
    const origin = request.headers.get("origin");
    if (
      request.method !== "POST" ||
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return refuse(405, "Dismiss an alert with a POST from a window on this host.", null);
    }
    try {
      const { principal } = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (principal.kind !== "local-window") {
        return refuse(403, "Alerts are cleared from a window on this host.", origin);
      }
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return refuse(401, "New-device alert dismissal is unauthorized.", origin);
      }
      throw error;
    }
    const body: unknown = await request.json().catch(() => undefined);
    const alertId =
      typeof body === "object" && body !== null && "alertId" in body ? body.alertId : undefined;
    if (typeof alertId !== "string" || dependencies.dismissPaired === undefined) {
      return refuse(400, "Name the alert to dismiss.", origin);
    }
    const result = dependencies.dismissPaired(alertId);
    return Response.json(result, {
      status: result.status === "dismissed" ? 200 : 404,
      headers: corsHeaders(origin),
    });
  }
}

function refuse(status: number, message: string, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "x-octant-window-capability",
    "cache-control": "no-store",
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
