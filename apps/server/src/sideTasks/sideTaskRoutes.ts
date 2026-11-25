import {
  decodeContinueSideTaskHere,
  decodeDismissSideTask,
  decodeSetSideTaskReporting,
  decodeStartSideTask,
  type OctantMode,
  type SideTaskChildState,
  type SideTaskResult,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  continueSideTaskHere,
  dismissSideTask,
  startSideTask,
  type SideTaskStartDependencies,
} from "./sideTaskStart";
import type { SideTaskReportStore } from "./sideTaskReportStore";
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
  /**
   * What a started child thread is doing, in the sidebar row vocabulary, as
   * this window may read it. `undefined` when the child cannot be read — the
   * receipt then says nothing rather than guessing. Absent on a host that
   * cannot read thread activity.
   */
  readonly childState?: (input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly windowId: string;
    /**
     * Shares one read across the started tasks of a single GET: several
     * children in one mode answer from the same navigation snapshot instead
     * of each re-reading it. The cache lives only for the request.
     */
    readonly share?: <T>(key: string, read: () => Promise<T>) => Promise<T>;
  }) => Promise<SideTaskChildState | undefined> | SideTaskChildState | undefined;
  /**
   * The report journal a started child's reporting switch writes to. Absent
   * on a host without report-back, where the action refuses and reads omit
   * the field.
   */
  readonly reports?: Pick<SideTaskReportStore, "setReporting" | "reportingOn">;
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
 * A thread's side-task offers: read them, start one in a new thread or
 * continue it in this one with an explicit confirmation, or dismiss it. The
 * thread the offer came from is what the window must be allowed to act on,
 * checked before anything is created or sent; a new thread then carries its
 * own.
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
      const sideTasks = dependencies.store.read(threadId);
      const childState = dependencies.childState;
      const reports = dependencies.reports;
      if (sideTasks === undefined || (childState === undefined && reports === undefined)) {
        return json({ sideTasks }, 200, origin);
      }
      // The child's live state and reporting switch are read-time
      // enrichment: they ride on the task view but are never journaled, and
      // each is simply absent when the host cannot answer it.
      const shared = new Map<string, Promise<unknown>>();
      const share = <T>(key: string, read: () => Promise<T>): Promise<T> => {
        const existing = shared.get(key);
        if (existing !== undefined) return existing.then((value) => value as T);
        const pending = read();
        shared.set(key, pending);
        return pending;
      };
      const tasks = await Promise.all(
        sideTasks.tasks.map(async (task) => {
          if (task.status !== "started" || task.startedThreadId === undefined) return task;
          const state =
            childState === undefined
              ? undefined
              : await childState({
                  mode: task.offer.mode,
                  threadId: task.startedThreadId,
                  windowId,
                  share,
                });
          const reporting =
            reports === undefined
              ? undefined
              : reports.reportingOn(task.startedThreadId)
                ? ("on" as const)
                : ("stopped" as const);
          return {
            ...task,
            ...(state === undefined ? {} : { childState: state }),
            ...(reporting === undefined ? {} : { reporting }),
          };
        }),
      );
      return json({ sideTasks: { ...sideTasks, tasks } }, 200, origin);
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
        context: command.context,
      });
      return json(result, statusFor(result), origin);
    }
    if (action === "continue") {
      let command;
      try {
        command = decodeContinueSideTaskHere(body);
      } catch {
        return json(
          { error: "Continuing a side task here requires an explicit confirmation." },
          400,
          origin,
        );
      }
      const result = await continueSideTaskHere(dependencies, {
        threadId,
        windowId,
        sideTaskId: String(command.sideTaskId),
      });
      return json(result, statusFor(result), origin);
    }
    if (action === "reporting") {
      let command;
      try {
        command = decodeSetSideTaskReporting(body);
      } catch {
        return json({ error: "Side task reporting change is invalid." }, 400, origin);
      }
      const result = setSideTaskReporting(dependencies, {
        threadId,
        sideTaskId: String(command.sideTaskId),
        on: command.on,
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

/**
 * The person stops or resumes the reports a started child owes this thread.
 * Only a started task has a child thread to switch; anything else is the
 * same refusal a dismissal of it would give.
 */
function setSideTaskReporting(
  dependencies: SideTaskRouteDependencies,
  input: { readonly threadId: string; readonly sideTaskId: string; readonly on: boolean },
): SideTaskResult {
  const refused = (
    reason: "not-found" | "already-settled" | "target-unavailable",
  ): SideTaskResult => ({
    kind: "side-task-refused",
    sideTaskId: input.sideTaskId,
    reason,
    message:
      reason === "not-found"
        ? "That side task is no longer offered on this thread."
        : reason === "already-settled"
          ? "That side task was already started, continued here, or dismissed."
          : "That side task cannot report back here.",
  });
  const reports = dependencies.reports;
  if (reports === undefined) return refused("target-unavailable");
  const task = dependencies.store.find(input.threadId, input.sideTaskId);
  if (task === undefined) return refused("not-found");
  if (task.status !== "started" || task.startedThreadId === undefined) {
    return refused("already-settled");
  }
  reports.setReporting(task.startedThreadId, input.on);
  return {
    kind: "side-task-reporting",
    sideTaskId: task.offer.id,
    reporting: input.on ? "on" : "stopped",
  };
}
