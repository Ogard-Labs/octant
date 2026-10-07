import {
  decodePendingRequestFailure,
  decodePendingRequestList,
  type PendingRequestFailure,
  type PendingRequestList,
  type WindowId,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export const PENDING_REQUESTS_PATH = "/api/pending-requests";
const METHODS = "GET, OPTIONS";
const HEADERS = "x-octant-window-capability";

export interface PendingRequestRouteDependencies {
  readonly service: {
    readonly list: (windowId: WindowId) => Promise<PendingRequestList>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/pending-requests`: every approval and question the calling window
 * can answer. Local windows only. The path sits outside every prefix the
 * remote listener forwards, and a request that still arrives carrying a paired
 * device's principal is refused here, because the read spans every Project the
 * host's own windows can reach and a paired device's reach is narrower.
 */
export function createPendingRequestRouteHandler(dependencies: PendingRequestRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PENDING_REQUESTS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { code: "invalid", message: "Pending request reads must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failureResponse(
        { code: "invalid", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failureResponse(
        { code: "invalid", message: "HTTP method is not supported for this route." },
        405,
        origin,
      );
    }
    if (url.search !== "") {
      return failureResponse(
        { code: "invalid", message: "Pending request reads take no parameters." },
        400,
        origin,
      );
    }

    let windowId: WindowId;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window") {
        return failureResponse(
          { code: "unauthorized", message: "Pending requests are read at a local window." },
          403,
          origin,
        );
      }
      windowId = context.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { code: "unauthorized", message: "Pending request read is unauthorized." },
          401,
          origin,
        );
      }
      throw error;
    }

    let list: PendingRequestList;
    try {
      list = decodePendingRequestList(await dependencies.service.list(windowId));
    } catch {
      return failureResponse(
        { code: "unavailable", message: "Pending requests are unavailable." },
        503,
        origin,
      );
    }
    return Response.json(list, { status: 200, headers: corsHeaders(origin) });
  };
}

function failureResponse(
  failure: PendingRequestFailure,
  status: number,
  origin: string | null,
): Response {
  return Response.json(decodePendingRequestFailure(failure), {
    status,
    headers: corsHeaders(origin),
  });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "cache-control": "no-store",
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
