import {
  decodeGithubCloneCommand,
  decodeGithubCloneCommandResponse,
  decodeGithubCloneOperationList,
  type GithubCloneCommand,
  type GithubCloneCommandResponse,
  type GithubCloneOperationList,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface GithubCloneClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface GithubCloneClient {
  execute(command: GithubCloneCommand): Promise<GithubCloneCommandResponse>;
  listOperations(): Promise<GithubCloneOperationList>;
}

export class GithubCloneClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubCloneClientFailure";
    this.status = status;
  }
}

/**
 * Typed transport for the host's managed-clone routes. Commands and responses
 * are validated against the strict wire contracts, so a renderer can never
 * construct a raw endpoint, smuggle an unconfirmed effect, or accept a
 * response carrying credential-shaped material.
 */
export function createGithubCloneClient(options: GithubCloneClientOptions): GithubCloneClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const headers = {
    "x-octant-window-capability": options.windowCapability,
  } as const;

  async function send(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), init);
    } catch {
      throw new GithubCloneClientFailure("GitHub clone is unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "GitHub clone request failed.";
      throw new GithubCloneClientFailure(message, response.status);
    }
    return body;
  }

  return {
    async execute(command) {
      const validated = decodeRequest(command, decodeGithubCloneCommand);
      const body = await send("/api/github/clone/commands", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(validated),
      });
      return decodeResponse(body, decodeGithubCloneCommandResponse);
    },
    async listOperations() {
      const body = await send("/api/github/clone/operations", { method: "GET", headers });
      return decodeResponse(body, decodeGithubCloneOperationList);
    },
  };
}

function decodeRequest<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new GithubCloneClientFailure("GitHub clone command is invalid.", 0);
  }
}

function decodeResponse<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new GithubCloneClientFailure("GitHub clone returned an invalid response.", 0);
  }
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GithubCloneClientFailure("GitHub clone base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new GithubCloneClientFailure("GitHub clone base URL must be loopback.", 0);
  }
}
