import { decodeHostAnswer } from "@octant/contracts";
import {
  PersonMemoryResult,
  PersonMemoryView,
  type PersonMemoryCommand,
} from "@octant/contracts/person-memory";
import { bindFetchPort } from "./bindFetchPort";

export interface PersonMemoryClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class PersonMemoryClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PersonMemoryClientFailure";
    this.status = status;
  }
}

/** Settings › Memory: what Octant remembers about the person on this host. */
export interface PersonMemoryClient {
  read(signal?: AbortSignal): Promise<PersonMemoryView>;
  change(command: PersonMemoryCommand, signal?: AbortSignal): Promise<PersonMemoryResult>;
}

export function createPersonMemoryClient(options: PersonMemoryClientOptions): PersonMemoryClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async read(signal) {
      const body = await send(
        fetch,
        new URL("/api/person-memory", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Memory could not be read from this host.",
      );
      return decodeHostAnswer(PersonMemoryView)(body);
    },
    async change(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/person-memory/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Memory could not be changed.",
      );
      return decodeHostAnswer(PersonMemoryResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why the change was not made. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "person-memory-refused"
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
    throw new PersonMemoryClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PersonMemoryClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new PersonMemoryClientFailure(message, response.status);
  }
  return body;
}
