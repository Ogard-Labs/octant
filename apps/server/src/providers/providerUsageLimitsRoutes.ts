import {
  decodeProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import type { AntigravityStatusLineStatus } from "./antigravityStatusLineUsage";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

export interface ProviderUsageLimitsRouteService {
  readonly snapshot: () => ProviderUsageLimitsSnapshot;
  readonly refresh: (request?: {
    readonly onDemand?: boolean;
  }) => Promise<ProviderUsageLimitsSnapshot>;
}

export interface AntigravityStatusLineRouteActions {
  readonly status: () => AntigravityStatusLineStatus;
  readonly connect: () => Promise<AntigravityStatusLineStatus>;
  readonly disconnect: () => Promise<{
    readonly restored: boolean;
    readonly status: AntigravityStatusLineStatus;
  }>;
  readonly openTerminal: () => { readonly opened: boolean; readonly message?: string };
}

export function createProviderUsageLimitsRouteHandler(dependencies: {
  readonly service: ProviderUsageLimitsRouteService;
  readonly antigravityStatusLine?: AntigravityStatusLineRouteActions;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly allowedRendererHttpOrigin?: string | null;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isList = url.pathname === "/api/provider-usage-limits";
    const isRefresh = url.pathname === "/api/provider-usage-limits/refresh";
    const isAgyStatus = url.pathname === "/api/provider-usage-limits/antigravity-statusline";
    const isAgyConnect =
      url.pathname === "/api/provider-usage-limits/antigravity-statusline/connect";
    const isAgyDisconnect =
      url.pathname === "/api/provider-usage-limits/antigravity-statusline/disconnect";
    const isAgyOpenTerminal =
      url.pathname === "/api/provider-usage-limits/antigravity-statusline/open-terminal";
    if (
      !isList &&
      !isRefresh &&
      !isAgyStatus &&
      !isAgyConnect &&
      !isAgyDisconnect &&
      !isAgyOpenTerminal
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return response({ message: "Provider limits require loopback." }, 400, null);
    if (origin !== null && !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin))
      return response({ message: "Renderer origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });
    const expectsGet = isList || isAgyStatus;
    if ((expectsGet && request.method !== "GET") || (!expectsGet && request.method !== "POST")) {
      return response({ message: "Provider limits method is not supported." }, 405, origin);
    }
    if (url.search !== "")
      return response({ message: "Provider limits request is invalid." }, 400, origin);
    try {
      const principal = authenticateRoutePrincipal({
        request,
        body: {},
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      // The limits are the person's own account figures: read at a window
      // on this host or on a device that person paired.
      if (!principalActsAsHostPerson(principal.principal)) {
        return response({ message: "Provider limits require a local window." }, 403, origin);
      }
    } catch (error) {
      return response(
        {
          message:
            error instanceof WindowAuthorityError
              ? "Provider limits request is unauthorized."
              : "Provider limits request is invalid.",
        },
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    if (isAgyStatus || isAgyConnect || isAgyDisconnect || isAgyOpenTerminal) {
      const agy = dependencies.antigravityStatusLine;
      if (agy === undefined) {
        return response(
          { message: "Antigravity status-line capture is unavailable." },
          503,
          origin,
        );
      }
      try {
        if (isAgyStatus) return response(agy.status(), 200, origin);
        if (isAgyConnect) {
          const status = await agy.connect();
          return response(status, 200, origin);
        }
        if (isAgyDisconnect) {
          const result = await agy.disconnect();
          return response(result, 200, origin);
        }
        return response(agy.openTerminal(), 200, origin);
      } catch (error) {
        const message =
          error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Antigravity status-line action failed.";
        return response({ message }, 400, origin);
      }
    }
    try {
      const value = isRefresh
        ? // A person pressed refresh, which is the one time a costly source is asked.
          await dependencies.service.refresh({ onDemand: true })
        : dependencies.service.snapshot();
      return response(decodeProviderUsageLimitsSnapshot(value), 200, origin);
    } catch {
      return response({ message: "Provider limits are unavailable." }, 503, origin);
    }
  };
}

function response(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: cors(origin) });
}

function cors(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...(origin === null ? {} : { "access-control-allow-origin": origin, vary: "origin" }),
  };
}
