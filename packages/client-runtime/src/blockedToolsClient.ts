import { decodeHostAnswer } from "@octant/contracts";
import {
  BlockedToolsResult,
  BlockedToolsSettings,
  type BlockedToolsCommand,
} from "@octant/contracts/blocked-tools";
import { bindFetchPort } from "./bindFetchPort";

export interface BlockedToolsClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class BlockedToolsClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BlockedToolsClientFailure";
    this.status = status;
  }
}

/** Settings › Permissions › Blocked tools: the provider tools the person blocked on this host. */
export interface BlockedToolsClient {
  settings(signal?: AbortSignal): Promise<BlockedToolsSettings>;
  change(command: BlockedToolsCommand, signal?: AbortSignal): Promise<BlockedToolsResult>;
}

export function createBlockedToolsClient(options: BlockedToolsClientOptions): BlockedToolsClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async settings(signal) {
      const body = await send(
        fetch,
        new URL("/api/blocked-tools", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Blocked tools could not be read from this host.",
      );
      return decodeHostAnswer(BlockedToolsSettings)(body);
    },
    async change(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/blocked-tools/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Blocked tools could not be changed.",
      );
      return decodeHostAnswer(BlockedToolsResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why the change was not made. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "blocked-tools-refused"
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
    throw new BlockedToolsClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BlockedToolsClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new BlockedToolsClientFailure(message, response.status);
  }
  return body;
}
