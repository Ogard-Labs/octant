import { decodeArtifactLibraryQuery } from "@octant/contracts/artifact-library";
import type { ArtifactLibraryService } from "./canvas/artifactLibraryService";
import type { ClientPrincipal } from "./clientPrincipal";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ArtifactLibraryRouteDependencies {
  readonly library: ArtifactLibraryService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The artifact library surface: one read, POST because it carries a query.
 *
 * The route decides nothing about scope. It refuses a caller the transport did
 * not authenticate and hands the query to the service, which decides which
 * Projects this principal may see artifacts from.
 */
export function createArtifactLibraryRouteHandler(deps: ArtifactLibraryRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (url.pathname !== "/api/artifacts/library") return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Artifact library requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return undefined;

    // The gateway binds a principal for a forwarded remote request; a request
    // that arrived at the loopback listener on its own is the local window,
    // proved by its capability. Neither identity can come from the body.
    let principal: ClientPrincipal;
    try {
      const bound = readPrincipalRouteContext(request);
      if (bound === undefined) {
        const windowId = authenticateRouteWindowId({
          request,
          store: deps.windowAuthorityStore,
          now: now(),
        });
        principal = { kind: "local-window", windowId, capabilityGeneration: 0 };
      } else {
        principal = bound.principal;
      }
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? failure("Artifact library read is unauthorized.", 401, origin)
        : failure("Artifact library read is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return failure("Artifact library query is invalid.", 400, origin);
    }
    try {
      const query = decodeArtifactLibraryQuery(body);
      return json(deps.library.list(query, principal), origin);
    } catch {
      return failure("Artifact library query is invalid.", 400, origin);
    }
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
