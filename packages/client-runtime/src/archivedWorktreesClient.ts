import { decodeHostAnswer } from "@octant/contracts";
import {
  ArchivedWorktreeList,
  RemoveArchivedWorktreeResult,
  type ArchivedWorktree,
} from "@octant/contracts/archived-worktrees";
import { bindFetchPort } from "./bindFetchPort";

export interface ArchivedWorktreesClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ArchivedWorktreesClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ArchivedWorktreesClientFailure";
    this.status = status;
  }
}

/** Settings › Code › Worktrees: the managed worktrees archived threads keep on this host. */
export interface ArchivedWorktreesClient {
  list(signal?: AbortSignal): Promise<ReadonlyArray<ArchivedWorktree>>;
  remove(
    threadId: ArchivedWorktree["threadId"],
    signal?: AbortSignal,
  ): Promise<RemoveArchivedWorktreeResult>;
}

export function createArchivedWorktreesClient(
  options: ArchivedWorktreesClientOptions,
): ArchivedWorktreesClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async list(signal) {
      const body = await send(
        fetch,
        new URL("/api/code/archived-worktrees", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Worktrees could not be read from this host.",
      );
      return decodeHostAnswer(ArchivedWorktreeList)(body).worktrees;
    },
    async remove(threadId, signal) {
      const body = await send(
        fetch,
        new URL("/api/code/archived-worktrees/remove", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify({ threadId, confirmed: true }),
          ...(signal === undefined ? {} : { signal }),
        },
        "The worktree could not be removed.",
      );
      return decodeHostAnswer(RemoveArchivedWorktreeResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why nothing was removed. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "archived-worktree-refused"
  );
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ArchivedWorktreesClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ArchivedWorktreesClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new ArchivedWorktreesClientFailure(message, response.status);
  }
  return body;
}
