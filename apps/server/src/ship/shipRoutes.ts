import type { WindowId } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ShipService } from "./shipService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_048_576;

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(data: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

export interface ShipRouteDependencies {
  readonly service: ShipService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Resolve and authorize the Code thread a ship command names.
   *
   * A window capability proves the caller is a live renderer of this host and
   * says nothing about which checkout it may publish from. Required rather than
   * optional: a host that cannot authorize must not serve publication at all.
   */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: WindowId;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

export function createShipRouteHandler(dependencies: ShipRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/ship")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Ship requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Ship request is unauthorized." }, 401, origin);
      }
      return json({ error: "Ship request is invalid." }, 400, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/ship/targets") {
      return json({ targets: dependencies.service.targets() }, 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/ship/commands") {
      const text = await request.text();
      if (text.length > BODY_LIMIT) {
        return json({ error: "Request body is too large." }, 413, origin);
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        return json({ error: "Request body must be valid JSON." }, 400, origin);
      }
      // A command that acts on a checkout names a thread, and that thread is
      // authorized here rather than inside the service, so a caller can never
      // publish from a checkout its window may not reach.
      const threadId = commandThreadId(value);
      if (threadId !== undefined && !(await dependencies.authorizeThread({ threadId, windowId }))) {
        return json({ error: "Ship request is not authorized for this thread." }, 403, origin);
      }
      return json(await dependencies.service.execute(value), 200, origin);
    }

    return json({ error: "Not found." }, 404, origin);
  };
}

/** The thread a ship command names, when it names one at all. */
function commandThreadId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const threadId = (value as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}
