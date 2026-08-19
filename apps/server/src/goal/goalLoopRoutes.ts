import type { WindowId } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { GoalLoopService } from "./goalLoopService";

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

async function readJson(
  request: Request,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "too-large" | "invalid" }
> {
  const text = await request.text();
  if (text.length > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

export interface GoalLoopRouteDependencies {
  readonly service: GoalLoopService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Resolve and authorize the target thread for the authenticated window.
   *
   * Same shape and same reason as the Goal routes: a window capability proves
   * the caller is a live renderer of this host and says nothing about which
   * thread it may steer. Required rather than optional — a host that cannot
   * authorize must not serve loops at all.
   */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: WindowId;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

export function createGoalLoopRouteHandler(dependencies: GoalLoopRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/goal-loops")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Goal loop requests must use loopback." }, 400, null);
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
        return json({ error: "Goal loop request is unauthorized." }, 401, origin);
      }
      return json({ error: "Goal loop request is invalid." }, 400, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/goal-loops") {
      const threadId = url.searchParams.get("threadId");
      if (threadId === null || threadId.length === 0) {
        return json({ error: "threadId is required." }, 400, origin);
      }
      if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
        return json({ error: "Goal loop request is not authorized for this thread." }, 403, origin);
      }
      return json(dependencies.service.read(threadId), 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/goal-loops/commands") {
      const body = await readJson(request);
      if (body.kind === "too-large") {
        return json({ error: "Request body is too large." }, 413, origin);
      }
      if (body.kind !== "ok") {
        return json({ error: "Request body must be valid JSON." }, 400, origin);
      }
      const target = commandThreadId(body.value);
      if (target === undefined) {
        return json({ error: "threadId is required." }, 400, origin);
      }
      if (!(await dependencies.authorizeThread({ threadId: target, windowId }))) {
        return json({ error: "Goal loop request is not authorized for this thread." }, 403, origin);
      }
      return json(await dependencies.service.execute(body.value), 200, origin);
    }

    return json({ error: "Not found." }, 404, origin);
  };
}

/** The thread a loop command names, or undefined when the body cannot name one. */
function commandThreadId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const threadId = (value as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}
