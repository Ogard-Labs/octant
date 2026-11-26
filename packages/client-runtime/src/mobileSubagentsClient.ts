import { AgentObservedChild, decodeHostAnswer } from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/*
 * A thread's subagents as the phone reads them: the ones Octant started for
 * the thread's agent and the ones the provider started on its own, in one
 * answer from the computer. Only a phone the computer's own person paired at
 * Full reads them or stops one; the computer refuses every other device.
 */

/** Who started a subagent decides how it is stopped, not how it is shown. */
export type MobileSubagentOrigin = "octant-started" | "provider-started";

export interface MobileSubagent {
  /** The run id, or the provider observation's id. */
  readonly id: string;
  readonly origin: MobileSubagentOrigin;
  readonly task: string;
  /** The host's lifecycle word: running, waiting, completed, failed, … */
  readonly status: string;
  readonly providerInstanceId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  /** The latest line while it works; its final summary or reply once done. */
  readonly latest?: string;
  /** The whole reply of a finished Octant-started run, when the computer kept it. */
  readonly result?: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  /** Whether the computer offers Stop for it now. */
  readonly stoppable: boolean;
  /** The listed subagent that started this one, when it is listed. */
  readonly parentId?: string;
}

export type MobileSubagentsRead =
  | {
      readonly status: "listed";
      readonly subagents: ReadonlyArray<MobileSubagent>;
      readonly truncated: boolean;
    }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

const ACTIVE = new Set(["queued", "starting", "running", "waiting"]);

/** Whether a subagent is still at work, by the host's lifecycle word. */
export function mobileSubagentIsActive(status: string): boolean {
  return ACTIVE.has(status);
}

