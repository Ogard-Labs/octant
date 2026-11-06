import { decodeReplyDetailReading, REPLY_DETAIL_PATH, type ShellSettings } from "@octant/contracts";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

export interface ReplyDetailRouteDependencies {
  readonly readShellSettings: () => ShellSettings;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/reply-detail`: the person's Reply detail default and the threads
 * that chose their own level, for a client that cannot read shell settings
 * (the phone and a paired browser). It is a read of two presentation fields
 * and nothing else from the settings document: no route here changes them,
 * which stays the shell route's, reachable only from a window on this host.
 * Any authenticated client may read it, as it may read the threads it names.
 */
export function createReplyDetailRouteHandler(dependencies: ReplyDetailRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== REPLY_DETAIL_PATH) return undefined;
    if (!isLoopbackHostname(url.hostname)) {
      return refuse("Reply detail requests must use loopback.", 400);
    }
    if (request.method !== "GET") return refuse("Reply detail is read-only.", 405);
    if (url.search !== "") return refuse("Reply detail takes no query.", 400);
    try {
      authenticateRoutePrincipal({ request, store: dependencies.windowAuthorityStore, now: now() });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return refuse("Reply detail request is unauthorized.", 401);
      }
      return refuse("Reply detail request is invalid.", 400);
    }
    const settings = dependencies.readShellSettings();
    return Response.json(
      decodeReplyDetailReading({
        defaultLevel: settings.replyDetail,
        threads: settings.threadReplyDetail,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  };
}

function refuse(message: string, status: number): Response {
  return Response.json(
    { category: status === 401 ? "invalid" : "unsupported", message },
    { status, headers: { "cache-control": "no-store" } },
  );
}
