import {
  decodeDesktopAgentWorkSnapshot,
  type DesktopAgentWorkSnapshot,
  type KeepAwakePolicy,
  type MachineChangeTopic,
  type UtcTimestamp,
} from "@octant/contracts";
import { admitDesktopBroker } from "./desktopBrokerAdmission";
import { isLoopbackHostname } from "./shellRoutes";

export const DESKTOP_AGENT_WORK_ROUTE = "/api/desktop/agent-work";

export interface DesktopAgentWorkRoutineSchedule {
  readonly enabled: boolean;
  readonly nextDueAt: UtcTimestamp | null;
}

export interface DesktopAgentWorkActiveTurn {
  readonly threadId: string;
  readonly topic: MachineChangeTopic;
}

export interface DesktopAgentWorkRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly keepAwakePolicy: () => KeepAwakePolicy;
  readonly activeTurns: () => ReadonlyArray<DesktopAgentWorkActiveTurn>;
  /** Whether a running Code thread is a coordinator worker rather than a standalone Code turn. */
  readonly isCoordinatorWorker: (threadId: string) => boolean;
  readonly runningChildRuns: () => number;
  readonly routines: () => ReadonlyArray<DesktopAgentWorkRoutineSchedule>;
  readonly now?: () => Date;
}

function earliestRoutineDueAt(
  routines: ReadonlyArray<DesktopAgentWorkRoutineSchedule>,
): UtcTimestamp | null {
  let earliest: UtcTimestamp | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const routine of routines) {
    if (!routine.enabled || routine.nextDueAt === null) continue;
    const ms = Date.parse(routine.nextDueAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < earliestMs) {
      earliestMs = ms;
      earliest = routine.nextDueAt;
    }
  }
  return earliest;
}

export function buildDesktopAgentWorkSnapshot(
  options: Omit<DesktopAgentWorkRouteOptions, "desktopBridgeSecret">,
): DesktopAgentWorkSnapshot {
  let chat = 0;
  let work = 0;
  let code = 0;
  let coordinatorWorkers = 0;
  for (const turn of options.activeTurns()) {
    if (turn.topic === "chat-navigation") {
      chat += 1;
    } else if (turn.topic === "work-navigation") {
      work += 1;
    } else if (turn.topic === "code-navigation") {
      if (options.isCoordinatorWorker(turn.threadId)) {
        coordinatorWorkers += 1;
      } else {
        code += 1;
      }
    }
  }
  const now = (options.now ?? (() => new Date()))();
  return decodeDesktopAgentWorkSnapshot({
    keepAwake: options.keepAwakePolicy(),
    turns: { chat, work, code },
    childRuns: Math.max(0, Math.floor(options.runningChildRuns())),
    coordinatorWorkers,
    nextRoutineDueAt: earliestRoutineDueAt(options.routines()),
    observedAt: now.toISOString(),
  });
}

/**
 * Loopback-only, desktop-principal-only running-work signal polled by the local
 * desktop app to decide whether to hold a prevent-app-suspension assertion.
 * Returns counts and the next routine due time only — never thread titles or
 * paths — and refuses every non-desktop, browser, remote, or Nightly caller.
 */
export function createDesktopAgentWorkRouteHandler(
  options: DesktopAgentWorkRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? (() => new Date());
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== DESKTOP_AGENT_WORK_ROUTE) return undefined;
    const admission = admitDesktopBroker({
      request,
      desktopBridgeSecret: options.desktopBridgeSecret,
      now: now().getTime(),
    });
    if (
      !isLoopbackHostname(url.hostname) ||
      admission.status !== "admitted" ||
      admission.kind !== "desktop-bridge"
    ) {
      return Response.json(
        { category: "unauthorized", message: "Only this host's desktop can read agent work." },
        { status: 401 },
      );
    }
    if (request.method !== "GET") {
      return Response.json(
        { category: "invalid", message: "HTTP method is not supported for this route." },
        { status: 405 },
      );
    }
    if (url.search !== "") {
      return Response.json({ category: "invalid", message: "Invalid request." }, { status: 400 });
    }
    const snapshot = buildDesktopAgentWorkSnapshot({
      keepAwakePolicy: options.keepAwakePolicy,
      activeTurns: options.activeTurns,
      isCoordinatorWorker: options.isCoordinatorWorker,
      runningChildRuns: options.runningChildRuns,
      routines: options.routines,
      now,
    });
    return Response.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  };
}
