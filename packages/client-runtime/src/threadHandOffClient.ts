import {
  decodeThreadHandOffOutcome,
  type ThreadHandOffOutcome,
  type ThreadHandOffRequest,
} from "@octant/contracts/thread-hand-off";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadHandOffClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadHandOffClient {
  handOffThread(request: ThreadHandOffRequest): Promise<ThreadHandOffOutcome>;
}

export class ThreadHandOffClientError extends Error {
  override readonly name = "ThreadHandOffClientError";
  constructor(message: string) {
    super(message);
  }
}

/** The provider writes the whole document before the host answers; give it the room a turn gets. */
const HAND_OFF_TIMEOUT_MS = 200_000;

export function createThreadHandOffClient(
  options: ThreadHandOffClientOptions,
): ThreadHandOffClient {
  const resolvedFetch = bindFetchPort(options.fetch);
  return {
    async handOffThread(request) {
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HAND_OFF_TIMEOUT_MS);
      try {
        response = await resolvedFetch(
          new URL("/api/threads/hand-off", options.baseUrl).toString(),
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
        throw new ThreadHandOffClientError("Thread hand-off is unavailable.");
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok && response.status !== 404 && response.status !== 401) {
        throw new ThreadHandOffClientError(
          `Thread hand-off failed with status ${response.status}.`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ThreadHandOffClientError("Thread hand-off returned an invalid response.");
      }

      try {
        return decodeThreadHandOffOutcome(body);
      } catch {
        throw new ThreadHandOffClientError("Thread hand-off returned an invalid response.");
      }
    },
  };
}
