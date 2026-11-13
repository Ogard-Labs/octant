import {
  AGENT_GRANT_ROUTES,
  decodeAgentGrantRevokeRequest,
  type AgentAccessResult,
  type AgentThreadAttributions,
} from "@octant/contracts";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { AGENT_ACCESS_ORIGIN } from "./agentAccessSession";
import type { AgentAccessService } from "./agentAccessService";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;

export type AgentGrantRoutes = (request: Request) => Promise<Response | undefined>;

export interface AgentGrantRouteOptions {
  readonly service: Pick<
    AgentAccessService,
    "list" | "execute" | "attributions" | "turnAttributions"
  >;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Stops the turns a revoked grant's threads are running, when the person asks. */
  readonly stopRunningTurns: (grantId: string) => Promise<void>;
  readonly now?: () => number;
}

/**
 * The grant list, revoking a grant, and which threads each agent started.
 * A local window and a paired device both reach these: a phone can see what
 * an agent may do and end its grant, because revoking only takes authority
 * away. Making or widening a grant stays on the window-only desktop routes.
 * An outside agent never reaches them: its own route guard admits none, and
 * this refuses its principal again.
 */
export function createAgentGrantRouteHandler(options: AgentGrantRouteOptions): AgentGrantRoutes {
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (
      path !== AGENT_GRANT_ROUTES.grants &&
      path !== AGENT_GRANT_ROUTES.revoke &&
      path !== AGENT_GRANT_ROUTES.threads
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return failure("Agent grant requests must use loopback.", 400, null);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: options.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure(error.message, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }
    if (principal.kind === "remote-device" && principal.origin === AGENT_ACCESS_ORIGIN) {
      return failure("An outside agent cannot read or change agent grants.", 403, origin);
    }
    if (url.search !== "") return failure("Agent grant requests take no query.", 400, origin);

    if (path === AGENT_GRANT_ROUTES.grants || path === AGENT_GRANT_ROUTES.threads) {
      if (request.method !== "GET") return failure("Use GET.", 405, origin);
      return json(
        path === AGENT_GRANT_ROUTES.grants
          ? ({ kind: "grants", grants: options.service.list() } satisfies AgentAccessResult)
          : ({
              threads: options.service.attributions(),
              turns: options.service.turnAttributions(),
            } satisfies AgentThreadAttributions),
        200,
        origin,
      );
    }

    if (request.method !== "POST") return failure("Use POST.", 405, origin);
    const text = await request.text().catch(() => undefined);
    if (text === undefined || text.length > BODY_LIMIT) {
      return failure("That request is too large.", 413, origin);
    }
    let revoke;
    try {
      revoke = decodeAgentGrantRevokeRequest(JSON.parse(text));
    } catch {
      return failure("That revoke request is not valid.", 400, origin);
    }
    const result = options.service.execute(
      { kind: "revoke", grantId: revoke.grantId, stopRunningTurns: revoke.stopRunningTurns },
      eventActorForPrincipal(principal),
    );
    if (revoke.stopRunningTurns && result.kind === "done") {
      await options.stopRunningTurns(String(revoke.grantId)).catch(() => undefined);
    }
    return json(result, result.kind === "refused" ? 409 : 200, origin);
  };
}

/**
 * Holds the handler until the remote wiring, which owns the agent access
 * service, binds it; the product route chain is built before that and asks
 * the slot, which answers nothing until then.
 */
export function createAgentGrantRouteSlot(): {
  readonly routes: AgentGrantRoutes;
  readonly bind: (routes: AgentGrantRoutes) => void;
} {
  let bound: AgentGrantRoutes | undefined;
  return {
    routes: async (request) => (bound === undefined ? undefined : bound(request)),
    bind: (routes) => {
      bound = routes;
    },
  };
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(value: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}
