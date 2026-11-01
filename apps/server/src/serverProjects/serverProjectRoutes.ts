import {
  decodeServerProjectsCommand,
  type ServerProjectsCommand,
  type ServerProjectsCommandResult,
  type ServerProjectsRefusalReason,
} from "@octant/contracts/server-projects";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ServerProjectPrincipal,
  ServerProjectsChange,
  ServerProjectStore,
} from "./serverProjectStore";

const ROUTE = "/api/server-projects";
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ServerProjectRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly store: Pick<ServerProjectStore, "projects" | "bind" | "rename" | "remove">;
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
 * The Code Projects bound to a folder on a registered server. The principal
 * comes from the authenticated request; only a person at a local window
 * changes the catalog.
 */
export function createServerProjectRouteHandler(dependencies: ServerProjectRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTE) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Server Project requests must use loopback.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return failure("Method not allowed.", 405, origin);
    }
    let body: unknown;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        return failure("Server Project body must be valid JSON.", 400, origin);
      }
    }
    let principal: ServerProjectPrincipal;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
        ...(body === undefined ? {} : { body }),
      });
      // Only a principal that names a local window may change the catalog;
      // any other kind is held to the paired device's refusal.
      principal = context.principal.kind === "local-window" ? "local-window" : "remote-device";
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Server Project request is unauthorized.", 401, origin);
      }
      return failure("Server Project request is invalid.", 400, origin);
    }

    if (request.method === "GET") {
      return json({ view: { projects: dependencies.store.projects() } }, 200, origin);
    }
    let command: ServerProjectsCommand;
    try {
      command = decodeServerProjectsCommand(body);
    } catch {
      return failure("Server Project command is invalid.", 400, origin);
    }
    const change: ServerProjectsChange =
      command.kind === "bind-server-project"
        ? await dependencies.store.bind({
            name: command.name,
            serverId: String(command.serverId),
            folder: command.folder,
            principal,
          })
        : command.kind === "rename-server-project"
          ? dependencies.store.rename({
              projectId: String(command.projectId),
              name: command.name,
              principal,
            })
          : dependencies.store.remove({ projectId: String(command.projectId), principal });
    const result: ServerProjectsCommandResult =
      change.kind === "changed"
        ? { kind: "server-projects-updated", view: { projects: dependencies.store.projects() } }
        : {
            kind: "server-projects-refused",
            reason: change.reason,
            message: change.message ?? MESSAGES[change.reason],
          };
    return json(result, result.kind === "server-projects-updated" ? 200 : 409, origin);
  };
}

const MESSAGES: Readonly<Record<ServerProjectsRefusalReason, string>> = {
  "needs-local-window": "Server Projects can be changed only at this computer.",
  "server-not-registered": "That server is not registered in Settings › Access › Servers.",
  "server-unreachable": "The server could not be reached, so nothing was bound.",
  "folder-not-found": "That folder does not exist on the server, or is not a folder.",
  "project-not-found": "That server Project does not exist.",
  "too-many-projects": "No more server Projects can be bound.",
  unavailable: "The change could not be recorded, so nothing changed.",
};
