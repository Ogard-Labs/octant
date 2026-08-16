import {
  decodeUsageDashboardResponse,
  type UsageDashboardRequest,
  type UsageDashboardResponse,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface UsageDashboardClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface UsageDashboardClient {
  load(request: UsageDashboardRequest, signal?: AbortSignal): Promise<UsageDashboardResponse>;
}

export class UsageDashboardClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UsageDashboardClientFailure";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Client for the host-authoritative usage dashboard.
 *
 * The host owns attribution, coverage, and every total; this client carries the
 * window capability and decodes the typed response. Decoding is deliberate: a
 * response that does not satisfy the contract is rejected rather than rendered,
 * so a partially written aggregate can never reach the dashboard as if it were
 * a measurement.
 */
export function createUsageDashboardClient(
  options: UsageDashboardClientOptions,
): UsageDashboardClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async load(request, signal) {
      const url = new URL("/api/usage/dashboard", options.baseUrl).toString();
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
      const abort =
        signal === undefined
          ? timeoutController.signal
          : anySignal(signal, timeoutController.signal);

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(request),
          signal: abort,
        });
      } catch {
        throw new UsageDashboardClientFailure("The usage dashboard service is unavailable.", 0);
      } finally {
        clearTimeout(timer);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new UsageDashboardClientFailure(
          failureMessage(body, response.status),
          response.status,
        );
      }
      try {
        return decodeUsageDashboardResponse(body);
      } catch {
        throw new UsageDashboardClientFailure(
          "The usage dashboard returned a response outside its contract.",
          response.status,
        );
      }
    },
  };
}

function failureMessage(body: unknown, status: number): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
  ) {
    return body.message;
  }
  return `Usage dashboard request failed with status ${status}.`;
}

/**
 * Combine the caller's cancellation with the client timeout. A caller that
 * aborts a superseded query must not wait for the host, and a host that never
 * answers must not hold the window's request open.
 */
function anySignal(caller: AbortSignal, timeout: AbortSignal): AbortSignal {
  if (caller.aborted) return caller;
  if (timeout.aborted) return timeout;
  const controller = new AbortController();
  const abort = (reason: unknown) => controller.abort(reason);
  caller.addEventListener("abort", () => abort(caller.reason), { once: true });
  timeout.addEventListener("abort", () => abort(timeout.reason), { once: true });
  return controller.signal;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new UsageDashboardClientFailure("Usage dashboard base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new UsageDashboardClientFailure("Usage dashboard base URL must be loopback.", 0);
  }
}
