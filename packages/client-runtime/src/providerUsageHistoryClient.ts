import {
  decodeLocalUsageHistoryRequest,
  decodeLocalUsageHistoryResponse,
  type LocalUsageHistoryRequest,
  type LocalUsageHistoryResponse,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface LocalUsageHistoryClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface LocalUsageHistoryClient {
  load(request: LocalUsageHistoryRequest, signal?: AbortSignal): Promise<LocalUsageHistoryResponse>;
}

export class LocalUsageHistoryClientFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalUsageHistoryClientFailure";
  }
}

export function createLocalUsageHistoryClient(
  options: LocalUsageHistoryClientOptions,
): LocalUsageHistoryClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username !== "" ||
    base.password !== ""
  ) {
    throw new Error("Local provider history requires a loopback HTTP destination.");
  }
  const fetch = bindFetchPort(options.fetch);
  return {
    async load(request, signal) {
      const validated = decodeLocalUsageHistoryRequest(request);
      const controller = new AbortController();
      const abort = () => controller.abort();
      const timer = setTimeout(abort, 30_000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const response = await fetch(new URL("/api/usage/local-history", base), {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(validated),
          signal: controller.signal,
        });
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new LocalUsageHistoryClientFailure(response.status, failureMessage(body));
        try {
          const decoded = decodeLocalUsageHistoryResponse(body);
          if (
            String(decoded.from) !== String(validated.from) ||
            String(decoded.to) !== String(validated.to) ||
            decoded.timeZone !== validated.timeZone
          )
            throw new Error("range-mismatch");
          return decoded;
        } catch {
          throw new LocalUsageHistoryClientFailure(
            response.status,
            "Local provider usage history response is invalid or stale.",
          );
        }
      } catch (error) {
        if (error instanceof LocalUsageHistoryClientFailure) throw error;
        throw new LocalUsageHistoryClientFailure(0, "Local provider usage history is unavailable.");
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

function failureMessage(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : "Local provider usage history request failed.";
}
