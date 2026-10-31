import { type SecretStoresCommand, SecretStoresResult } from "@octant/contracts/secret-stores";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface SecretStoresClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface SecretStoresClient {
  /** Which secret stores this host can link, and whether each is linked. */
  read(signal?: AbortSignal): Promise<SecretStoresResult>;
  /** Link or unlink a store, check an item reference, or point a provider's key at an item. */
  execute(command: SecretStoresCommand): Promise<SecretStoresResult>;
}

export class SecretStoresClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SecretStoresClientFailure";
    this.status = status;
  }
}

/**
 * Client for Settings › Secret stores on this host.
 *
 * Linking a store and pointing a key at it are host authority, so the client
 * refuses any base URL that is not loopback: a remote client never gets one.
 * A command carries a store name and an item reference, which names an item;
 * no command and no answer carries what the item holds.
 */
export function createSecretStoresClient(options: SecretStoresClientOptions): SecretStoresClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const settingsUrl = new URL("/api/secret-stores/settings", options.baseUrl).toString();
  const commandsUrl = new URL("/api/secret-stores/commands", options.baseUrl).toString();

  async function send(url: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init.method === "POST" ? { "content-type": "application/json" } : {}),
          "x-octant-window-capability": options.windowCapability,
        },
      });
    } catch {
      throw new SecretStoresClientFailure("Secret stores are unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "Secret stores are unavailable.";
      throw new SecretStoresClientFailure(message, response.status);
    }
    return body;
  }

  return {
    async read(signal) {
      const body = await send(settingsUrl, {
        method: "GET",
        ...(signal === undefined ? {} : { signal }),
      });
      return decodeHostAnswer(SecretStoresResult)(body);
    },
    async execute(command) {
      const body = await send(commandsUrl, { method: "POST", body: JSON.stringify(command) });
      return decodeHostAnswer(SecretStoresResult)(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new SecretStoresClientFailure("Secret stores base URL is invalid.", 0);
  }
  if (
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "[::1]")
  ) {
    throw new SecretStoresClientFailure("Secret stores require a loopback host.", 0);
  }
}
