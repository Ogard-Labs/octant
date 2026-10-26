import {
  decodeAppleDeviceRequest,
  decodeAppleDeviceResponse,
  type AppleDeviceRequest,
  type AppleDeviceResponse,
  type WindowId,
} from "@octant/contracts";
import type { AppleDeviceExecutionContext, AppleDeviceService } from "./apple/appleDeviceService";
import type { ClientPrincipal } from "./clientPrincipal";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEVICES_PATH = "/api/apple/devices";
const LEASES_PATH = "/api/apple/device-leases";
const ACTIONS_PATH = "/api/apple/device-actions";

// Each route takes only its own kinds, so the remote listener's split between
// the readable device route and the local-only lease and action routes cannot
// be crossed by naming another kind in the body.
const ROUTE_KINDS: ReadonlyMap<string, ReadonlySet<AppleDeviceRequest["kind"]>> = new Map([
  [DEVICES_PATH, new Set<AppleDeviceRequest["kind"]>(["discover", "status"])],
  [LEASES_PATH, new Set<AppleDeviceRequest["kind"]>(["use-device", "release-device"])],
  // The thread's own app inside its lease. Remote clients observe only, so
  // this route is local-only and a paired device never reaches it.
  [
    ACTIONS_PATH,
    new Set<AppleDeviceRequest["kind"]>(["build", "run", "install", "launch", "terminate", "logs"]),
  ],
]);
/** Routes only a person at a local window may call. */
const LOCAL_ONLY_PATHS: ReadonlySet<string> = new Set([LEASES_PATH, ACTIONS_PATH]);

export interface AppleDeviceRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly service: Pick<AppleDeviceService, "request">;
  /**
   * The thread scope this window may act in, with the posture, the checkout,
   * and the approval or confirmation the host validated for exactly this
   * request. Undefined refuses the request before the device service sees it.
   */
  readonly resolveScope: (
    windowId: WindowId,
    request: AppleDeviceRequest,
    principal: ClientPrincipal,
  ) => Promise<AppleDeviceExecutionContext | undefined>;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

/**
 * Physical Apple device discovery, status, leases, and the thread's own app on
 * a leased device (docs/design/apple-devices.md). Discovery and status are
 * reads a paired device may make. A lease starts, moves, and ends, and the
 * app is built, installed, launched, stopped, or read, only from a local
 * window: a lease's start on a person's confirmation the host validated, and
 * an effect on the approval its thread's posture asks for.
 */
export function createAppleDeviceRouteHandler(dependencies: AppleDeviceRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const kinds = ROUTE_KINDS.get(url.pathname);
    if (kinds === undefined) return undefined;
    const origin = request.headers.get("origin");
    if (
      !isLoopbackHostname(url.hostname) ||
      (origin !== null && !isAllowedRendererOrigin(origin))
    ) {
      return failure("invalid", "Apple device requests must use an allowed loopback origin.", 400);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (
      request.method !== "POST" ||
      url.search !== "" ||
      request.headers.get("content-type")?.toLowerCase() !== "application/json"
    ) {
      return failure("invalid", "Apple device request is invalid.", 400, origin);
    }
    let principal: ClientPrincipal;
    let windowId: WindowId;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      principal = context.principal;
      windowId = context.scopeId;
    } catch (error) {
      return failure(
        error instanceof WindowAuthorityError ? "unauthorized" : "invalid",
        "Apple device request is unauthorized.",
        401,
        origin,
      );
    }
    let deviceRequest: AppleDeviceRequest;
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > bodyLimit) {
        return failure("invalid", "Apple device request body is too large.", 413, origin);
      }
      deviceRequest = decodeAppleDeviceRequest(JSON.parse(text));
    } catch {
      return failure("invalid", "Apple device request is invalid.", 400, origin);
    }
    if (!kinds.has(deviceRequest.kind)) {
      return failure("invalid", "Apple device request is invalid.", 400, origin);
    }
    if (
      !namesAskingPerson(deviceRequest, principal) ||
      (LOCAL_ONLY_PATHS.has(url.pathname) && principal.kind !== "local-window")
    ) {
      return failure("unauthorized", "Apple device request is unauthorized.", 403, origin);
    }
    let scope: AppleDeviceExecutionContext | undefined;
    try {
      scope = await dependencies.resolveScope(windowId, deviceRequest, principal);
    } catch {
      scope = undefined;
    }
    if (scope === undefined) {
      return failure("unauthorized", "Apple device request is unauthorized.", 403, origin);
    }
    try {
      const answer = await dependencies.service.request(deviceRequest, scope, request.signal);
      return encoded(answer, 200, origin);
    } catch {
      return failure("unavailable", "Apple device service is unavailable.", 503, origin);
    }
  };
}

/**
 * A pane request names the person behind the window that sent it. The route
 * does not take the body's word for that: a local window is a person at this
 * Mac, a paired device is that device's person, and an agent never asks here.
 */
function namesAskingPerson(request: AppleDeviceRequest, principal: ClientPrincipal): boolean {
  const actor = request.requestedBy;
  if (principal.kind === "local-window") return actor.kind === "local-user";
  return actor.kind === "remote-device" && String(actor.deviceId) === String(principal.deviceId);
}

function encoded(body: AppleDeviceResponse, status: number, origin: string | null): Response {
  return Response.json(decodeAppleDeviceResponse(body), { status, headers: corsHeaders(origin) });
}

function failure(
  category: "invalid" | "unauthorized" | "unavailable",
  message: string,
  status: number,
  origin: string | null = null,
): Response {
  return encoded({ kind: "apple-device-failure", failure: { category, message } }, status, origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    vary: "Origin",
    "cache-control": "no-store",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    ...(origin === null || !isAllowedRendererOrigin(origin)
      ? {}
      : { "access-control-allow-origin": origin }),
  };
}
