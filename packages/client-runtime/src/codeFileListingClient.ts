import {
  decodeCodeFileChangeNotice,
  decodeCodeFileListingResult,
  decodeCodeSearchResult,
  type CodeCheckoutId,
  type CodeFileChangeNotice,
  type CodeFileListingResult,
  type CodeSearchResult,
  type CodeSearchScope,
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

export interface CodeSearchRequestQuery {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly scope: CodeSearchScope;
  readonly query: string;
}

export interface CodeFileWatchQuery {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

export interface CodeFileListingClient {
  list(query: CodeFileListingQuery, signal?: AbortSignal): Promise<CodeFileListingResult>;
  /**
   * Notices that files under the checkout changed, for as long as the caller
   * keeps the signal open. The stream ends rather than erroring when the host
   * cannot watch, so a caller treats its end as "no longer live" and may open
   * another one; it never means the checkout is empty.
   */
  watch(query: CodeFileWatchQuery, signal: AbortSignal): AsyncGenerator<CodeFileChangeNotice>;
  /** Bounded search of the checkout by path or by content. */
  search(query: CodeSearchRequestQuery, signal?: AbortSignal): Promise<CodeSearchResult>;
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

    async search(query, signal) {
      const url = new URL("/api/code/files/search", options.baseUrl);
      url.searchParams.set("threadId", String(query.threadId));
      url.searchParams.set("checkoutId", String(query.checkoutId));
      url.searchParams.set("scope", query.scope);
      url.searchParams.set("query", query.query);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        });
      } catch {
        throw new CodeFileListingClientFailure("Code search is unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new CodeFileListingClientFailure(
          messageFrom(body, "Code search is unavailable."),
          response.status,
        );
      }
      return decodeCodeSearchResult(body);
    },

    watch(query, signal) {
      const url = new URL("/api/code/files/watch", options.baseUrl);
      url.searchParams.set("threadId", String(query.threadId));
      url.searchParams.set("checkoutId", String(query.checkoutId));
      return readNoticeStream(
        fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          signal,
        }),
        signal,
      );
    },
  };
}

/**
 * Read one NDJSON notice per line until the host or the caller stops.
 *
 * A malformed line ends the stream instead of being skipped: the notice is the
 * only signal that the surface is stale, so a body this client cannot parse is
 * a reason to stop trusting the connection, not to keep reading it.
 */
async function* readNoticeStream(
  responsePromise: Promise<Response>,
  signal: AbortSignal,
): AsyncGenerator<CodeFileChangeNotice> {
  let response: Response;
  try {
    response = await responsePromise;
  } catch {
    return;
  }
  if (!response.ok || response.body === null) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal.aborted) return;
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          let notice: CodeFileChangeNotice;
          try {
            notice = decodeCodeFileChangeNotice(JSON.parse(line));
          } catch {
            return;
          }
          yield notice;
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } catch {
    // A dropped connection is an ordinary end of a live stream.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation races while tearing down the stream.
    }
  }
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
