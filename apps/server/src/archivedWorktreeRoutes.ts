import { decodeRemoveArchivedWorktreeRequest } from "@octant/contracts/archived-worktrees";
import { refused, type ArchivedWorktrees } from "./code/archivedWorktrees";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_024;
export const ARCHIVED_WORKTREES_PATH = "/api/code/archived-worktrees";
export const ARCHIVED_WORKTREE_REMOVE_PATH = "/api/code/archived-worktrees/remove";

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
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

export interface ArchivedWorktreeRouteDependencies {
  readonly worktrees: Pick<ArchivedWorktrees, "list" | "remove">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Code › Worktrees. Both reading and removing are a window on this
 * host's: the list names folders on this computer, and removing one deletes
 * files from its disk, so a paired device gets neither.
 */
export function createArchivedWorktreeRouteHandler(
  dependencies: ArchivedWorktreeRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (
      url.pathname !== ARCHIVED_WORKTREES_PATH &&
      url.pathname !== ARCHIVED_WORKTREE_REMOVE_PATH
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Worktree requests must use loopback." }, 400, null);
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
    if (principal.kind !== "local-window") {
      return json(refused("unauthorized"), 403, origin);
    }
    if (url.pathname === ARCHIVED_WORKTREES_PATH && request.method === "GET") {
      return json(
        { kind: "archived-worktrees", worktrees: await dependencies.worktrees.list() },
        200,
        origin,
      );
    }
    if (url.pathname === ARCHIVED_WORKTREE_REMOVE_PATH && request.method === "POST") {
      let threadId;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        threadId = decodeRemoveArchivedWorktreeRequest(JSON.parse(text) as unknown).threadId;
      } catch {
        return json(refused("malformed"), 400, origin);
      }
      const result = await dependencies.worktrees.remove(threadId);
      return json(result, result.kind === "archived-worktree-refused" ? 409 : 200, origin);
    }
    return json({ error: "Worktree route is not found." }, 404, origin);
  };
}
