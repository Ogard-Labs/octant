import {
  decodeMcpPlanReadOnlyCommand,
  decodeMcpPlanReadOnlyResult,
  type McpPlanReadOnlyCommand,
} from "@octant/contracts/mcp-plan-read-only";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import type { McpPlanReadOnlyService } from "./providers/mcpPlanReadOnlyService";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;
export const MCP_PLAN_READ_ONLY_PATH = "/api/mcp-plan-read-only";
export const MCP_PLAN_READ_ONLY_COMMAND_PATH = "/api/mcp-plan-read-only/commands";

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...corsHeaders(origin),
    },
  });
}

export interface McpPlanReadOnlyRouteDependencies {
  readonly service: Pick<McpPlanReadOnlyService, "settings" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › MCP servers, "Read-only — allowed in Plan". Reading the marks
 * needs window authority. Marking a server is the person's act, at a window on
 * this host or on a device they paired, as the other MCP server settings are;
 * an agent grant's session or any other principal is refused, and no agent
 * tool reaches this route.
 */
export function createMcpPlanReadOnlyRouteHandler(dependencies: McpPlanReadOnlyRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== MCP_PLAN_READ_ONLY_PATH &&
      url.pathname !== MCP_PLAN_READ_ONLY_COMMAND_PATH
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "MCP server requests must use loopback." }, 400, null);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return json({ error: "Renderer origin is not allowed." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: error.message }, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }
    if (url.pathname === MCP_PLAN_READ_ONLY_PATH && request.method === "GET") {
      return json(dependencies.service.settings(), 200, origin);
    }
    if (url.pathname === MCP_PLAN_READ_ONLY_COMMAND_PATH && request.method === "POST") {
      if (!principalActsAsHostPerson(principal)) {
        return json(
          decodeMcpPlanReadOnlyResult({
            kind: "mcp-plan-read-only-refused",
            reason: "unauthorized",
            message:
              "Only you can let an MCP server into Plan, from a window on this computer or a device you paired.",
          }),
          403,
          origin,
        );
      }
      let command: McpPlanReadOnlyCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodeMcpPlanReadOnlyCommand(JSON.parse(text) as unknown);
      } catch {
        return json(
          decodeMcpPlanReadOnlyResult({
            kind: "mcp-plan-read-only-refused",
            reason: "malformed",
            message: "That MCP server name is not valid.",
          }),
          400,
          origin,
        );
      }
      const result =
        principal.kind === "remote-device"
          ? dependencies.service.change(command, eventActorForPrincipal(principal))
          : dependencies.service.change(command);
      return json(result, result.kind === "mcp-plan-read-only-refused" ? 409 : 200, origin);
    }
    return json({ error: "MCP server route is not found." }, 404, origin);
  };
}
