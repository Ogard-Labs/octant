import {
  decodeLinkedThreadPreviewCommand,
  decodeLinkedThreadPreviewCommandResult,
  decodeLinkedThreadPreviewFailure,
  type LinkedThreadPreviewCommand,
  type LinkedThreadPreviewCommandResult,
  type LinkedThreadPreviewFailure,
} from "@octant/contracts";

export interface LinkedThreadClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface LinkedThreadClient {
  execute(command: LinkedThreadPreviewCommand): Promise<LinkedThreadPreviewCommandResult>;
}

export class LinkedThreadClientFailure extends Error {
  readonly code: LinkedThreadPreviewFailure["code"];

  constructor(failure: LinkedThreadPreviewFailure) {
    super(failure.message);
    this.name = "LinkedThreadClientFailure";
    this.code = failure.code;
  }
}

export function createLinkedThreadClient(options: LinkedThreadClientOptions): LinkedThreadClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    async execute(command) {
      let validated: LinkedThreadPreviewCommand;
      try {
        validated = decodeLinkedThreadPreviewCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        options.fetch,
        new URL("/api/linked-threads/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeLinkedThreadPreviewCommandResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable("Octant linked-thread service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new LinkedThreadClientFailure(decodeLinkedThreadPreviewFailure(body));
    } catch (error) {
      if (error instanceof LinkedThreadClientFailure) throw error;
      throw malformedResponse();
    }
  }
  try {
    return decode(body);
  } catch {
    throw malformedResponse();
  }
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("invalid base url");
    }
  } catch {
    throw unavailable("Linked-thread client requires a loopback server URL.");
  }
}

function unavailable(message: string): LinkedThreadClientFailure {
  return new LinkedThreadClientFailure({ code: "unavailable", message });
}

function invalidCommand(): LinkedThreadClientFailure {
  return new LinkedThreadClientFailure({
    code: "invalid",
    message: "Linked-thread command is invalid.",
  });
}

function malformedResponse(): LinkedThreadClientFailure {
  return new LinkedThreadClientFailure({
    code: "unavailable",
    message: "Linked-thread service returned an invalid response.",
  });
}
