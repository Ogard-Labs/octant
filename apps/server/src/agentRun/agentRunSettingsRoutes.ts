import { decodeUpdateAgentRunPolicySettings } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { AgentRunSettingsStoreError, type AgentRunSettingsStore } from "./agentRunSettingsStore";

const METHODS = "GET, PUT, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface AgentRunSettingsRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<AgentRunSettingsStore, "current" | "update">;
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

function failure(message: string, status: number, origin: string | null): Response {
  return json({ error: message }, status, origin);
}

/**
 * Authenticated Agents settings routes: Off / Ask / Automatic creation
 * posture with server-authoritative persistence. No client
 * value from any other route is ever trusted as the effective posture; every
 * AgentRun creation route reads `store.current()` directly.
 */
export function createAgentRunSettingsRouteHandler(
  dependencies: AgentRunSettingsRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/agent-run-settings") return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("AgentRun settings requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("AgentRun settings request is unauthorized.", 401, origin);
      }
      return failure("AgentRun settings request is invalid.", 400, origin);
    }

    if (request.method === "GET") {
      return json({ settings: dependencies.store.current() }, 200, origin);
    }

    if (request.method === "PUT") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return failure("AgentRun settings body must be valid JSON.", 400, origin);
      }
      let command: ReturnType<typeof decodeUpdateAgentRunPolicySettings>;
      try {
        command = decodeUpdateAgentRunPolicySettings(body);
      } catch {
        return failure("AgentRun settings update is invalid.", 400, origin);
      }
      try {
        const settings = dependencies.store.update(command);
        return json({ settings }, 200, origin);
      } catch (error) {
        if (error instanceof AgentRunSettingsStoreError) {
          return failure(error.message, error.category === "conflict" ? 409 : 400, origin);
        }
        throw error;
      }
    }

    return failure("HTTP method is not supported for this route.", 400, origin);
  };
}
