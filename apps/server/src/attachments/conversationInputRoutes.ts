import {
  decodeConversationInputManifest,
  decodeConversationInputQuery,
  type ConversationInputQuery,
  type ConversationInputManifest,
} from "@octant/contracts/conversation-inputs";
import type { WindowId } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

/** A read of an admitted turn's private input manifest, never a caller-supplied store reference. */
export function createConversationInputRoutes(options: {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly read: (
    windowId: WindowId,
    query: ConversationInputQuery,
  ) => Promise<ConversationInputManifest | undefined>;
  readonly now?: () => number;
}) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/conversation-inputs") return undefined;
    const origin = request.headers.get("origin");
    const headers = {
      "cache-control": "no-store",
      "access-control-allow-origin": origin ?? "",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "x-octant-window-capability",
    };
    const response = (body: unknown, status = 200) => Response.json(body, { status, headers });
    if (!isLoopbackHostname(url.hostname) || (origin !== null && !allowedOrigin(origin)))
      return response({ error: "Renderer origin is not allowed." }, 400);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "GET")
      return response({ error: "Original input manifests are read-only." }, 405);
    try {
      const windowId = authenticateRouteWindowId({
        request,
        store: options.windowAuthorityStore,
        now: options.now?.() ?? Date.now(),
      });
      const query = decodeConversationInputQuery(Object.fromEntries(url.searchParams));
      const manifest = await options.read(windowId, query);
      return request.signal.aborted || manifest === undefined
        ? response({ status: "unavailable" })
        : response({ status: "available", manifest: decodeConversationInputManifest(manifest) });
    } catch (error) {
      return error instanceof WindowAuthorityError
        ? response({ error: "Original inputs request is unauthorized." }, 401)
        : response({ status: "unavailable" });
    }
  };
}
function allowedOrigin(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
