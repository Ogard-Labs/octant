import {
  decodeCodeFileListingResult,
  type CodeCheckoutId,
  type CodeFileListingResult,
  type CodeRelativePath,
  type CodeThreadId,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface CodeFileListingClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface CodeFileListingQuery {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  /** Subdirectory relative to the checkout root. Absent lists the root. */
  readonly directory?: CodeRelativePath | undefined;
}

export interface CodeFileListingClient {
  list(query: CodeFileListingQuery, signal?: AbortSignal): Promise<CodeFileListingResult>;
}

export class CodeFileListingClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CodeFileListingClientFailure";
    this.status = status;
  }
}

/**
 * Client for the confined Code file listing surface.
 *
 * The host owns confinement and availability; this client only carries the
 * window capability and decodes the server's typed result, so a listing that
 * the host marked truncated or read-only keeps that meaning instead of
 * arriving as an untyped body the renderer would have to re-interpret.
 */
export function createCodeFileListingClient(
  options: CodeFileListingClientOptions,
): CodeFileListingClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async list(query, signal) {
      const url = new URL("/api/code/files/listing", options.baseUrl);
      url.searchParams.set("threadId", String(query.threadId));
      url.searchParams.set("checkoutId", String(query.checkoutId));
      if (query.directory !== undefined) {
        url.searchParams.set("directory", String(query.directory));
      }
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new CodeFileListingClientFailure("Code file listing is unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new CodeFileListingClientFailure(
          messageFrom(body, "Code file listing is unavailable."),
          response.status,
        );
      }
      return decodeCodeFileListingResult(body);
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

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CodeFileListingClientFailure("Code file listing base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new CodeFileListingClientFailure("Code file listing base URL must be loopback.", 0);
  }
}
