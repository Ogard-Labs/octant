import {
  decodeTerminalSessionHistoryRequest,
  decodeTerminalSessionHistoryResponse,
  decodeTerminalSessionListRequest,
  decodeTerminalSessionListResponse,
  type Project,
  type ProjectId,
} from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import type { TerminalSessionImports } from "./terminalSessions/terminalSessionImports";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const LIST_PATH = "/api/terminal-sessions/list";
const HISTORY_PATH = "/api/terminal-sessions/history";
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const MAX_BODY_BYTES = 4 * 1024;

export interface TerminalSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly allowedRendererHttpOrigin?: string | null;
  readonly imports: Pick<TerminalSessionImports, "list" | "history">;
  readonly readProject: (projectId: ProjectId) => Project | undefined;
  readonly now?: () => number;
}

/**
 * Local-window-only routes for terminal sessions: the sessions in a
 * Project's folder, and the history a thread started from. The sessions are
 * files in the person's home folder, so a paired device never lists them.
 */
export function createTerminalSessionRouteHandler(
  dependencies: TerminalSessionRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  const now = dependencies.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== LIST_PATH && url.pathname !== HISTORY_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return failure("Terminal sessions require loopback.", 400, null);
    if (origin !== null && !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin))
      return failure("Renderer origin is not allowed.", 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST" || url.search !== "")
      return failure("Terminal sessions require POST.", 405, origin);
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      if (context.principal.kind !== "local-window")
        return failure("Terminal sessions are local-window only.", 403, origin);
    } catch (error) {
      return failure(
        "Terminal session request is unauthorized.",
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    let body: unknown;
    try {
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_BODY_BYTES)
        return failure("Terminal session request is too large.", 413, origin);
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return failure("Terminal session request is invalid.", 400, origin);
    }
    if (url.pathname === HISTORY_PATH) {
      let threadId: string;
      try {
        threadId = decodeTerminalSessionHistoryRequest(body).threadId;
      } catch {
        return failure("Terminal session request is invalid.", 400, origin);
      }
      try {
        const imported = dependencies.imports.history(threadId);
        return json(
          decodeTerminalSessionHistoryResponse(imported === undefined ? {} : { imported }),
          origin,
        );
      } catch {
        return failure("Imported history is unavailable.", 503, origin);
      }
    }
    let projectId: ProjectId;
    try {
      projectId = decodeTerminalSessionListRequest(body).projectId;
    } catch {
      return failure("Terminal session request is invalid.", 400, origin);
    }
    const project = dependencies.readProject(projectId);
    if (project === undefined || project.type === "chat" || project.lifecycle !== "active")
      return failure("That Project has no folder.", 404, origin);
    try {
      const sessions = await dependencies.imports.list(project.binding.canonicalRoot);
      return json(decodeTerminalSessionListResponse({ sessions }), origin);
    } catch {
      return failure("Terminal sessions are unavailable.", 503, origin);
    }
  };
}

function json(value: unknown, origin: string | null): Response {
  return Response.json(value, { status: 200, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}
