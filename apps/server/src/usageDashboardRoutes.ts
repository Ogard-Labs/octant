import {
  decodeUsageDashboardRequest,
  type UsageDashboardRequest,
  type WindowId,
} from "@octant/contracts";
import type { CacheStatsProjection } from "./cacheStatsProjection";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { readUsageDashboard } from "./usageDashboardService";
import type { UsageProjectScope } from "./usageProjectScope";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { SqliteConnection } from "./persistence/sqlitePort";

const DASHBOARD_PATH = "/api/usage/dashboard";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const JSON_BODY_LIMIT = 65_536;

export interface UsageDashboardRouteDependencies {
  readonly connection: SqliteConnection;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Resolve which Projects the authenticated window may read usage for.
   *
   * A window capability proves the caller is a live renderer of this host; it
   * says nothing about which Project that renderer is in. Usage detail names
   * providers, models, Projects, threads, and token counts, so without this an
   * empty request from any valid capability — including one forwarded by a
   * remote client — would read the host-wide ledger. Required rather than
   * optional: a host that cannot resolve the window's scope must not serve the
   * dashboard at all.
   */
  readonly readWindowProjectScope: (windowId: WindowId) => UsageProjectScope;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
  readonly clock?: () => string;
  readonly maxScannedRows?: number;
  /** Host cache readings reported with the dashboard; absent means none observed. */
  readonly cacheStats?: CacheStatsProjection;
}

/**
 * Attributed usage dashboard read surface.
 *
 * The dashboard is operational metadata about the local host, so the route
 * proves window authority before any projection is read and answers only over
 * loopback from an allowed renderer origin. The request body is small by
 * construction — a filter and two limits — so the bound is far below the
 * export ceiling and a malformed body fails closed rather than being repaired.
 */
export function createUsageDashboardRouteHandler(dependencies: UsageDashboardRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const clock = dependencies.clock ?? (() => new Date().toISOString());
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== DASHBOARD_PATH) return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Usage dashboard requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("Usage dashboard requires POST.", 405, origin);
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
        return failure("Usage dashboard request is unauthorized.", 401, origin);
      }
      return failure("Usage dashboard request is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      body = parseJson(await readBoundedBytes(request, jsonLimit));
    } catch (error) {
      if (error instanceof UsageDashboardRouteRejected) {
        return failure(error.message, error.status, origin);
      }
      return failure("Usage dashboard request is invalid.", 400, origin);
    }

    let decoded: UsageDashboardRequest;
    try {
      decoded = decodeUsageDashboardRequest(body);
    } catch {
      return failure("Usage dashboard request is invalid.", 400, origin);
    }

    let projectScope: UsageProjectScope;
    try {
      projectScope = dependencies.readWindowProjectScope(windowId);
    } catch {
      return failure("Usage dashboard is unavailable.", 503, origin);
    }
    // A Project the window is not in is refused rather than quietly filtered
    // away, so a caller learns its request was denied instead of reading an
    // empty dashboard as if that Project had no usage. An unnamed Project is
    // scoped instead, which is what makes an empty request honest.
    const requestedProjectId = decoded.filter?.projectId;
    if (
      requestedProjectId !== undefined &&
      (projectScope.kind === "unfiled" ||
        !projectScope.projectIds.includes(String(requestedProjectId)))
    ) {
      return failure("Usage dashboard request is not authorized for this Project.", 403, origin);
    }

    try {
      const response = readUsageDashboard(dependencies.connection, decoded, {
        queryAt: clock(),
        projectScope,
        ...(dependencies.cacheStats === undefined ? {} : { cacheStats: dependencies.cacheStats }),
      });
      return json(response, 200, origin);
    } catch {
      return failure("Usage dashboard is unavailable.", 503, origin);
    }
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ message }, status, origin);
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new UsageDashboardRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new UsageDashboardRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new UsageDashboardRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UsageDashboardRouteRejected("Usage dashboard body must be valid UTF-8 JSON.", 400);
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageDashboardRouteRejected("Usage dashboard body must be valid JSON.", 400);
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" &&
        (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

class UsageDashboardRouteRejected extends Error {
  override readonly name = "UsageDashboardRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
