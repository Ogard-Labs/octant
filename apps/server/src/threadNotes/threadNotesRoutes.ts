import {
  decodeThreadNotesResult,
  type EventActor,
  type ThreadNotesResult,
  type WindowId,
} from "@octant/contracts";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const COMMANDS_PATH = "/api/thread-notes/commands";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
/** A note is at most a few thousand characters; the body never needs more. */
const BODY_LIMIT = 32_768;

export interface ThreadNotesRouteDependencies {
  readonly service: {
    execute(
      command: unknown,
      context: { readonly windowId: WindowId; readonly actor: EventActor },
    ): Promise<ThreadNotesResult>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

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

function statusFor(result: ThreadNotesResult): number {
  if (result.kind !== "thread-notes-refused") return 200;
  if (result.reason === "thread-unavailable" || result.reason === "note-not-found") return 404;
  if (result.reason === "not-the-person") return 403;
  return 409;
}

/**
 * The person's notes on a thread and its recap. The route proves a live
 * window or a device the host's own person paired, and names the actor from
 * that authenticated principal; the service checks the thread itself.
 */
export function createThreadNotesRouteHandler(dependencies: ThreadNotesRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Thread note requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    let context;
    try {
      context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Thread note request is unauthorized." }, 401, origin);
      }
      return json({ error: "Thread note request is invalid." }, 400, origin);
    }
    // A device paired for someone else is held to the remote action
    // catalogue and does not act as the host's person, so it keeps no notes.
    if (!principalActsAsHostPerson(context.principal)) {
      return json({ error: "Thread note request is unauthorized." }, 403, origin);
    }
    const raw = await request.arrayBuffer();
    if (raw.byteLength > BODY_LIMIT) {
      return json({ error: "Request body is too large." }, 413, origin);
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ error: "Thread note body must be valid JSON." }, 400, origin);
    }
    let result: ThreadNotesResult;
    try {
      result = await dependencies.service.execute(body, {
        windowId: context.scopeId,
        actor: eventActorForPrincipal(context.principal),
      });
    } catch {
      return json({ error: "Thread note command is invalid." }, 400, origin);
    }
    return json(decodeThreadNotesResult(result), statusFor(result), origin);
  };
}
