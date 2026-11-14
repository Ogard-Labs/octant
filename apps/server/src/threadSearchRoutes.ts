import {
  decodeThreadSearch,
  MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH,
  THREAD_SEARCH_SCOPES,
  type ThreadSearch,
  type ThreadSearchScope,
  type WindowId,
} from "@octant/contracts";
import type {
  ThreadSearchMode,
  ThreadSearchRows,
  ThreadSearchVisibleThread,
} from "./persistence/threadSearchProjection";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const PATH = "/api/search";

/** One thread a mode lists for the caller, in the shape search needs. */
export interface SearchableThread {
  readonly id: string;
  readonly title: string;
  readonly lifecycle: string;
  readonly projectId?: string | undefined;
  readonly updatedAt: string;
}

export interface ThreadSearchSources {
  readonly search: (
    query: string,
    visible: ReadonlyArray<ThreadSearchVisibleThread>,
    limit: number,
  ) => ThreadSearchRows;
  /**
   * Each mode's own listing for the caller. A mode the host does not run is
   * absent, and a mode whose listing fails is reported unavailable; neither
   * stops the others from being searched.
   */
  readonly chat?: (windowId: WindowId) => ReadonlyArray<SearchableThread>;
  readonly work?: (windowId: WindowId) => ReadonlyArray<SearchableThread>;
  readonly code?: (windowId: WindowId) => Promise<ReadonlyArray<SearchableThread>>;
}

export interface ThreadSearchRouteDependencies {
  readonly sources: ThreadSearchSources;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/search?q=&scope=`: one search over Chat, Work and Code. Each mode
 * names the threads it lists for this caller, and only those are searched,
 * before the hit cap, so neither a hit nor `truncated` reveals a thread the
 * caller could not open.
 */
export function createThreadSearchRouteHandler(dependencies: ThreadSearchRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("unsupported", "Search requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedRendererOrigin(origin)) {
      return failure("unsupported", "Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return failure("invalid", "Search accepts only GET.", 405, origin);
    }
    if (url.searchParams.has("windowId")) {
      return failure("invalid", "Search requests cannot supply window identity.", 400, origin);
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
        return failure("unauthorized", "Search request is unauthorized.", 401, origin);
      }
      return failure("invalid", "Search request is invalid.", 400, origin);
    }
    const parsed = parseSearchRequest(url);
    if (parsed.status === "refused") return failure("invalid", parsed.message, 400, origin);
    const answer = await searchAcrossModes(dependencies.sources, windowId, parsed);
    return Response.json(decodeThreadSearch(answer), { status: 200, headers: corsHeaders(origin) });
  };
}

type ParsedSearch =
  | { readonly status: "parsed"; readonly query: string; readonly scope: ThreadSearchScope }
  | { readonly status: "refused"; readonly message: string };

function parseSearchRequest(url: URL): ParsedSearch {
  for (const key of url.searchParams.keys()) {
    if (key !== "q" && key !== "scope") {
      return { status: "refused", message: "Search request is invalid." };
    }
  }
  if (url.searchParams.getAll("q").length > 1 || url.searchParams.getAll("scope").length > 1) {
    return { status: "refused", message: "Search request is invalid." };
  }
  const query = (url.searchParams.get("q") ?? "").trim();
  if (query.length > MAX_CHAT_TRANSCRIPT_SEARCH_QUERY_LENGTH) {
    return { status: "refused", message: "Search query is too long." };
  }
  const scope = url.searchParams.get("scope") ?? "all";
  const known = THREAD_SEARCH_SCOPES.find((candidate) => candidate === scope);
  if (known === undefined) return { status: "refused", message: "Search scope is unknown." };
  return { status: "parsed", query, scope: known };
}

async function searchAcrossModes(
  sources: ThreadSearchSources,
  windowId: WindowId,
  request: { readonly query: string; readonly scope: ThreadSearchScope },
): Promise<unknown> {
  const modes: ReadonlyArray<ThreadSearchMode> =
    request.scope === "all" ? ["chat", "work", "code"] : [request.scope];
  if (request.query.length === 0) {
    return { query: "", scope: request.scope, hits: [], truncated: false, unavailable: [] };
  }
  const listed = new Map<string, SearchableThread & { readonly mode: ThreadSearchMode }>();
  const unavailable: ThreadSearchMode[] = [];
  for (const mode of modes) {
    const threads = await listMode(sources, mode, windowId);
    if (threads === undefined) {
      unavailable.push(mode);
      continue;
    }
    for (const thread of threads) {
      if (thread.lifecycle !== "active" && thread.lifecycle !== "archived" && mode !== "code") {
        continue;
      }
      listed.set(`${mode}:${thread.id}`, { ...thread, mode });
    }
  }
  const found = sources.search(
    request.query,
    [...listed.values()].map((thread) => ({
      mode: thread.mode,
      threadId: thread.id,
      updatedAt: thread.updatedAt,
    })),
    MAX_CHAT_TRANSCRIPT_SEARCH_HITS,
  );
  const hits: unknown[] = [];
  for (const match of found.matches) {
    const thread = listed.get(`${match.mode}:${match.threadId}`);
    if (thread === undefined) continue;
    const anchorKey = match.mode === "code" ? "operationId" : "turnId";
    hits.push({
      mode: match.mode,
      threadId: thread.id,
      ...(match.anchorId === "" ? {} : { [anchorKey]: match.anchorId }),
      field: match.field,
      title: thread.title,
      // A waiting or interrupted Code thread is listed with the live ones.
      lifecycle: thread.lifecycle === "archived" ? "archived" : "active",
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
      updatedAt: thread.updatedAt,
      snippet: match.snippet,
      ...(match.matchRanges.length === 0 ? {} : { matchRanges: match.matchRanges }),
    });
  }
  const answer: Record<keyof ThreadSearch, unknown> = {
    query: request.query,
    scope: request.scope,
    hits,
    truncated: found.truncated,
    unavailable,
  };
  return answer;
}

async function listMode(
  sources: ThreadSearchSources,
  mode: ThreadSearchMode,
  windowId: WindowId,
): Promise<ReadonlyArray<SearchableThread> | undefined> {
  try {
    if (mode === "chat") return sources.chat?.(windowId);
    if (mode === "work") return sources.work?.(windowId);
    return await sources.code?.(windowId);
  } catch {
    // A mode that cannot list for this caller (not ready, or refused) is
    // reported unavailable rather than failing the search of the others.
    return undefined;
  }
}

function failure(
  category: "invalid" | "unauthorized" | "unsupported",
  message: string,
  status: number,
  origin: string | null,
): Response {
  return Response.json({ category, message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    vary: "Origin",
  });
  if (origin !== null && isAllowedRendererOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}
