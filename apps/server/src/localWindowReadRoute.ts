import type { WindowId } from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, OPTIONS";
const HEADERS = "x-octant-window-capability";

export interface LocalWindowReadFailure {
  readonly code: "invalid" | "unauthorized" | "unavailable";
  readonly message: string;
}

export interface LocalWindowReadRouteOptions<T> {
  readonly path: string;
  /** The read's own name in a failure sentence, such as "Pending request". */
  readonly noun: string;
  /** The plural that opens an unavailable sentence, such as "Pending requests". */
  readonly plural: string;
  readonly read: (windowId: WindowId) => Promise<T>;
  readonly decodeFailure: (failure: LocalWindowReadFailure) => unknown;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * A parameterless GET that only a local window may make. The path sits outside
 * every prefix the remote listener forwards, and a request that still arrives
 * carrying a paired device's principal is refused here, because these reads
 * span every Project the host's own windows can reach and a paired device's
 * reach is narrower.
 */
export function createLocalWindowReadRoute<T>(options: LocalWindowReadRouteOptions<T>) {
  const now = options.now ?? Date.now;
  const fail = (failure: LocalWindowReadFailure, status: number, origin: string | null) =>
    Response.json(options.decodeFailure(failure), { status, headers: corsHeaders(origin) });
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== options.path) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return fail(
        { code: "invalid", message: `${options.noun} reads must use loopback.` },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return fail({ code: "invalid", message: "Renderer origin is not allowed." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return fail(
        { code: "invalid", message: "HTTP method is not supported for this route." },
        405,
        origin,
      );
    }
    if (url.search !== "") {
      return fail(
        { code: "invalid", message: `${options.noun} reads take no parameters.` },
        400,
        origin,
      );
    }

    let windowId: WindowId;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: options.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window") {
        return fail(
          { code: "unauthorized", message: `${options.plural} are read at a local window.` },
          403,
          origin,
        );
      }
      windowId = context.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return fail(
          { code: "unauthorized", message: `${options.noun} read is unauthorized.` },
          401,
          origin,
        );
      }
      throw error;
    }

    let body: T;
    try {
      body = await options.read(windowId);
    } catch {
      return fail(
        { code: "unavailable", message: `${options.plural} are unavailable.` },
        503,
        origin,
      );
    }
    return Response.json(body, { status: 200, headers: corsHeaders(origin) });
  };
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
