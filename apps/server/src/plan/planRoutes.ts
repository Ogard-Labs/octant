import { isLoopbackHostname } from "../shellRoutes";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { WindowId } from "@octant/contracts";
import { PlanService, PlanServiceError } from "./planService";

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

export interface PlanRouteDependencies {
  readonly service: PlanService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Resolve and authorize the target thread for the authenticated window.
   *
   * A window capability proves the caller is a live renderer of this host; it
   * says nothing about which thread that renderer may act on. Without this the
   * route would accept any `threadId` a caller typed, so a stale or hostile
   * renderer could read another thread's Plan or journal state for a thread
   * that does not exist. Required rather than optional: a host that cannot
   * authorize must not serve Plans at all.
   */
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: WindowId;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

export function createPlanRouteHandler(dependencies: PlanRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/plans")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Plan API requests must use loopback." }, 400, null);
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
        return json({ error: "Plan request is unauthorized." }, 401, origin);
      }
      return json({ error: "Plan request is invalid." }, 400, origin);
    }

    if (request.method === "GET" && url.pathname === "/api/plans") {
      const threadId = url.searchParams.get("threadId");
      if (threadId === null || threadId.length === 0) {
        return json({ error: "threadId is required." }, 400, origin);
      }
      if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
        return json({ error: "Plan request is not authorized for this thread." }, 403, origin);
      }
      return json(dependencies.service.read(threadId), 200, origin);
    }

    if (request.method === "POST" && url.pathname === "/api/plans/commands") {
      const body = await readJson(request);
      if (body.kind === "too-large")
        return json({ error: "Request body is too large." }, 413, origin);
      if (body.kind === "invalid")
        return json({ error: "Request body must be valid JSON." }, 400, origin);
      // Authorize the exact thread the service will act on. The command is
      // decoded by the service, so this reads the same field rather than a
      // second copy of it; anything that is not a thread id fails closed here.
      const target = commandThreadId(body.value);
      if (target === undefined) {
        return json({ error: "threadId is required." }, 400, origin);
      }
      if (!(await dependencies.authorizeThread({ threadId: target, windowId }))) {
        return json({ error: "Plan request is not authorized for this thread." }, 403, origin);
      }
      try {
        const result = await dependencies.service.execute(body.value);
        return json(result, 200, origin);
      } catch (error) {
        if (error instanceof PlanServiceError) {
          const status = error.category === "stale" || error.category === "conflict" ? 409 : 400;
          return json({ error: error.message, category: error.category }, status, origin);
        }
        return json({ error: "Plan command failed." }, 500, origin);
      }
    }

    return json({ error: "Not found." }, 404, origin);
  };
}

/** The thread a Plan command names, or undefined when the body cannot name one. */
function commandThreadId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const threadId = (value as { readonly threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.length > 0 ? threadId : undefined;
}

async function readJson(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(raw)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}
