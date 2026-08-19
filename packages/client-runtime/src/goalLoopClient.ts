import {
  decodeGoalLoopResult,
  type GoalLoop,
  type GoalLoopCommand,
  type GoalLoopResult,
  type GoalLoopRound,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface GoalLoopClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** The host's view of one thread's loop and the rounds it has taken. */
export interface GoalLoopProjection {
  readonly loop: GoalLoop | null;
  readonly rounds: ReadonlyArray<GoalLoopRound>;
}

export interface GoalLoopClient {
  read(threadId: string, signal?: AbortSignal): Promise<GoalLoopProjection>;
  execute(command: GoalLoopCommand, signal?: AbortSignal): Promise<GoalLoopResult>;
}

export class GoalLoopClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GoalLoopClientFailure";
    this.status = status;
  }
}

/**
 * Client for the authoritative goal loop surface.
 *
 * The host owns every decision a loop makes; this carries the window capability
 * and decodes what the host says. A refusal comes back as a typed result rather
 * than an exception, because "the loop would have widened" is something a
 * person reads, not an error a renderer recovers from.
 */
export function createGoalLoopClient(options: GoalLoopClientOptions): GoalLoopClient {
  const fetch = bindFetchPort(options.fetch);

  return {
    async read(threadId, signal) {
      const url = new URL("/api/goal-loops", options.baseUrl);
      url.searchParams.set("threadId", threadId);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Goal loops are unavailable.",
      );
      const loop = (body as { loop?: unknown }).loop;
      // A thread with no loop is an ordinary read rather than a decode failure.
      if (loop === null || loop === undefined) return { loop: null, rounds: [] };
      const decoded = decodeGoalLoopResult({ kind: "goal-loop", ...(body as object) });
      return decoded.kind === "goal-loop"
        ? { loop: decoded.loop, rounds: decoded.rounds }
        : { loop: null, rounds: [] };
    },

    async execute(command, signal) {
      const url = new URL("/api/goal-loops/commands", options.baseUrl);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Goal loop command failed.",
      );
      return decodeGoalLoopResult(body);
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  unavailableMessage: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new GoalLoopClientFailure(unavailableMessage, 0);
  }
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message = (body as { error?: unknown }).error;
    throw new GoalLoopClientFailure(
      typeof message === "string" ? message : unavailableMessage,
      response.status,
    );
  }
  return body;
}