function text(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.slice(0, limit) : undefined;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function octantStarted(value: unknown): MobileSubagent | undefined {
  const entry = record(value);
  const runId = text(entry?.runId, 256);
  const status = text(entry?.lifecycleStatus, 64);
  const updatedAt = text(entry?.updatedAt, 64);
  if (entry === undefined || runId === undefined || status === undefined || updatedAt === undefined)
    return undefined;
  const route = record(entry.route);
  const result = record(entry.result);
  const reply = text(result?.text, 64_000);
  const providerInstanceId = text(route?.executionProviderInstanceId, 256);
  const modelId = text(route?.executionModelId, 256);
  const effort = text(entry.normalizedReasoning, 64);
  const startedAt = text(entry.createdAt, 64);
  const parentId = text(entry.parentRunId, 256);
  const latest = reply?.split("\n").find((line) => line.trim().length > 0);
  return {
    id: runId,
    origin: "octant-started",
    task: text(entry.task, 2_000) ?? "",
    status,
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    ...(latest === undefined ? {} : { latest: latest.trim().slice(0, 512) }),
    ...(reply === undefined ? {} : { result: reply }),
    ...(startedAt === undefined ? {} : { startedAt }),
    updatedAt,
    // A run is cancelled through the host's own lifecycle while it works.
    stoppable: mobileSubagentIsActive(status),
    ...(parentId === undefined ? {} : { parentId }),
  };
}

function providerStarted(child: AgentObservedChild): MobileSubagent {
  const latest = child.finalSummary ?? child.latestSummary;
  return {
    id: child.observationId,
    origin: "provider-started",
    task: child.task ?? "",
    status: child.lifecycleStatus,
    providerInstanceId: String(child.providerInstanceId),
    ...(child.modelId === undefined ? {} : { modelId: String(child.modelId) }),
    ...(latest.trim().length === 0 ? {} : { latest: latest.trim() }),
    startedAt: child.firstObservedAt,
    updatedAt: child.updatedAt,
    stoppable: child.control === "stop",
    ...(child.parentRunId === undefined ? {} : { parentId: String(child.parentRunId) }),
  };
}

/** Reads every subagent of one thread from the computer that runs it. */
export async function readMobileSubagents(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<MobileSubagentsRead> {
  let response: Response;
  try {
    response = await input.transport.authenticatedFetch({
      method: "GET",
      path: "/api/agent-runs/parent-summary",
      query: `parentThreadId=${encodeURIComponent(input.threadId)}`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404)
    return { status: "refused" };
  if (!response.ok) return { status: "unavailable" };
  try {
    const body = record(await response.json());
    if (body === undefined || !Array.isArray(body.entries)) return { status: "unavailable" };
    const observations = Array.isArray(body.observations) ? body.observations.slice(0, 64) : [];
    const subagents = [
      ...body.entries.slice(0, 64).flatMap((entry) => octantStarted(entry) ?? []),
      ...observations.flatMap((child) => {
        try {
          const decoded = decodeHostAnswer(AgentObservedChild)(child);
          return String(decoded.parentThreadId) === input.threadId
            ? [providerStarted(decoded)]
            : [];
        } catch {
          return [];
        }
      }),
    ];
    return {
      status: "listed",
      subagents,
      truncated: body.observationsTruncated === true || body.entries.length > 64,
    };
  } catch {
    return { status: "unavailable" };
  }
}

export type MobileSubagentStop =
  | { readonly status: "stop-requested" }
  | { readonly status: "refused"; readonly message: string };

const STOP_REFUSED = "The subagent could not be stopped. Nothing changed.";
const STOP_NOT_LIVE = "This subagent already finished.";

/**
 * Asks the computer to stop one subagent. An Octant-started run is cancelled
 * alone, not its children; a provider-started one is asked of the running
 * turn, and reads as stopped only once the provider reports it finished.
 */
export async function stopMobileSubagent(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly subagent: Pick<MobileSubagent, "id" | "origin">;
}): Promise<MobileSubagentStop> {
  const octant = input.subagent.origin === "octant-started";
  let response: Response;
  try {
    response = await input.transport.authenticatedFetch({
      method: "POST",
      path: octant ? "/api/agent-runs/cancel" : "/api/agent-runs/observed/stop",
      contentType: "application/json",
      body: JSON.stringify(
        octant
          ? { runId: input.subagent.id, scope: "self" }
          : { parentThreadId: input.threadId, observationId: input.subagent.id },
      ),
    });
  } catch {
    return { status: "refused", message: STOP_REFUSED };
  }
  if (!response.ok) return { status: "refused", message: STOP_REFUSED };
  try {
    const body = record(await response.json());
    if (octant) {
      const results = Array.isArray(body?.results) ? body.results : [];
      return results.length > 0 &&
        results.every((result) => record(result)?.kind !== "run-command-failed")
        ? { status: "stop-requested" }
        : { status: "refused", message: STOP_REFUSED };
    }
    if (body?.status === "stop-requested") return { status: "stop-requested" };
    return {
      status: "refused",
      message: body?.reason === "not-live" ? STOP_NOT_LIVE : STOP_REFUSED,
    };
  } catch {
    return { status: "refused", message: STOP_REFUSED };
  }
}

/** Background work a thread's provider session still runs after its turn ended. */
export interface MobileLiveTask {
  readonly taskId: string;
  readonly description?: string;
}

export type MobileLiveTasksRead =
  | {
      readonly status: "listed";
      readonly tasks: ReadonlyArray<MobileLiveTask>;
      readonly turnRunning: boolean;
    }
  | { readonly status: "refused" }
  | { readonly status: "unavailable" };

function liveTasksPath(mode: "code" | "work"): string {
  return mode === "code" ? "/api/code-live-tasks" : "/api/work-live-tasks";
}

export async function readMobileLiveTasks(input: {
  readonly transport: MobileRemoteTransport;
  readonly mode: "code" | "work";
  readonly threadId: string;
  readonly signal?: AbortSignal;
}): Promise<MobileLiveTasksRead> {
  let response: Response;
  try {
    response = await input.transport.authenticatedFetch({
      method: "GET",
      path: liveTasksPath(input.mode),
      query: `threadId=${encodeURIComponent(input.threadId)}`,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404)
    return { status: "refused" };
  if (!response.ok) return { status: "unavailable" };
  try {
    const body = record(await response.json());
    if (
      body === undefined ||
      !Array.isArray(body.tasks) ||
      String(body.threadId) !== input.threadId
    )
      return { status: "unavailable" };
    const tasks = body.tasks.slice(0, 64).flatMap((value): ReadonlyArray<MobileLiveTask> => {
      const task = record(value);
      const taskId = text(task?.taskId, 256);
      if (taskId === undefined) return [];
      const description = text(task?.description, 512);
      return [{ taskId, ...(description === undefined ? {} : { description }) }];
    });
    return { status: "listed", tasks, turnRunning: body.turnRunning === true };
  } catch {
    return { status: "unavailable" };
  }
}

/** Stops a thread's live tasks, with the provider session that runs them. */
export async function stopMobileLiveTasks(input: {
  readonly transport: MobileRemoteTransport;
  readonly mode: "code" | "work";
  readonly threadId: string;
}): Promise<MobileSubagentStop> {
  const refused = "The background tasks could not be stopped. Nothing changed.";
  try {
    const response = await input.transport.authenticatedFetch({
      method: "POST",
      path: `${liveTasksPath(input.mode)}/stop`,
      contentType: "application/json",
      body: JSON.stringify({
        kind: input.mode === "code" ? "stop-code-live-tasks" : "stop-work-live-tasks",
        threadId: input.threadId,
      }),
    });
    return response.ok ? { status: "stop-requested" } : { status: "refused", message: refused };
  } catch {
    return { status: "refused", message: refused };
  }
}
