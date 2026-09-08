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
  const fetch = bindFetchPort(options.fetch);
  return {
    async load(request, signal) {
      const validated = decodeLocalUsageHistoryRequest(request);
      let response: Response;
      try {
        response = await fetch(new URL("/api/usage/local-history", options.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(validated),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new LocalUsageHistoryClientFailure(0, "Local provider usage history is unavailable.");
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new LocalUsageHistoryClientFailure(response.status, failureMessage(body));
      try {
        const decoded = decodeLocalUsageHistoryResponse(body);
        if (
          String(decoded.from) !== String(validated.from) ||
          String(decoded.to) !== String(validated.to) ||
          decoded.timeZone !== validated.timeZone
        ) {
          throw new Error("range-mismatch");
        }
        return decoded;
      } catch {
        throw new LocalUsageHistoryClientFailure(
          response.status,
          "Local provider usage history response is invalid or stale.",
        );
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
