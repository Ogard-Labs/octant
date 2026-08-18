import {
  decodeScaffoldCatalogListing,
  type ScaffoldCatalogListing,
  type ScaffoldEntry,
} from "@octant/contracts/scaffolds";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ScaffoldRouteDependencies {
  readonly entries: ReadonlyArray<ScaffoldEntry>;
  readonly availableTools: () => Promise<ReadonlyArray<string>>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
  readonly clock?: () => string;
}

/**
 * The curated scaffolds this host offers.
 *
 * Read-only and local-window only. Running one is not here: that is an ordinary
 * Code operation, gated and journaled with every other effect a thread has on
 * its checkout.
 */
export function createScaffoldRouteHandler(deps: ScaffoldRouteDependencies) {
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? (() => new Date().toISOString());
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname !== "/api/scaffolds") return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Scaffold API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") return undefined;

    try {
      if (url.search !== "") return failure("Scaffold list request is invalid.", 400, origin);
      authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Scaffold list is unauthorized.", 401, origin)
        : failure("Scaffold list request is invalid.", 400, origin);
    }

    let listing: ScaffoldCatalogListing;
    try {
      listing = decodeScaffoldCatalogListing({
        kind: "scaffold-catalog-listing",
        entries: deps.entries,
        availableTools: [...(await deps.availableTools())].sort(),
        observedAt: clock(),
      });
    } catch {
      return failure("Scaffold catalog could not be read.", 500, origin);
    }
    return json(listing, origin);
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-expose-headers": "content-type",
  };
}

function json(body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
