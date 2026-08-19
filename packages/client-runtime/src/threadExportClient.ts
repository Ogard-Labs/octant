import {
  decodeThreadExportOutcome,
  type ThreadExportOutcome,
  type ThreadExportRequest,
} from "@octant/contracts/thread-export";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadExportClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadExportClient {
  exportThread(request: ThreadExportRequest): Promise<ThreadExportOutcome>;
}

export class ThreadExportClientError extends Error {
  override readonly name = "ThreadExportClientError";
  constructor(message: string) {
    super(message);
  }
}

const EXPORT_TIMEOUT_MS = 30_000;

export function createThreadExportClient(options: ThreadExportClientOptions): ThreadExportClient {
  const resolvedFetch = bindFetchPort(options.fetch);
  return {
    async exportThread(request) {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
      try {
        response = await resolvedFetch(new URL("/api/threads/export", options.baseUrl).toString(), {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch {
        throw new ThreadExportClientError("Thread export is unavailable.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok && response.status !== 404 && response.status !== 401) {
        throw new ThreadExportClientError(`Thread export failed with status ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ThreadExportClientError("Thread export returned an invalid response.");
      }

      try {
        return decodeThreadExportOutcome(body);
      } catch {
        throw new ThreadExportClientError("Thread export returned an invalid response.");
      }
    },
  };
}
