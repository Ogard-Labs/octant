import type { WindowId } from "@octant/contracts/shell";
import {
  ThreadCheckpointError,
  type ThreadCheckpointService,
} from "./checkpoint/threadCheckpointService";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const MAX_THREAD_ID_LENGTH = 128;

export interface ThreadCheckpointRouteDependencies {
  readonly checkpoints: ThreadCheckpointService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The checkpoint surface: list the points a thread carries, and mark, put away,
 * or take one up again.
 *
 * The route decides nothing about authority. It authenticates the window,
 * refuses caller-supplied window identity, and hands the command to the
 * service, which re-derives Project access and delegates every thread-creating
 * step to the mode that owns it.
 */
export function createThreadCheckpointRouteHandler(deps: ThreadCheckpointRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!url.pathname.startsWith("/api/checkpoints")) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Checkpoint API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/checkpoints" && request.method === "GET") {
      return listCheckpoints(request, url, origin, deps, now);
    }
    if (url.pathname === "/api/checkpoints/commands" && request.method === "POST") {
      return executeCommand(request, url, origin, deps, now);
    }
    return undefined;
  };
}

async function listCheckpoints(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ThreadCheckpointRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.searchParams.size !== 1 || !url.searchParams.has("threadId")) {
      return failure("Checkpoint list request is invalid.", 400, origin);
    }
    windowId = authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
  } catch (error) {
    return authenticationFailure(error, "Checkpoint list", origin);
  }
  const threadId = url.searchParams.get("threadId") ?? "";
  if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH) {
    return failure("Checkpoint list request is invalid.", 400, origin);
  }
  try {
    return json({ checkpoints: await deps.checkpoints.list(windowId, threadId) }, origin);
  } catch (error) {
    return serviceFailure(error, "Checkpoint list failed.", origin);
  }
}

async function executeCommand(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ThreadCheckpointRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") return failure("Checkpoint command is invalid.", 400, origin);
    windowId = authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
  } catch (error) {
    return authenticationFailure(error, "Checkpoint command", origin);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("Checkpoint command body is invalid.", 400, origin);
  }
  try {
    return json(await deps.checkpoints.execute(windowId, body), origin);
  } catch (error) {
    return serviceFailure(error, "Checkpoint command failed.", origin);
  }
}

function serviceFailure(error: unknown, fallback: string, origin: string | null): Response {
  if (error instanceof ThreadCheckpointError) {
    const status =
      error.category === "conflict" ? 409 : error.category === "unavailable" ? 503 : 400;
    return failure(error.message, status, origin);
  }
  return failure(fallback, 500, origin);
}

function authenticationFailure(error: unknown, action: string, origin: string | null): Response {
  return error instanceof WindowAuthorityError
    ? failure(`${action} is unauthorized.`, 401, origin)
    : failure(`${action} request is invalid.`, 400, origin);
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
