import {
  decodeCodeThreadId,
  type CodeThreadId,
  type EventActor,
  type WindowId,
} from "@octant/contracts";
import {
  decodeStopCodeThreadPullRequestWait,
  type CodeThreadPullRequestWait,
  type CodeThreadPullRequestWaits,
  type StopCodeThreadPullRequestWait,
  type StopCodeThreadPullRequestWaitResult,
} from "@octant/contracts/code-project-pull-request-switches";
import { eventActorForPrincipal } from "../principalEventActor";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { allowedOrigin, headers, response } from "./codeSessionRoutes";

const MAX_BODY_BYTES = 4_096;
const WAITS_PATH = "/api/code-thread-waits";
const STOP_WAIT_PATH = "/api/code-thread-waits/stop";

/** What the routes need of a thread's pull-request waits; GitHub stays behind it. */
export interface CodeThreadPullRequestWaitSource {
  readonly threadWaits: (threadId: CodeThreadId) => ReadonlyArray<CodeThreadPullRequestWait>;
  readonly stopThreadWait: (
    input: Omit<StopCodeThreadPullRequestWait, "kind"> & { readonly actor: EventActor },
  ) => boolean;
}

export interface CodePullRequestWaitRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Whether this window may open the Code thread, judged as reading the thread is. */
  readonly canOpenThread: (windowId: WindowId, threadId: CodeThreadId) => boolean;
  /** A window on this host or the host's own paired device; never an agent or a routine. */
  readonly isPerson: (windowId: WindowId) => boolean;
  readonly waits: CodeThreadPullRequestWaitSource;
  readonly now?: () => number;
}

/**
 * `GET /api/code-thread-waits?threadId=` lists the pull requests a Code thread
 * waits on between turns, for a window that can open the thread.
 * `POST /api/code-thread-waits/stop` stops one of them, for the person.
 */
export function createCodePullRequestWaitRouteHandler(deps: CodePullRequestWaitRouteDependencies) {
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== WAITS_PATH && url.pathname !== STOP_WAIT_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname) || !allowedOrigin(origin))
      return response({ error: "Thread wait request origin is not allowed." }, 400, null);
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: headers(origin) });
    const read = request.method === "GET" && url.pathname === WAITS_PATH;
    const stop = request.method === "POST" && url.pathname === STOP_WAIT_PATH;
    if (!read && !stop)
      return response({ error: "Thread wait method is not supported." }, 405, origin);
    let windowId: WindowId;
    let actor: EventActor;
    try {
      const context = authenticateRoutePrincipal({
        request,
        store: deps.windowAuthorityStore,
        now: (deps.now ?? Date.now)(),
      });
      windowId = context.scopeId;
      actor = eventActorForPrincipal(context.principal);
    } catch (error) {
      return response(
        { error: "Thread wait request is unauthorized." },
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
        return response({ error: "Thread wait target is invalid." }, 400, origin);
      }
      if (!deps.canOpenThread(windowId, threadId))
        return response({ error: "This thread is not open to this window." }, 403, origin);
      const answer: CodeThreadPullRequestWaits = {
        threadId,
        waits: deps.waits.threadWaits(threadId),
      };
      return response(answer, 200, origin);
    }
    if (!deps.isPerson(windowId))
      return response({ error: "Only the person can stop what a thread waits on." }, 403, origin);
    if (url.search !== "")
      return response({ error: "Thread wait command target is invalid." }, 400, origin);
    let command: StopCodeThreadPullRequestWait;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error();
      command = decodeStopCodeThreadPullRequestWait(JSON.parse(text));
    } catch {
      return response({ error: "Thread wait command is invalid." }, 400, origin);
    }
    if (!deps.canOpenThread(windowId, command.threadId))
      return response({ error: "This thread is not open to this window." }, 403, origin);
    const { kind: _kind, ...named } = command;
    const answer: StopCodeThreadPullRequestWaitResult = {
      kind: "code-thread-pull-request-wait-stopped",
      stopped: deps.waits.stopThreadWait({ ...named, actor }),
    };
    return response(answer, 200, origin);
  };
}
