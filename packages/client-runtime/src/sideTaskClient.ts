import {
  decodeSideTaskResult,
  decodeThreadSideTasks,
  type SideTaskResult,
  type ThreadSideTasks,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface SideTaskClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface SideTaskClient {
  sideTasks(threadId: string, signal?: AbortSignal): Promise<ThreadSideTasks>;
  start(threadId: string, sideTaskId: string, signal?: AbortSignal): Promise<SideTaskResult>;
  dismiss(threadId: string, sideTaskId: string, signal?: AbortSignal): Promise<SideTaskResult>;
}

export class SideTaskClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SideTaskClientFailure";
    this.status = status;
  }
}

const PATH = "/api/side-tasks";

/** A thread's side-task offers. A refusal is a value; only transport and authorization throw. */
export function createSideTaskClient(options: SideTaskClientOptions): SideTaskClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  const url = (threadId: string, action = "") =>
    new URL(
      `${PATH}/${encodeURIComponent(threadId)}${action === "" ? "" : `/${action}`}`,
      options.baseUrl,
    ).toString();
  const post = async (threadId: string, action: string, body: unknown, signal?: AbortSignal) =>
    decodeSideTaskResult(
      await send(fetch, url(threadId, action), {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      }),
    );

  return {
    async sideTasks(threadId, signal) {
      const body = await send(fetch, url(threadId), {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeThreadSideTasks((body as { sideTasks?: unknown }).sideTasks);
    },
    start: (threadId, sideTaskId, signal) =>
      post(threadId, "start", { sideTaskId, confirmed: true }, signal),
    dismiss: (threadId, sideTaskId, signal) => post(threadId, "dismiss", { sideTaskId }, signal),
  };
}

async function send(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new SideTaskClientFailure("Side tasks are unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SideTaskClientFailure("The side task response is malformed.", response.status);
  }
  if (response.status === 401 || response.status === 403) {
    throw new SideTaskClientFailure("The side task request is unauthorized.", response.status);
  }
  const refused =
    typeof body === "object" &&
    body !== null &&
    (body as { kind?: unknown }).kind === "side-task-refused";
  if (!response.ok && !refused) {
    const message =
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : "The side task request failed.";
    throw new SideTaskClientFailure(message, response.status);
  }
  return body;
}
