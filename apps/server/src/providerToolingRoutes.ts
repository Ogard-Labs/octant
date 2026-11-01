import {
  decodeProviderToolingApplyRequest,
  decodeProviderToolingListRequest,
  decodeProviderToolingPlanRequest,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ProviderToolingService } from "./providers/providerToolingService";

const PATHS = new Set([
  "/api/provider-tooling/list",
  "/api/provider-tooling/plan",
  "/api/provider-tooling/apply",
]);
const MAXIMUM_BODY_BYTES = 64 * 1024;
const HEADERS = "content-type, x-octant-window-capability";

export interface ProviderToolingRouteDependencies {
  readonly service: Pick<ProviderToolingService, "list" | "plan" | "apply">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Listing, planning, and running the provider commands that add or remove an
 * account's tools. Every step needs the Octant window on this host: the window
 * capability proves it, and a request forwarded from a paired device arrives
 * with a remote principal the service refuses. An agent holds neither, and no
 * agent tool reaches this route.
 */
export function createProviderToolingRouteHandler(deps: ProviderToolingRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!PATHS.has(url.pathname)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Provider tooling requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return undefined;

    const text = await request.text().catch(() => undefined);
    if (text === undefined || new TextEncoder().encode(text).length > MAXIMUM_BODY_BYTES) {
      return failure("The request is too large.", 413, origin);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return failure("The request is invalid.", 400, origin);
    }
    let caller;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: deps.windowAuthorityStore,
        now: now(),
        body,
      });
      caller =
        context.principal.kind === "local-window"
          ? ({ kind: "local-window", windowId: context.principal.windowId } as const)
          : ({ kind: "remote-device", windowId: String(context.scopeId) } as const);
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("This step requires the Octant window on this host.", 401, origin)
        : failure("The request is invalid.", 400, origin);
    }
    try {
      const result =
        url.pathname === "/api/provider-tooling/list"
          ? await deps.service.list(
              caller,
              decodeProviderToolingListRequest(body).providerInstanceId,
            )
          : url.pathname === "/api/provider-tooling/plan"
            ? await planOf(deps, caller, body)
            : await deps.service.apply(caller, decodeProviderToolingApplyRequest(body));
      const unauthorized = result.status === "refused" && result.reason === "not-a-local-window";
      return json(result, unauthorized ? 401 : 200, origin);
    } catch {
      return failure("The request is invalid.", 400, origin);
    }
  };
}

function planOf(
  deps: ProviderToolingRouteDependencies,
  caller: Parameters<ProviderToolingRouteDependencies["service"]["plan"]>[0],
  body: unknown,
) {
  const plan = decodeProviderToolingPlanRequest(body);
  return deps.service.plan(caller, plan.providerInstanceId, plan.request);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}
