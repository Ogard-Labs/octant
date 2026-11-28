import {
  decodeHostUpdateStatusAnswer,
  type HostUpdateRequest,
  type HostUpdateStatus,
} from "@octant/contracts/host-update";
import { bindFetchPort } from "./bindFetchPort";

/**
 * Dedicated client for `/api/host-control/update`. Kept on its own subpath
 * (`@octant/client-runtime/host-update-client`) so Settings fleet-update code
 * and host-update schemas stay out of the initial renderer chunk.
 */

export interface HostUpdateClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface HostUpdateClient {
  update(request: HostUpdateRequest): Promise<HostUpdateStatus>;
}

export class HostUpdateClientError extends Error {
  override readonly name = "HostUpdateClientError";
  readonly statusCode?: number;
  constructor(message: string, statusCode?: number) {
    super(message);
    if (statusCode !== undefined) this.statusCode = statusCode;
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

export function createHostUpdateClient(options: HostUpdateClientOptions): HostUpdateClient {
  const resolvedFetch = bindFetchPort(options.fetch);

  return {
    async update(request) {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await resolvedFetch(
          new URL("/api/host-control/update", options.baseUrl).toString(),
          {
            method: "POST",
            headers: {
              "x-octant-window-capability": options.windowCapability,
              "content-type": "application/json",
            },
            body: JSON.stringify(request),
            signal: controller.signal,
          },
        );
      } catch {
        throw new HostUpdateClientError("The host control service is unreachable.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new HostUpdateClientError(
          `Host update request failed with status ${response.status}.`,
          response.status,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new HostUpdateClientError("Host control returned an invalid response.");
      }

      try {
        return decodeHostUpdateStatusAnswer(body);
      } catch {
        throw new HostUpdateClientError("Host control returned an invalid response.");
      }
    },
  };
}
