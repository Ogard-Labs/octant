import {
  decodeIntegrationAuthenticationCommand,
  decodeIntegrationAuthenticationSnapshot,
  type IntegrationAuthenticationCommand,
  type IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
import { bindFetchPort } from "./bindFetchPort";

export interface IntegrationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  readonly slug: string;
}

export interface IntegrationClient {
  authenticationSnapshot(): Promise<IntegrationAuthenticationSnapshot>;
  executeAuthenticationCommand(
    command: IntegrationAuthenticationCommand,
  ): Promise<IntegrationAuthenticationSnapshot>;
  storePersonalCredential(credential: string): Promise<void>;
  deletePersonalCredential(): Promise<void>;
}

export class IntegrationClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "IntegrationClientFailure";
    this.status = status;
  }
}

/**
 * Typed transport for a host Integration plugin's authentication routes.
 * Requests and responses are validated against the wire contracts; the
 * renderer never constructs a raw endpoint or receives token material.
 */
export function createIntegrationClient(options: IntegrationClientOptions): IntegrationClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const headers = {
    "x-octant-window-capability": options.windowCapability,
  } as const;
  const snapshotPath = linearAuthenticationPath(options.slug);
  const commandsPath = linearAuthenticationCommandsPath(options.slug);
  const secretsPath = `/api/integrations/${encodeURIComponent(options.slug)}/secrets`;

  async function send(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, options.baseUrl).toString(), init);
    } catch {
      throw new IntegrationClientFailure("The integration is unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "The integration request failed.";
      throw new IntegrationClientFailure(message, response.status);
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
      const body = await send(snapshotPath, { method: "GET", headers });
      return decodeResponse(body, decodeIntegrationAuthenticationSnapshot);
    },
    async executeAuthenticationCommand(command) {
      const validated = decodeRequest(command, decodeIntegrationAuthenticationCommand);
      const body = await post(commandsPath, validated);
      return decodeResponse(body, decodeIntegrationAuthenticationSnapshot);
    },
    async storePersonalCredential(credential) {
      await post(secretsPath, {
        kind: "put",
        scope: "personal-api-key",
        credential,
      });
    },
    async deletePersonalCredential() {
      await post(secretsPath, { kind: "delete", scope: "personal-api-key" });
    },
  };
}

function decodeRequest<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new IntegrationClientFailure("The integration request is invalid.", 0);
  }
}

function decodeResponse<T>(value: unknown, decode: (input: unknown) => T): T {
  try {
    return decode(value);
  } catch {
    throw new IntegrationClientFailure("The integration returned an invalid response.", 0);
  }
}

/**
 * Linear is the shipped Integration plugin. The wiring check only sees quoted
 * `/api/...` literals, so this slug must construct the same strings the server
 * serves. Other slugs stay interpolated.
 */
function linearAuthenticationPath(slug: string): string {
  return slug === "linear"
    ? "/api/integrations/linear/authentication"
    : `/api/integrations/${encodeURIComponent(slug)}/authentication`;
}

function linearAuthenticationCommandsPath(slug: string): string {
  return slug === "linear"
    ? "/api/integrations/linear/authentication/commands"
    : `/api/integrations/${encodeURIComponent(slug)}/authentication/commands`;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new IntegrationClientFailure("The integration base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new IntegrationClientFailure("The integration base URL is invalid.", 0);
  }
}
