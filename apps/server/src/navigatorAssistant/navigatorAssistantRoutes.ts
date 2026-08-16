import type { WindowId } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  NavigatorAssistantServiceError,
  type NavigatorAssistantService,
} from "./navigatorAssistantService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_048_576;

const SNAPSHOT_PATH = "/api/navigator-assistant/snapshot";
const COMMANDS_PATH = "/api/navigator-assistant/commands";

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

export interface NavigatorAssistantRouteDependencies {
  readonly service: NavigatorAssistantService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Authorize the authenticated window for the host-owned Navigator surface.
   *
   * A window capability proves the caller is a live renderer of this host; it
   * says nothing about whether that renderer may drive Navigator. Navigator's
   * conversation is host-owned and its turns are appended on the host's
   * configured model, so a stale or hostile renderer that still holds a
   * capability must not be able to spend the user's provider budget or read
   * the conversation state. Required rather than optional: a host that cannot
   * authorize must not serve Navigator at all.
   */
  readonly authorizeWindow: (input: { readonly windowId: WindowId }) => boolean | Promise<boolean>;
  readonly now?: () => number;
}

/**
 * Navigator's loopback surface.
 *
 * Two endpoints, both window-capability authenticated and then authorized
 * before the service is touched: reading the snapshot and posting one command.
 * There is no mutation endpoint here — Navigator's only command appends a user
 * turn to its own conversation, and anything that would change app state goes
 * back through the surfaces that already own those authority checks.
 */
export function createNavigatorAssistantRouteHandler(
  dependencies: NavigatorAssistantRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/navigator-assistant")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Navigator API requests must use loopback." }, 400, null);
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
        return json({ error: "Navigator request is unauthorized." }, 401, origin);
      }
      return json({ error: "Navigator request is invalid." }, 400, origin);
    }

    if (
      (request.method === "GET" && url.pathname === SNAPSHOT_PATH) ||
      (request.method === "POST" && url.pathname === COMMANDS_PATH)
    ) {
      // Authorize before the service is reached, so an unauthorized caller
      // cannot create the Navigator conversation or spend a provider turn.
      if (!(await dependencies.authorizeWindow({ windowId }))) {
        return json({ error: "Navigator is not authorized for this window." }, 403, origin);
      }
    }

    if (request.method === "GET" && url.pathname === SNAPSHOT_PATH) {
      try {
        return json(dependencies.service.snapshot(windowId), 200, origin);
      } catch {
        return json({ error: "Navigator is unavailable." }, 500, origin);
      }
    }

    if (request.method === "POST" && url.pathname === COMMANDS_PATH) {
      const body = await readJson(request);
      if (body.kind === "too-large") {
        return json({ error: "Request body is too large." }, 413, origin);
      }
      if (body.kind === "invalid") {
        return json({ error: "Request body must be valid JSON." }, 400, origin);
      }
      try {
        return json(await dependencies.service.execute(windowId, body.value), 200, origin);
      } catch (error) {
        if (error instanceof NavigatorAssistantServiceError) {
          return json(
            {
              error: error.message,
              category: error.category,
              ...(error.settingsTarget === undefined
                ? {}
                : { settingsTarget: error.settingsTarget }),
            },
            statusFor(error.category),
            origin,
          );
        }
        return json({ error: "Navigator command failed." }, 500, origin);
      }
    }

    return json({ error: "Not found." }, 404, origin);
  };
}

/**
 * `unconfigured` is a 409: the request was well-formed and authorized, and the
 * host is simply not set up to answer it yet. The body carries the settings
 * deep link that fixes it, so the surface offers the fix rather than a dead end.
 */
function statusFor(category: NavigatorAssistantServiceError["category"]): number {
  switch (category) {
    case "invalid":
      return 400;
    case "unconfigured":
    case "conflict":
      return 409;
    case "unavailable":
      return 503;
  }
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
