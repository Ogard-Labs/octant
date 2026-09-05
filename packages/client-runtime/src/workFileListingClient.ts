import {
  decodeWorkFileListingResult,
  type ProjectId,
  type WorkFileListingResult,
  type WorkThreadId,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkFileListingClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkFileListingQuery {
  readonly threadId: WorkThreadId;
  readonly projectId: ProjectId;
  /** Subdirectory relative to the bound folder. Absent lists the folder itself. */
  readonly directory?: string | undefined;
}

export interface WorkFileListingClient {
  list(query: WorkFileListingQuery, signal?: AbortSignal): Promise<WorkFileListingResult>;
}

export class WorkFileListingClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkFileListingClientFailure";
    this.status = status;
  }
}

/**
 * Client for the confined Work folder listing.
 *
 * The host owns confinement, ordering, and truncation; this client only
 * carries the window capability and decodes the typed result, so a listing the
 * host marked truncated or attributed to Work keeps that meaning rather than
 * arriving as a body the renderer would have to re-interpret.
 */
export function createWorkFileListingClient(
  options: WorkFileListingClientOptions,
): WorkFileListingClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async list(query, signal) {
      const url = new URL("/api/work/files/listing", options.baseUrl);
      url.searchParams.set("threadId", String(query.threadId));
      url.searchParams.set("projectId", String(query.projectId));
      if (query.directory !== undefined) url.searchParams.set("directory", query.directory);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new WorkFileListingClientFailure("Work files are unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new WorkFileListingClientFailure(
          messageFrom(body, "Work files are unavailable."),
          response.status,
        );
      }
      return decodeWorkFileListingResult(body);
    },
  };
}

function messageFrom(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  if ("failure" in body && typeof body.failure === "object" && body.failure !== null) {
    const failure: object = body.failure;
    if ("message" in failure && typeof failure.message === "string") return failure.message;
  }
  return "message" in body && typeof body.message === "string" ? body.message : fallback;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkFileListingClientFailure("Work file listing base URL is invalid.", 0);
  }
  // `URL.hostname` keeps the brackets on an IPv6 literal, so the bare form
  // never matches and `http://[::1]:5173` was refused as non-loopback.
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new WorkFileListingClientFailure("Work file listing base URL must be loopback.", 0);
  }
}
