import { Schema } from "effect";
import {
  decodeThreadWakeupCommand,
  ThreadWakeupMode,
  type ThreadWakeupCommand,
  type ThreadWakeupMode as ThreadWakeupModeType,
  type WindowId,
} from "@octant/contracts";
import { principalActsAsHostPerson } from "../clientPrincipal";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ThreadWakeupService } from "./threadWakeupService";

const MAX_BODY_BYTES = 4_096;
const decodeMode = Schema.decodeUnknownSync(ThreadWakeupMode);
const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,255}$/;

export interface ThreadWakeupRouteDependencies {
  /** Read at each request: the service exists once the host has started. */
  readonly service: () =>
    | Pick<ThreadWakeupService, "list" | "read" | "cancel" | "runMissed">
    | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Whether this window, or this device the host's own person paired, may
   * open the thread, judged as it would be to read the thread itself.
   */
  readonly canOpenThread: (
    windowId: WindowId,
    mode: ThreadWakeupModeType,
    threadId: string,
  ) => boolean;
  readonly now?: () => number;
}

/**
 * `GET /api/thread-wakeups?mode=&threadId=` lists a thread's waiting
 * wake-ups; `POST /api/thread-wakeups/commands` cancels one or runs a missed
 * one, as the person at a window that can open its thread or on a device they
 * paired. The device is journaled as the actor.
 */
export function createThreadWakeupRouteHandler(deps: ThreadWakeupRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/thread-wakeups" && url.pathname !== "/api/thread-wakeups/commands")
      return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
      return response({ error: "Wake-up request origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: headers(origin) });
    const read = request.method === "GET" && url.pathname === "/api/thread-wakeups";
    const command = request.method === "POST" && url.pathname === "/api/thread-wakeups/commands";
    if (!read && !command)
      return response({ error: "Wake-up method is not supported." }, 405, origin);
    let windowId: WindowId;
    let person;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: deps.windowAuthorityStore,
        now: (deps.now ?? Date.now)(),
      });
      windowId = context.scopeId;
      person = context.principal;
    } catch (error) {
      return response(
        { error: "Wake-up request is unauthorized." },
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    // A device the host's own person paired is that person; any other device
    // session (one the hub's roster introduced, an agent grant) is not.
    if (!principalActsAsHostPerson(person))
      return response({ error: "Wake-ups are the host's own person's." }, 403, origin);
    const service = deps.service();
    if (service === undefined)
      return response({ error: "Wake-ups are not available yet." }, 503, origin);
    if (read) {
      let mode: ThreadWakeupModeType;
      const threadId = url.searchParams.get("threadId") ?? "";
      try {
        if (url.searchParams.size !== 2 || !THREAD_ID_PATTERN.test(threadId)) throw new Error();
        mode = decodeMode(url.searchParams.get("mode"));
      } catch {
        return response({ error: "Wake-up target is invalid." }, 400, origin);
      }
      if (!deps.canOpenThread(windowId, mode, threadId))
        return response({ error: "This thread is not open to this window." }, 403, origin);
      return response({ wakeups: service.list(mode, threadId) }, 200, origin);
    }
    if (url.search !== "")
      return response({ error: "Wake-up command target is invalid." }, 400, origin);
    let decoded: ThreadWakeupCommand;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
      decoded = decodeThreadWakeupCommand(JSON.parse(text));
    } catch {
      return response({ error: "Wake-up command is invalid." }, 400, origin);
    }
    const wakeup = service.read(String(decoded.wakeupId));
    // A wake-up of a thread this window cannot open reads as absent.
    if (wakeup === undefined || !deps.canOpenThread(windowId, wakeup.mode, wakeup.threadId)) {
      return response(
        { kind: "thread-wakeup-refused", message: "This wake-up no longer waits." },
        200,
        origin,
      );
    }
    const actor = eventActorForPrincipal(person);
    const result =
      decoded.kind === "cancel-thread-wakeup"
        ? service.cancel(String(decoded.wakeupId), actor)
        : await service.runMissed(String(decoded.wakeupId), actor);
    return response(result, 200, origin);
  };
}

function allowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  try {
    const url = new URL(origin);
    return isLoopbackHostname(url.hostname) || url.protocol === "file:";
  } catch {
    return false;
  }
}
function headers(origin: string | null): Record<string, string> {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
  };
}
function response(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}
