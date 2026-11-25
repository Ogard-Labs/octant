import { decodeRemoveArchivedWorktreeRequest } from "@octant/contracts/archived-worktrees";
import { decodeRestoreCleanedUpWorktreeRequest } from "@octant/contracts/cleaned-up-worktrees";
import { principalActsAsHostPerson } from "./clientPrincipal";
import { refused, type ArchivedWorktrees } from "./code/archivedWorktrees";
import { cleanedUpRefusal, type CleanedUpWorktrees } from "./code/cleanedUpWorktrees";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_024;
export const ARCHIVED_WORKTREES_PATH = "/api/code/archived-worktrees";
export const ARCHIVED_WORKTREE_REMOVE_PATH = "/api/code/archived-worktrees/remove";
export const CLEANED_UP_WORKTREES_PATH = "/api/code/cleaned-up-worktrees";
export const CLEANED_UP_WORKTREE_RESTORE_PATH = "/api/code/cleaned-up-worktrees/restore";

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
  readonly cleanedUp: Pick<CleanedUpWorktrees, "list" | "restore">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Code › Worktrees. Reading, removing and restoring are a window on
 * this host's, or a device the host's own person paired: the lists name folders
 * on this computer, removing one deletes files from its disk and restoring one
 * writes them, so a device the hub introduced or a restricted one gets none.
 */
export function createArchivedWorktreeRouteHandler(
  dependencies: ArchivedWorktreeRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    const cleanedUpPath =
      url.pathname === CLEANED_UP_WORKTREES_PATH ||
      url.pathname === CLEANED_UP_WORKTREE_RESTORE_PATH;
    if (
      url.pathname !== ARCHIVED_WORKTREES_PATH &&
      url.pathname !== ARCHIVED_WORKTREE_REMOVE_PATH &&
      !cleanedUpPath
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
    if (!principalActsAsHostPerson(principal)) {
      return json(
        cleanedUpPath ? cleanedUpRefusal("unauthorized") : refused("unauthorized"),
        403,
        origin,
      );
    }
    if (url.pathname === CLEANED_UP_WORKTREES_PATH && request.method === "GET") {
      return json(
        { kind: "cleaned-up-worktrees", worktrees: await dependencies.cleanedUp.list() },
        200,
        origin,
      );
    }
    if (url.pathname === CLEANED_UP_WORKTREE_RESTORE_PATH && request.method === "POST") {
      let threadId;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        threadId = decodeRestoreCleanedUpWorktreeRequest(JSON.parse(text) as unknown).threadId;
      } catch {
        return json(cleanedUpRefusal("malformed"), 400, origin);
      }
      const result = await dependencies.cleanedUp.restore(threadId);
      return json(result, result.kind === "cleaned-up-worktree-refused" ? 409 : 200, origin);
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
