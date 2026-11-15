import {
  decodeAdoptCodeNativeSession,
  decodeCodeThreadId,
  decodeStopCodeLiveTasks,
  type AdoptCodeNativeSessionResult,
  type CodeLiveTasks,
  type CodeNativeSessionId,
  type CodeNativeSessions,
  type CodeThreadId,
  type WindowId,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { LiveTasks } from "../providers/outlivingSessions";

const MAX_BODY_BYTES = 4_096;
const LIVE_TASKS_PATH = "/api/code-live-tasks";
const STOP_LIVE_TASKS_PATH = "/api/code-live-tasks/stop";
const NATIVE_SESSIONS_PATH = "/api/code-native-sessions";
const ADOPT_NATIVE_SESSION_PATH = "/api/code-native-sessions/adopt";
const PATHS = new Set([
  LIVE_TASKS_PATH,
  STOP_LIVE_TASKS_PATH,
  NATIVE_SESSIONS_PATH,
  ADOPT_NATIVE_SESSION_PATH,
]);

export interface CodeSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Whether this window may open the Code thread, judged as reading the thread is. */
  readonly canOpenThread: (windowId: WindowId, threadId: CodeThreadId) => boolean;
  readonly liveTasks: (threadId: CodeThreadId) => LiveTasks | undefined;
  readonly stopLiveTasks: (threadId: CodeThreadId) => Promise<boolean>;
  /**
   * Whether this caller is the person: a window on this host or the host's
   * own paired device. An agent or the host acting for a routine is not.
   */
  readonly isPerson: (windowId: WindowId) => boolean;
  /** The runtime's sessions a thread may start from; absent, none are offered. */
  readonly nativeSessions: () =>
    | {
        readonly list: (windowId: WindowId, threadId: CodeThreadId) => Promise<CodeNativeSessions>;
        readonly adopt: (
          windowId: WindowId,
          threadId: CodeThreadId,
          nativeSessionId: CodeNativeSessionId,
        ) => Promise<AdoptCodeNativeSessionResult>;
      }
    | undefined;
  readonly now?: () => number;
}

/**
 * `GET /api/code-live-tasks?threadId=` reads the background tasks a Code
 * thread's provider session still runs after its turn completed;
 * `POST /api/code-live-tasks/stop` stops them with the session. Both answer
 * only a window that can open the thread.
 *
 * `GET /api/code-native-sessions?threadId=` lists the provider's own sessions
 * an empty Code thread may start from, and names the one it was started from;
 * `POST /api/code-native-sessions/adopt` starts the thread from one. Both
 * answer only the person, at a window here or on the host's paired device;
 * the runtime then checks the thread's Project and folder.
 */
export function createCodeSessionRouteHandler(deps: CodeSessionRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!PATHS.has(url.pathname)) return undefined;
    if (url.pathname === NATIVE_SESSIONS_PATH || url.pathname === ADOPT_NATIVE_SESSION_PATH)
      return nativeSessionResponse(request, url, deps);
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
      return response({ error: "Live task request origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: headers(origin) });
    const read = request.method === "GET" && url.pathname === LIVE_TASKS_PATH;
    const stop = request.method === "POST" && url.pathname === STOP_LIVE_TASKS_PATH;
    if (!read && !stop)
      return response({ error: "Live task method is not supported." }, 405, origin);
    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        store: deps.windowAuthorityStore,
        now: (deps.now ?? Date.now)(),
      });
    } catch (error) {
      return response(
        { error: "Live task request is unauthorized." },
        error instanceof WindowAuthorityError ? 401 : 400,
        origin,
      );
    }
    if (read) {
      let threadId: CodeThreadId;
      try {
        if (url.searchParams.size !== 1) throw new Error();
        threadId = decodeCodeThreadId(url.searchParams.get("threadId"));
      } catch {
        return response({ error: "Live task target is invalid." }, 400, origin);
      }
      if (!deps.canOpenThread(windowId, threadId))
        return response({ error: "This thread is not open to this window." }, 403, origin);
      const live = deps.liveTasks(threadId);
      const answer: CodeLiveTasks = {
        threadId,
        tasks: (live?.tasks ?? []).slice(0, 64).map((task) => ({
          taskId: task.taskId.slice(0, 256),
          ...(task.description === undefined
            ? {}
            : { description: task.description.slice(0, 512) }),
        })),
        turnRunning: live?.turnRunning ?? false,
      };
      return response(answer, 200, origin);
    }
    if (url.search !== "")
      return response({ error: "Live task command target is invalid." }, 400, origin);
    let threadId: CodeThreadId;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
      threadId = decodeStopCodeLiveTasks(JSON.parse(text)).threadId;
    } catch {
      return response({ error: "Live task command is invalid." }, 400, origin);
    }
    if (!deps.canOpenThread(windowId, threadId))
      return response({ error: "This thread is not open to this window." }, 403, origin);
    const stopped = await deps.stopLiveTasks(threadId);
    return response({ kind: "code-live-tasks-stopped", stopped }, 200, origin);
  };
}

async function nativeSessionResponse(
  request: Request,
  url: URL,
  deps: CodeSessionRouteDependencies,
): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
    return response({ error: "Session request origin is not allowed." }, 400, null);
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: headers(origin) });
  const read = request.method === "GET" && url.pathname === NATIVE_SESSIONS_PATH;
  const adopt = request.method === "POST" && url.pathname === ADOPT_NATIVE_SESSION_PATH;
  if (!read && !adopt) return response({ error: "Session method is not supported." }, 405, origin);
  let windowId: WindowId;
  try {
    windowId = authenticateRouteWindowId({
      request,
      store: deps.windowAuthorityStore,
      now: (deps.now ?? Date.now)(),
    });
  } catch (error) {
    return response(
      { error: "Session request is unauthorized." },
      error instanceof WindowAuthorityError ? 401 : 400,
      origin,
    );
  }
  if (!deps.isPerson(windowId))
    return response({ error: "Only the person can start a thread from a session." }, 403, origin);
  const sessions = deps.nativeSessions();
  if (sessions === undefined)
    return response({ error: "Sessions are not available yet." }, 503, origin);
  if (read) {
    let threadId: CodeThreadId;
    try {
      if (url.searchParams.size !== 1) throw new Error();
      threadId = decodeCodeThreadId(url.searchParams.get("threadId"));
    } catch {
      return response({ error: "Session target is invalid." }, 400, origin);
    }
    return response(await sessions.list(windowId, threadId), 200, origin);
  }
  if (url.search !== "")
    return response({ error: "Session command target is invalid." }, 400, origin);
  let command: ReturnType<typeof decodeAdoptCodeNativeSession>;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
    command = decodeAdoptCodeNativeSession(JSON.parse(text));
  } catch {
    return response({ error: "Session command is invalid." }, 400, origin);
  }
  return response(
    await sessions.adopt(windowId, command.threadId, command.nativeSessionId),
    200,
    origin,
  );
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
