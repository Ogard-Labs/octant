import { decodeHostAnswer } from "@octant/contracts";
import {
  ProtectedFilesResult,
  ProtectedFilesSettings,
  type ProtectedFilesCommand,
} from "@octant/contracts/protected-files";
import { bindFetchPort } from "./bindFetchPort";

export interface ProtectedFilesClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class ProtectedFilesClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ProtectedFilesClientFailure";
    this.status = status;
  }
}

/** Settings › Permissions › Protected files: the secret guard's list on this host. */
export interface ProtectedFilesClient {
  settings(signal?: AbortSignal): Promise<ProtectedFilesSettings>;
  change(command: ProtectedFilesCommand, signal?: AbortSignal): Promise<ProtectedFilesResult>;
}

export function createProtectedFilesClient(
  options: ProtectedFilesClientOptions,
): ProtectedFilesClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async settings(signal) {
      const body = await send(
        fetch,
        new URL("/api/protected-files", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Protected files could not be read from this host.",
      );
      return decodeHostAnswer(ProtectedFilesSettings)(body);
    },
    async change(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/protected-files/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Protected files could not be changed.",
      );
      return decodeHostAnswer(ProtectedFilesResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why the change was not made. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "protected-files-refused"
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
    throw new ProtectedFilesClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ProtectedFilesClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new ProtectedFilesClientFailure(message, response.status);
  }
  return body;
}
