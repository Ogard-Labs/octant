import {
  decodeBlockedToolsCommand,
  decodeBlockedToolsResult,
  type BlockedToolsCommand,
} from "@octant/contracts/blocked-tools";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { eventActorForPrincipal } from "./principalEventActor";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import type { BlockedToolsService } from "./providers/blockedToolsService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 4_096;
export const BLOCKED_TOOLS_PATH = "/api/blocked-tools";
export const BLOCKED_TOOLS_COMMAND_PATH = "/api/blocked-tools/commands";

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

export interface BlockedToolsRouteDependencies {
  readonly service: Pick<BlockedToolsService, "settings" | "change">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Permissions › Blocked tools. Reading the list needs window
 * authority. Changing it is the person's act, at a window on this host or on
 * a device they paired, as the other Permissions settings are; an agent
 * grant's session or any other principal is refused, and no agent tool
 * reaches this route.
 */
export function createBlockedToolsRouteHandler(dependencies: BlockedToolsRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== BLOCKED_TOOLS_PATH && url.pathname !== BLOCKED_TOOLS_COMMAND_PATH) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Blocked tools requests must use loopback." }, 400, null);
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
    if (url.pathname === BLOCKED_TOOLS_PATH && request.method === "GET") {
      return json(dependencies.service.settings(), 200, origin);
    }
    if (url.pathname === BLOCKED_TOOLS_COMMAND_PATH && request.method === "POST") {
      if (!principalActsAsHostPerson(principal)) {
        return json(
          decodeBlockedToolsResult({
            kind: "blocked-tools-refused",
            reason: "unauthorized",
            message:
              "Only you can change blocked tools, from a window on this computer or a device you paired.",
          }),
          403,
          origin,
        );
      }
      let command: BlockedToolsCommand;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        command = decodeBlockedToolsCommand(JSON.parse(text) as unknown);
      } catch {
        return json(
          decodeBlockedToolsResult({
            kind: "blocked-tools-refused",
            reason: "malformed",
            message:
              "That tool name is not valid. Use the provider's own tool name, or server__tool for an MCP server's tool.",
          }),
          400,
          origin,
        );
      }
      const result =
        principal.kind === "remote-device"
          ? dependencies.service.change(command, eventActorForPrincipal(principal))
          : dependencies.service.change(command);
      return json(result, result.kind === "blocked-tools-refused" ? 409 : 200, origin);
    }
    return json({ error: "Blocked tools route is not found." }, 404, origin);
  };
}
