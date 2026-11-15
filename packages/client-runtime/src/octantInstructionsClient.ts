import { decodeHostAnswer } from "@octant/contracts";
import {
  OctantInstructionsResult,
  OctantInstructionsView,
  type OctantInstructionsCommand,
} from "@octant/contracts/octant-instructions";
import { bindFetchPort } from "./bindFetchPort";

export interface OctantInstructionsClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class OctantInstructionsClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OctantInstructionsClientFailure";
    this.status = status;
  }
}

/** Settings › General: the instructions the person writes for Octant on this host. */
export interface OctantInstructionsClient {
  read(signal?: AbortSignal): Promise<OctantInstructionsView>;
  change(
    command: OctantInstructionsCommand,
    signal?: AbortSignal,
  ): Promise<OctantInstructionsResult>;
}

export function createOctantInstructionsClient(
  options: OctantInstructionsClientOptions,
): OctantInstructionsClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async read(signal) {
      const body = await send(
        fetch,
        new URL("/api/octant-instructions", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Your instructions could not be read from this host.",
      );
      return decodeHostAnswer(OctantInstructionsView)(body);
    },
    async change(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/octant-instructions/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Your instructions could not be saved.",
      );
      return decodeHostAnswer(OctantInstructionsResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why the change was not made. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "kind" in body &&
    body.kind === "octant-instructions-refused"
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
    throw new OctantInstructionsClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OctantInstructionsClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new OctantInstructionsClientFailure(message, response.status);
  }
  return body;
}
