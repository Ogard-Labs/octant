import { decodeDismissSideTask, decodeStartSideTask, type SideTaskResult } from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { dismissSideTask, startSideTask, type SideTaskStartDependencies } from "./sideTaskStart";
import type { SideTaskStore } from "./sideTaskStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const PREFIX = "/api/side-tasks/";

export interface SideTaskRouteDependencies extends SideTaskStartDependencies {
  readonly store: Pick<SideTaskStore, "read" | "find" | "settle">;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Whether this window may read the thread and act on it; never a body field. */
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

function statusFor(result: SideTaskResult): number {
  if (result.kind !== "side-task-refused") return 200;
  return result.reason === "not-found" ? 404 : 409;
}

/**
 * A thread's side-task offers: read them, start one with an explicit
 * confirmation, or dismiss it. The thread the offer came from is what the
 * window must be allowed to act on; the new thread then carries its own.
 */
export function createSideTaskRouteHandler(dependencies: SideTaskRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(PREFIX)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Side task requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
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
        return json({ error: "Side task request is unauthorized." }, 401, origin);
      }
      return json({ error: "Side task request is invalid." }, 400, origin);
    }
    const [threadId = "", action = ""] = url.pathname.slice(PREFIX.length).split("/");
    if (threadId.length === 0) return json({ error: "Thread id is required." }, 400, origin);
    if (!(await dependencies.authorizeThread({ threadId, windowId }))) {
      return json({ error: "Side task request is unauthorized." }, 403, origin);
    }
    if (request.method === "GET" && action === "") {
      return json({ sideTasks: dependencies.store.read(threadId) }, 200, origin);
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Side task body must be valid JSON." }, 400, origin);
    }
    if (action === "start") {
      let command;
      try {
        command = decodeStartSideTask(body);
      } catch {
        return json(
          { error: "Starting a side task requires an explicit confirmation." },
          400,
          origin,
        );
      }
      const result = await startSideTask(dependencies, {
        threadId,
        windowId,
        sideTaskId: String(command.sideTaskId),
      });
      return json(result, statusFor(result), origin);
    }
    if (action === "dismiss") {
      let command;
      try {
        command = decodeDismissSideTask(body);
      } catch {
        return json({ error: "Side task dismissal is invalid." }, 400, origin);
      }
      const result = dismissSideTask(dependencies, {
        threadId,
        sideTaskId: String(command.sideTaskId),
      });
      return json(result, statusFor(result), origin);
    }
    return json({ error: "Unknown side task action." }, 404, origin);
  };
}
