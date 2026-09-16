import {
  decodeLocalUsageHistoryRequest,
  decodeLocalUsageHistoryResponse,
  type LocalUsageHistoryRequest,
  type LocalUsageHistoryResponse,
} from "@octant/contracts";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { readLocalUsageHistoryDashboard } from "./providers/localUsageHistoryService";
import type { LocalUsageHistoryLastReadStore } from "./persistence/localUsageHistoryLastReadStore";
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
  readonly lastReadStore?: LocalUsageHistoryLastReadStore;
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
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window")
        return failure("Usage history is local-window only.", 403, origin);
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
    let decoded;
    try {
      decoded = decodeLocalUsageHistoryRequest(body);
    } catch {
      return failure("Usage history request range or timezone is invalid.", 400, origin);
    }
    try {
      const sources =
        typeof dependencies.sources === "function" ? dependencies.sources() : dependencies.sources;
      const view = localUsageHistoryViewKey(sources, decoded);
      if (decoded.preferLastRead === true) {
        const lastRead = readLastRead(dependencies.lastReadStore, view);
        if (lastRead !== undefined) return json(lastRead, 200, origin);
      }
      const response: LocalUsageHistoryResponse = await readLocalUsageHistoryDashboard({
        sources,
        request: decoded,
        queryAt: clock(),
        signal: request.signal,
      });
      // A reading that finished replaces whatever was stored. An unfinished one
      // is kept only as the fallback for a view that has no finished reading
      // yet: on a large provider history the import rarely completes in one
      // open, and a surface returning to this view is better served by the
      // totals it saw last than by nothing.
      try {
        dependencies.lastReadStore?.write(
          view,
          JSON.stringify(response),
          response.coverage.every((source) => source.hasMore !== true),
        );
      } catch {
        // The reading is the answer; a cache that cannot be written is not one.
      }
      return json(response, 200, origin);
    } catch {
      if (request.signal.aborted)
        return new Response(null, { status: 499, headers: corsHeaders(origin) });
      return failure("Usage history is unavailable.", 503, origin);
    }
  };
}

function json(value: unknown, status: number, origin: string | null): Response {
  return Response.json(value, { status, headers: corsHeaders(origin) });
}

/**
 * What two openings of the same view have in common, for the last-read cache.
 *
 * The window's instants are deliberately not part of it: a surface asks for
 * "the last 30 days" again a minute later and means that view, so a key over
 * the instants would never match anything. The answer carries the range and
 * the read time it actually covers, and the caller reads again.
 */
function localUsageHistoryViewKey(
  sources: ReadonlyArray<ProviderLocalUsageHistorySource>,
  request: LocalUsageHistoryRequest,
): string {
  const kinds = [...new Set(sources.map((source) => source.sourceKind))].sort();
  // Exact length, not rounded days: two windows that round to the same day
  // count are still different views (24 hours is not 25), and a preferLastRead
  // answer for the shorter one must not stand in for the longer.
  const windowMs = Date.parse(request.to) - Date.parse(request.from);
  return `${kinds.join(",")}|${request.timeZone}|${windowMs}ms`;
}

/** A stored reading that no longer decodes is a miss; the next read replaces it. */
function readLastRead(
  store: LocalUsageHistoryLastReadStore | undefined,
  view: string,
): LocalUsageHistoryResponse | undefined {
  if (store === undefined) return undefined;
  let stored: string | undefined;
  try {
    stored = store.read(view);
  } catch {
    return undefined;
  }
  if (stored === undefined) return undefined;
  try {
    return { ...decodeLocalUsageHistoryResponse(JSON.parse(stored)), fromLastRead: true };
  } catch {
    return undefined;
  }
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
