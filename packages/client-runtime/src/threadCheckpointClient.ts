import {
  decodeThreadCheckpointCommandResult,
  decodeThreadCheckpointList,
  type ThreadCheckpoint,
  type ThreadCheckpointCommand,
  type ThreadCheckpointCommandResult,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadCheckpointClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadCheckpointClient {
  list(threadId: string, signal?: AbortSignal): Promise<ReadonlyArray<ThreadCheckpoint>>;
  execute(
    command: ThreadCheckpointCommand,
    signal?: AbortSignal,
  ): Promise<ThreadCheckpointCommandResult>;
}

/**
 * A checkpoint request the host turned down, carrying the host's status so the
 * renderer can tell a stale marker from an unavailable one without re-deriving
 * checkpoint policy locally.
 */
export class ThreadCheckpointClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ThreadCheckpointClientFailure";
    this.status = status;
  }
}

/**
 * Client for the checkpoint surface.
 *
 * The host owns what a checkpoint may be marked on and what restoring one
 * produces. A refusal comes back as a decoded `checkpoint-refused` result
 * rather than an exception, because it is an answer the user should read, not
 * a transport failure.
 */
export function createThreadCheckpointClient(
  options: ThreadCheckpointClientOptions,
): ThreadCheckpointClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async list(threadId, signal) {
      const url = new URL("/api/checkpoints", options.baseUrl);
      url.searchParams.set("threadId", threadId);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Checkpoints are unavailable.",
      );
      return decodeThreadCheckpointList(body).checkpoints;
    },

    async execute(command, signal) {
      const url = new URL("/api/checkpoints/commands", options.baseUrl);
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
        "Checkpoint command failed.",
      );
      return decodeThreadCheckpointCommandResult(body);
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
    throw new ThreadCheckpointClientFailure(unavailableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ThreadCheckpointClientFailure(
      readString(body, "error") ?? unavailableMessage,
      response.status,
    );
  }
  return body;
}

function readString(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null || !(key in body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ThreadCheckpointClientFailure("Checkpoint base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new ThreadCheckpointClientFailure("Checkpoint base URL must be loopback.", 0);
  }
}
