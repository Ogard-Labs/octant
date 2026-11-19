import {
  decodeNewDeviceAlertList,
  type NewDeviceAlertList,
  type NewMemberAlert,
} from "@octant/contracts";
import { isAgentGrantSession } from "../clientPrincipal";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

export const NEW_DEVICE_ALERTS_PATH = "/api/new-device-alerts";

export interface NewDeviceAlertRouteDependencies {
  /** The alerts this host raised as a spoke for members a newer roster added. */
  readonly memberAlerts: () => ReadonlyArray<NewMemberAlert>;
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
    if (url.pathname !== NEW_DEVICE_ALERTS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !isAllowedRendererOrigin(origin))) {
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
      alerts: dependencies.memberAlerts().map(({ memberId: _memberId, ...alert }) => ({
        kind: "hub-member",
        ...alert,
      })),
      removesHere,
    });
    return Response.json(list, { status: 200, headers: corsHeaders(origin) });
  };
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
