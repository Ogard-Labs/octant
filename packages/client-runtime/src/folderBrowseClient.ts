import {
  decodeFolderBrowseResult,
  decodeFolderSelectionResult,
  decodeFolderBrowseFailure,
  type FolderBrowseFailure,
  type FolderBrowseRequest,
  type FolderBrowseResult,
  type FolderSelectionRequest,
  type FolderSelectionResult,
} from "@octant/contracts/folder-browse";
import { bindFetchPort } from "./bindFetchPort";

export interface FolderBrowseClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  /** Aborts a request that produces no response in time; defaults to 20 000 ms. */
  readonly requestTimeoutMs?: number;
}

// A browse that stalls has no server-side completion to wait for; aborting it
// turns the dialog's "Loading…" into an error the person can retry.
const REQUEST_TIMEOUT_MS = 20_000;

export interface FolderBrowseClient {
  browse(request: FolderBrowseRequest): Promise<FolderBrowseResult>;
  select(request: FolderSelectionRequest): Promise<FolderSelectionResult>;
}

export class FolderBrowseClientFailure extends Error {
  readonly category: FolderBrowseFailure["category"];
  constructor(failure: FolderBrowseFailure) {
    super(failure.message);
    this.name = "FolderBrowseClientFailure";
    this.category = failure.category;
  }
}

export function createFolderBrowseClient(options: FolderBrowseClientOptions): FolderBrowseClient {
  const fetch = bindFetchPort(options.fetch);
  const headers = { "x-octant-window-capability": options.windowCapability };
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  return {
    browse(request) {
      return post(
        fetch,
        new URL("/api/folders/browse", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        decodeFolderBrowseResult,
        requestTimeoutMs,
      );
    },
    select(request) {
      return post(
        fetch,
        new URL("/api/folders/select", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
        decodeFolderSelectionResult,
        requestTimeoutMs,
      );
    },
  };
}

async function post<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  // The budget covers the body as well as the headers: a server that sends its
  // status and then stalls mid-body would otherwise leave the dialog loading.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch {
      throw new FolderBrowseClientFailure({
        category: "unavailable",
        message: "Folder browse service is unavailable.",
      });
    }
    let body: unknown;
    try {
      body = await untilAborted(response.json(), controller.signal);
    } catch {
      throw new FolderBrowseClientFailure({
        category: "unavailable",
        message: "Folder browse returned an invalid response.",
      });
    }
    if (!response.ok) {
      try {
        throw new FolderBrowseClientFailure(decodeFolderBrowseFailure(body));
      } catch (error) {
        if (error instanceof FolderBrowseClientFailure) throw error;
        throw new FolderBrowseClientFailure({
          category: "unavailable",
          message: "Folder browse returned an invalid response.",
        });
      }
    }
    try {
      return decode(body);
    } catch {
      throw new FolderBrowseClientFailure({
        category: "unavailable",
        message: "Folder browse returned an invalid response.",
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Settles with the body read, or rejects once the request budget aborts. An
 * injected fetch port need not tie its response body to the abort signal, so
 * the budget is enforced here rather than trusted to the transport.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const refuse = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal.aborted) {
      refuse();
      return;
    }
    signal.addEventListener("abort", refuse, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", refuse);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", refuse);
        reject(error);
      },
    );
  });
}
