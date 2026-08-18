import {
  decodeThreadPlanUpdated,
  type ThreadPlan,
  type ThreadPlanCommand,
  type ThreadPlanHistoryEntry,
  type ThreadPlanUpdated,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface PlanClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** The host's projection of one thread's Plan and its recorded revisions. */
export interface ThreadPlanProjection {
  readonly plan: ThreadPlan | null;
  readonly history: ReadonlyArray<ThreadPlanHistoryEntry>;
}

export interface PlanClient {
  read(threadId: string, signal?: AbortSignal): Promise<ThreadPlanProjection>;
  execute(command: ThreadPlanCommand, signal?: AbortSignal): Promise<ThreadPlanUpdated>;
}

/**
 * A Plan request the host refused, carrying the host's own category so the
 * renderer can tell a stale version apart from a policy conflict without
 * re-deriving Plan policy locally.
 */
export class PlanClientFailure extends Error {
  readonly status: number;
  readonly category: "invalid" | "stale" | "conflict" | "failed" | "unknown";

  constructor(
    message: string,
    status: number,
    category: PlanClientFailure["category"] = "unknown",
  ) {
    super(message);
    this.name = "PlanClientFailure";
    this.status = status;
    this.category = category;
  }
}

/**
 * Client for the authoritative thread Plan surface.
 *
 * The host owns Plan transitions, versioning, and budget classification; this
 * client only carries the window capability and decodes the host's typed
 * projection. A command reply is decoded so an accepted transition arrives with
 * the host's version rather than a locally guessed one, and a rejection keeps
 * the host's category so callers surface it honestly.
 */
export function createPlanClient(options: PlanClientOptions): PlanClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async read(threadId, signal) {
      const url = new URL("/api/plans", options.baseUrl);
      url.searchParams.set("threadId", threadId);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Thread Plans are unavailable.",
      );
      const plan = (body as { plan?: unknown }).plan;
      // A thread without a Plan is a normal read, not a decode failure, so the
      // strict projection decoder only runs once the host reports a Plan.
      if (plan === null || plan === undefined) return { plan: null, history: [] };
      return decodeThreadPlanUpdated(body);
    },

    async execute(command, signal) {
      const url = new URL("/api/plans/commands", options.baseUrl);
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
        "Plan command failed.",
      );
      return decodeThreadPlanUpdated(body);
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
    throw new PlanClientFailure(unavailableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new PlanClientFailure(
      readString(body, "error") ?? readString(body, "message") ?? unavailableMessage,
      response.status,
      readCategory(body),
    );
  }
  return body;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readCategory(body: unknown): PlanClientFailure["category"] {
  const category = readString(body, "category");
  return category === "invalid" ||
    category === "stale" ||
    category === "conflict" ||
    category === "failed"
    ? category
    : "unknown";
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PlanClientFailure("Plan base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new PlanClientFailure("Plan base URL must be loopback.", 0);
  }
}
