import {
  decodeSpendCeilingCommandResult,
  decodeSpendCeilingSnapshot,
  type SpendCeilingCommand,
  type SpendCeilingCommandResult,
  type SpendCeilingSnapshot,
  type SpendCeilingThreadType,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface SpendCeilingClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class SpendCeilingClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SpendCeilingClientFailure";
    this.status = status;
  }
}

export interface SpendCeilingClient {
  snapshot(input: {
    readonly threadId?: string;
    readonly threadType?: SpendCeilingThreadType;
    readonly projectId?: string;
    readonly signal?: AbortSignal;
  }): Promise<SpendCeilingSnapshot>;
  execute(command: SpendCeilingCommand, signal?: AbortSignal): Promise<SpendCeilingCommandResult>;
}

export function createSpendCeilingClient(options: SpendCeilingClientOptions): SpendCeilingClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async snapshot(input) {
      const url = new URL("/api/spend-ceilings", options.baseUrl);
      if (input.threadId !== undefined) url.searchParams.set("threadId", input.threadId);
      if (input.threadType !== undefined) url.searchParams.set("threadType", input.threadType);
      if (input.projectId !== undefined) url.searchParams.set("projectId", input.projectId);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
        "Spend ceilings are unavailable.",
      );
      return decodeSpendCeilingSnapshot(body);
    },
    async execute(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/spend-ceilings/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Spend ceiling command failed.",
      );
      return decodeSpendCeilingCommandResult(body);
    },
  };
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
    throw new SpendCeilingClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new SpendCeilingClientFailure(fallback, response.status);
  }
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new SpendCeilingClientFailure(message, response.status);
  }
  return body;
}
