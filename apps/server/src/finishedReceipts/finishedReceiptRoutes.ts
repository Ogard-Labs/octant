import { decodeThreadFinishedReceiptsResponse } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ThreadFinishedReceiptStore } from "./finishedReceiptStore";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/finished-receipts/";

export interface FinishedReceiptRouteDependencies {
  readonly store: Pick<ThreadFinishedReceiptStore, "read">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly authorizeThread: (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) => boolean | Promise<boolean>;
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

/**
 * Serves a thread's host-built finished receipts to an authorized window.
 * Authorization checks the thread on every request before reading the store.
 */
export function createFinishedReceiptRouteHandler(dependencies: FinishedReceiptRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Finished receipt requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405, origin);
    }
    let windowId: string;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: "Finished receipt request is unauthorized." }, 401, origin);
      }
      return json({ error: "Finished receipt request is invalid." }, 400, origin);
    }
    const rest = url.pathname.slice(PREFIX.length);
    if (rest.length === 0 || rest.includes("/")) {
      return json({ error: "Thread id is required." }, 400, origin);
    }
    let threadId: string;
    try {
      threadId = decodeURIComponent(rest);
    } catch {
      return json({ error: "Thread id is invalid." }, 400, origin);
    }
    if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
      return json({ error: "Finished receipt request is unauthorized." }, 403, origin);
    }
    const payload = decodeThreadFinishedReceiptsResponse({
      receipts: dependencies.store.read(threadId),
    });
    return json(payload, 200, origin);
  };
}
