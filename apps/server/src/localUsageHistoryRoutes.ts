import { decodeLocalUsageHistoryRequest, type LocalUsageHistoryResponse } from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { readLocalUsageHistoryDashboard } from "./providers/localUsageHistoryService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const PATH = "/api/usage/local-history";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const MAX_BODY_BYTES = 16 * 1024;

export interface LocalUsageHistoryRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly allowedRendererHttpOrigin?: string | null;
  readonly sources:
    | ReadonlyArray<ProviderLocalUsageHistorySource>
    | (() => ReadonlyArray<ProviderLocalUsageHistorySource>);
  readonly now?: () => number;
  readonly clock?: () => string;
}

/** Local-window-only read route for bounded provider history aggregates. */
export function createLocalUsageHistoryRouteHandler(
  dependencies: LocalUsageHistoryRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const now = dependencies.now ?? Date.now;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return failure("Usage history requires loopback.", 400, null);
    if (origin !== null && !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin))
      return failure("Renderer origin is not allowed.", 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST" || url.search !== "")
      return failure("Usage history requires POST.", 405, origin);
    try {
      authenticateRouteWindowId({ request, store: dependencies.windowAuthorityStore, now: now() });
    } catch (error) {
      return failure(
        "Usage history request is unauthorized.",
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    let body: unknown;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES)
        return failure("Usage history request is too large.", 413, origin);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return failure("Usage history request is invalid.", 400, origin);
    }
    try {
      const decoded = decodeLocalUsageHistoryRequest(body);
      const sources =
        typeof dependencies.sources === "function" ? dependencies.sources() : dependencies.sources;
      const response: LocalUsageHistoryResponse = await readLocalUsageHistoryDashboard({
        sources,
        request: decoded,
        queryAt: clock(),
        signal: request.signal,
      });
      return json(response, 200, origin);
    } catch (error) {
      if (request.signal.aborted)
        return new Response(null, { status: 499, headers: corsHeaders(origin) });
      return failure("Usage history is unavailable.", 503, origin);
    }
  };
}

function json(value: unknown, status: number, origin: string | null): Response {
  return Response.json(value, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ message }, status, origin);
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}
