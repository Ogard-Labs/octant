import {
  decodeLocalServerCommandResult,
  type LocalServerCommand,
  type LocalServerCommandResult,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface LocalServerClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface LocalServerClient {
  execute(command: LocalServerCommand, signal?: AbortSignal): Promise<LocalServerCommandResult>;
}

export class LocalServerClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LocalServerClientFailure";
    this.status = status;
  }
}

/**
 * Client for the authoritative Local servers surface.
 *
 * The host classifies, probes, and decides Stop availability; this client only
 * carries the window capability and returns the server's typed result. A
 * denial — confirmation required, local-host required, unauthorized — arrives
 * as a `local-server-rejected` result rather than an HTTP error, because those
 * are ordinary answers the panel must show the user in words.
 */
export function createLocalServerClient(options: LocalServerClientOptions): LocalServerClient {
  validateBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async execute(command, signal) {
      const url = new URL("/api/code/local-servers/commands", options.baseUrl);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new LocalServerClientFailure("Local servers are unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new LocalServerClientFailure(
          messageFrom(body, "Local servers command failed."),
          response.status,
        );
      }
      return decodeLocalServerCommandResult(body);
    },
  };
}

function messageFrom(body: unknown, fallback: string): string {
  return typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
    ? body.message
    : fallback;
}

/**
 * The panel runs in the local window *and* in a paired remote client, so the
 * base URL is the loopback listener in one case and the host's authenticated
 * HTTPS origin in the other. Refusing everything but loopback made the panel
 * unusable from a paired device, which the design admits for list and open.
 *
 * The transport still has to protect the window capability this client sends on
 * every request: loopback may stay plain HTTP, and any other host must be
 * HTTPS. Admitting that transport widens nothing else — who may stop what is
 * decided by the host from the request's authenticated principal, never from
 * the URL this client was built with.
 */
function validateBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LocalServerClientFailure("Local servers base URL is invalid.", 0);
  }
  const host = url.hostname;
  const loopback =
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (
    loopback ? url.protocol !== "http:" && url.protocol !== "https:" : url.protocol !== "https:"
  ) {
    throw new LocalServerClientFailure(
      "Local servers base URL must be loopback or an HTTPS host.",
      0,
    );
  }
}
