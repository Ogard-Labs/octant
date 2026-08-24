import {
  decodeProviderUsageLimitsSnapshot,
  type ProviderUsageLimitsSnapshot,
} from "@octant/contracts";
import { authenticateProjectRequest } from "../projectBindingRoutes";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

export interface ProviderUsageLimitsRouteService {
  readonly snapshot: () => ProviderUsageLimitsSnapshot;
  readonly refresh: () => Promise<ProviderUsageLimitsSnapshot>;
}

export function createProviderUsageLimitsRouteHandler(dependencies: {
  readonly service: ProviderUsageLimitsRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isList = url.pathname === "/api/provider-usage-limits";
    const isRefresh = url.pathname === "/api/provider-usage-limits/refresh";
    if (!isList && !isRefresh) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return response({ message: "Provider limits require loopback." }, 400, null);
    if (origin !== null && !allowedOrigin(origin))
      return response({ message: "Renderer origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(origin) });
    if ((isList && request.method !== "GET") || (isRefresh && request.method !== "POST")) {
      return response({ message: "Provider limits method is not supported." }, 405, origin);
    }
    if (url.search !== "")
      return response({ message: "Provider limits request is invalid." }, 400, origin);
    try {
      authenticateProjectRequest({
        request,
        body: {},
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
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
    try {
      const value = isRefresh
        ? await dependencies.service.refresh()
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

function allowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "file:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}
