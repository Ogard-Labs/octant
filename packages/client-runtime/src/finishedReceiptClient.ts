import {
  ThreadFinishedReceiptsResponse,
  decodeHostAnswer,
  type ThreadFinishedReceipt,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface FinishedReceiptClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface FinishedReceiptClient {
  receipts(threadId: string, signal?: AbortSignal): Promise<ReadonlyArray<ThreadFinishedReceipt>>;
}

export class FinishedReceiptClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FinishedReceiptClientFailure";
    this.status = status;
  }
}

const PATH = "/api/finished-receipts";

/** Reads a thread's host-built finished receipts. Transport and authorization errors throw. */
export function createFinishedReceiptClient(
  options: FinishedReceiptClientOptions,
): FinishedReceiptClient {
  const fetchImpl = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };

  return {
    async receipts(threadId, signal) {
      const url = new URL(`${PATH}/${encodeURIComponent(threadId)}`, options.baseUrl).toString();
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "GET",
          headers,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new FinishedReceiptClientFailure("Finished receipts are unavailable right now.", 0);
      }
      if (!response.ok) {
        let message = "Finished receipts could not be loaded.";
        try {
          const errorBody = (await response.json()) as { readonly error?: unknown };
          if (typeof errorBody.error === "string" && errorBody.error.trim().length > 0) {
            message = errorBody.error;
          }
        } catch {
          // Keep default message when response body is not JSON.
        }
        throw new FinishedReceiptClientFailure(message, response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new FinishedReceiptClientFailure("Finished receipts response was invalid.", 502);
      }
      return decodeHostAnswer(ThreadFinishedReceiptsResponse)(payload).receipts;
    },
  };
}
