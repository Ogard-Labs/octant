import {
  decodeAdoptWorkNativeSession,
  decodeStopWorkLiveTasks,
  decodeWorkThreadId,
  type AdoptWorkNativeSessionResult,
  type ProviderNativeSessionId,
  type WindowId,
  type WorkLiveTasks,
  type WorkNativeSessions,
  type WorkThreadId,
} from "@octant/contracts";
import { allowedOrigin, headers, response } from "../code/codeSessionRoutes";
import { authenticateRouteWindowId } from "../principalRouteContext";
import type { LiveTasks } from "../providers/outlivingSessions";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const MAX_BODY_BYTES = 4_096;
const LIVE_TASKS_PATH = "/api/work-live-tasks";
const STOP_LIVE_TASKS_PATH = "/api/work-live-tasks/stop";
const NATIVE_SESSIONS_PATH = "/api/work-native-sessions";
const ADOPT_NATIVE_SESSION_PATH = "/api/work-native-sessions/adopt";
const PATHS = new Set([
  LIVE_TASKS_PATH,
  STOP_LIVE_TASKS_PATH,
  NATIVE_SESSIONS_PATH,
  ADOPT_NATIVE_SESSION_PATH,
]);

export interface WorkSessionRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * Whether this window may read and stop the thread's live tasks: a window
   * on this host holding the thread's Project, as for a Code thread's.
   */
  readonly canOpenThread: (windowId: WindowId, threadId: WorkThreadId) => boolean;
  readonly liveTasks: (threadId: WorkThreadId) => LiveTasks | undefined;
  readonly stopLiveTasks: (threadId: WorkThreadId) => Promise<boolean>;
  /**
   * Whether this caller is the person: a window on this host or the host's
   * own paired device. An agent or the host acting for a routine is not.
   */
  readonly isPerson: (windowId: WindowId) => boolean;
  readonly nativeSessions: (
    windowId: WindowId,
    threadId: WorkThreadId,
  ) => Promise<WorkNativeSessions>;
  readonly adoptNativeSession: (
    windowId: WindowId,
    threadId: WorkThreadId,
    nativeSessionId: ProviderNativeSessionId,
  ) => Promise<AdoptWorkNativeSessionResult>;
  readonly now?: () => number;
}

/**
 * The Work thread's kept provider session, as Code's session routes read a
 * Code thread's. `GET /api/work-live-tasks?threadId=` reads the background
 * tasks it still runs after its turn completed and `POST
 * /api/work-live-tasks/stop` stops them with the session, both for a window
 * that holds the thread's Project. `GET /api/work-native-sessions?threadId=`
 * lists the provider's own sessions for the folder the thread works in and
 * `POST /api/work-native-sessions/adopt` starts an empty thread from one, both
 * only for the person; the service then checks the thread, its Project and
 * folder.
 */
export function createWorkSessionRouteHandler(deps: WorkSessionRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!PATHS.has(url.pathname)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
      return response({ error: "Session request origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: headers(origin) });
    const readTasks = request.method === "GET" && url.pathname === LIVE_TASKS_PATH;
    const stopTasks = request.method === "POST" && url.pathname === STOP_LIVE_TASKS_PATH;
    const readSessions = request.method === "GET" && url.pathname === NATIVE_SESSIONS_PATH;
    const adopt = request.method === "POST" && url.pathname === ADOPT_NATIVE_SESSION_PATH;
    if (!readTasks && !stopTasks && !readSessions && !adopt)
      return response({ error: "Session method is not supported." }, 405, origin);
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
    if ((readSessions || adopt) && !deps.isPerson(windowId))
      return response({ error: "Only the person can start a thread from a session." }, 403, origin);
    if (readTasks || readSessions) {
      let threadId: WorkThreadId;
      try {
        if (url.searchParams.size !== 1) throw new Error();
        threadId = decodeWorkThreadId(url.searchParams.get("threadId"));
      } catch {
        return response({ error: "Session target is invalid." }, 400, origin);
      }
      // The service judges a session read against the Projects this caller
      // holds, as it judges a turn; live tasks are read here.
      if (readSessions) return response(await deps.nativeSessions(windowId, threadId), 200, origin);
      if (!deps.canOpenThread(windowId, threadId))
        return response({ error: "This thread is not open to this window." }, 403, origin);
      const live = deps.liveTasks(threadId);
      const answer: WorkLiveTasks = {
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
      return response({ error: "Session command target is invalid." }, 400, origin);
    let text: string;
    try {
      text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
    } catch {
      return response({ error: "Session command is invalid." }, 400, origin);
    }
    if (stopTasks) {
      let threadId: WorkThreadId;
      try {
        threadId = decodeStopWorkLiveTasks(JSON.parse(text)).threadId;
      } catch {
        return response({ error: "Session command is invalid." }, 400, origin);
      }
      if (!deps.canOpenThread(windowId, threadId))
        return response({ error: "This thread is not open to this window." }, 403, origin);
      const stopped = await deps.stopLiveTasks(threadId);
      return response({ kind: "work-live-tasks-stopped", stopped }, 200, origin);
    }
    let command: ReturnType<typeof decodeAdoptWorkNativeSession>;
    try {
      command = decodeAdoptWorkNativeSession(JSON.parse(text));
    } catch {
      return response({ error: "Session command is invalid." }, 400, origin);
    }
    return response(
      await deps.adoptNativeSession(windowId, command.threadId, command.nativeSessionId),
      200,
      origin,
    );
  };
}
