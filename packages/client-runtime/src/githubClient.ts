import {
  decodeGithubAuthenticationCommand,
  decodeGithubAuthenticationSnapshot,
  decodeGithubCatalogueReadRequest,
  decodeGithubCatalogueReadResponse,
  decodeGithubRecentRepositoryCommand,
  type GithubAuthenticationCommand,
  type GithubAuthenticationSnapshot,
  type GithubCatalogueReadRequest,
  type GithubCatalogueReadResponse,
  type GithubRecentRepositoryCommand,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface GithubClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface GithubClient {
  authenticationSnapshot(): Promise<GithubAuthenticationSnapshot>;
  executeAuthenticationCommand(
    command: GithubAuthenticationCommand,
  ): Promise<GithubAuthenticationSnapshot>;
  readCatalogue(request: GithubCatalogueReadRequest): Promise<GithubCatalogueReadResponse>;
  recordRecentRepository(
    command: GithubRecentRepositoryCommand,
  ): Promise<GithubCatalogueReadResponse>;
}

export class GithubClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GithubClientFailure";
    this.status = status;
  }
}

/**
 * Typed transport for the host's GitHub authentication and catalogue routes.
 * Requests and responses are validated against the wire contracts, so a
 * renderer can never construct a raw endpoint, field, host, or mutation.
 */
export function createGithubClient(options: GithubClientOptions): GithubClient {
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
      throw new GithubClientFailure("GitHub is unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "GitHub request failed.";
      throw new GithubClientFailure(message, response.status);
    }
    return body;
  }

  function post(path: string, payload: unknown): Promise<unknown> {
    return send(path, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  return {
    async authenticationSnapshot() {
      const body = await send("/api/github/authentication", { method: "GET", headers });
      return decodeResponse(body, decodeGithubAuthenticationSnapshot);
    },
    async executeAuthenticationCommand(command) {
      const validated = decodeRequest(command, decodeGithubAuthenticationCommand);
      const body = await post("/api/github/authentication/commands", validated);
      return decodeResponse(body, decodeGithubAuthenticationSnapshot);
    },
    async readCatalogue(request) {
      const validated = decodeRequest(request, decodeGithubCatalogueReadRequest);
      const body = await post("/api/github/catalogue/reads", validated);
      return decodeResponse(body, decodeGithubCatalogueReadResponse);
    },
    async recordRecentRepository(command) {
      const validated = decodeRequest(command, decodeGithubRecentRepositoryCommand);
      const body = await post("/api/github/catalogue/recents", validated);
      return decodeResponse(body, decodeGithubCatalogueReadResponse);
    },
  };
}

function decodeRequest<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new GithubClientFailure("GitHub request is invalid.", 0);
  }
}

function decodeResponse<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new GithubClientFailure("GitHub returned an invalid response.", 0);
  }
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new GithubClientFailure("GitHub base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new GithubClientFailure("GitHub base URL must be loopback.", 0);
  }
}
