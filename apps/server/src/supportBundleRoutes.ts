import { decodeSupportBundleExportRequest } from "@octant/contracts";
import { authorizeDiagnosticsExportActor } from "@octant/domain";
import { isAllowedOrigin } from "./diagnosticsExportRoutes";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import {
  exportSupportBundle,
  previewSupportBundle,
  type SupportBundleSources,
} from "./supportBundleService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

/**
 * The support bundle's two routes: a read of what a bundle would hold, and the
 * export that hands the files to the caller. Both are loopback-only and sit
 * on the local administration chain beside host control, never in the product
 * dispatch the remote gateway shares, so a paired device cannot reach them
 * even if route policy regressed. The caller must also be a local window.
 */

const PREVIEW_PATH = "/api/diagnostics/bundle/preview";
const EXPORT_PATH = "/api/diagnostics/bundle";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_024;

export interface SupportBundleRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly sources: () => SupportBundleSources;
  readonly now?: () => number;
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
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

export function createSupportBundleRouteHandler(dependencies: SupportBundleRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const isPreview = url.pathname === PREVIEW_PATH;
    if (!isPreview && url.pathname !== EXPORT_PATH) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Support bundle requests must use loopback." }, 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return json({ error: "Renderer origin is not allowed." }, 400, null);
    }
    // A 204 carries no body: passing even "null" as one makes the runtime refuse it.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== (isPreview ? "GET" : "POST")) {
      return json({ error: "Method not allowed." }, 405, origin);
    }

    let actorKind: "local-window" | "remote-device";
    try {
      actorKind = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal.kind;
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? json({ error: "Support bundle is unauthorized." }, 401, origin)
        : json({ error: "Support bundle request is invalid." }, 400, origin);
    }
    if (authorizeDiagnosticsExportActor(actorKind).kind === "denied") {
      return json({ error: "Support bundle is unauthorized." }, 403, origin);
    }

    if (isPreview) {
      try {
        return json(await previewSupportBundle(dependencies.sources()), 200, origin);
      } catch {
        return json({ error: "The support bundle list could not be read." }, 500, origin);
      }
    }

    let exportRequest;
    try {
      const text = await request.text();
      if (text.length > BODY_LIMIT)
        return json({ error: "Request body is too large." }, 413, origin);
      exportRequest = decodeSupportBundleExportRequest(JSON.parse(text));
    } catch {
      return json({ error: "Support bundle request is invalid." }, 400, origin);
    }
    try {
      const outcome = await exportSupportBundle(exportRequest, dependencies.sources());
      return json(outcome, outcome.kind === "exported" ? 200 : 422, origin);
    } catch {
      return json({ error: "The support bundle could not be built." }, 500, origin);
    }
  };
}
