import type { WindowId } from "@octant/contracts/shell";
import {
  ProductFeedbackError,
  type ProductFeedbackService,
} from "./browser/productFeedbackService";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const MAX_THREAD_ID_LENGTH = 128;

export interface ProductFeedbackRouteDependencies {
  readonly feedback: Pick<ProductFeedbackService, "list" | "execute">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * The pointed-at feedback surface: read a thread's notes, leave one, throw one
 * away.
 *
 * The route decides nothing. It authenticates the window and hands the command
 * to the service, which checks thread access before the host reads its own page
 * and resolves the element itself rather than believing the caller.
 */
export function createProductFeedbackRouteHandler(deps: ProductFeedbackRouteDependencies) {
  const now = deps.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (!url.pathname.startsWith("/api/feedback")) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return failure("Feedback API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === "/api/feedback/notes" && request.method === "GET") {
      return listNotes(request, url, origin, deps, now);
    }
    if (url.pathname === "/api/feedback/commands" && request.method === "POST") {
      return executeCommand(request, url, origin, deps, now);
    }
    return undefined;
  };
}

async function listNotes(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ProductFeedbackRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.searchParams.size !== 1 || !url.searchParams.has("threadId")) {
      return failure("Feedback list request is invalid.", 400, origin);
    }
    windowId = authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
  } catch (error) {
    return authenticationFailure(error, "Feedback list", origin);
  }
  const threadId = url.searchParams.get("threadId") ?? "";
  if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH) {
    return failure("Feedback list request is invalid.", 400, origin);
  }
  try {
    return json({ notes: await deps.feedback.list(windowId, threadId) }, origin);
  } catch (error) {
    return serviceFailure(error, "Feedback list failed.", origin);
  }
}

async function executeCommand(
  request: Request,
  url: URL,
  origin: string | null,
  deps: ProductFeedbackRouteDependencies,
  now: () => number,
): Promise<Response> {
  let windowId: WindowId;
  try {
    if (url.search !== "") return failure("Feedback command is invalid.", 400, origin);
    windowId = authenticateRouteWindowId({ request, store: deps.windowAuthorityStore, now: now() });
  } catch (error) {
    return authenticationFailure(error, "Feedback command", origin);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return failure("Feedback command body is invalid.", 400, origin);
  }
  try {
    return json(await deps.feedback.execute(windowId, body), origin);
  } catch (error) {
    return serviceFailure(error, "Feedback command failed.", origin);
  }
}

function serviceFailure(error: unknown, fallback: string, origin: string | null): Response {
  if (error instanceof ProductFeedbackError) {
    return failure(error.message, error.category === "conflict" ? 409 : 400, origin);
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
