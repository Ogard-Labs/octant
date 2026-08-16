import {
  decodeThreadMentionCommandResult,
  type MentionableThreadId,
  type SideChatSidecar,
  type ThreadMentionCandidate,
  type ThreadMentionCommand,
  type ThreadMentionCommandResult,
  type ThreadMentionRequestId,
  type ResolvedThreadMention,
  type UnavailableThreadMention,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadMentionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ThreadMentionClient {
  /** `#` typeahead over threads the host says this principal can already Open. */
  search(
    requestId: ThreadMentionRequestId,
    query: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<ThreadMentionCandidate>>;
  /** Turns chips into bounded read-only context at send time. */
  resolve(
    requestId: ThreadMentionRequestId,
    threadIds: ReadonlyArray<MentionableThreadId>,
    signal?: AbortSignal,
  ): Promise<{
    readonly mentions: ReadonlyArray<ResolvedThreadMention>;
    readonly unavailable: ReadonlyArray<UnavailableThreadMention>;
  }>;
  /** Gets or creates the one Side Chat sidecar for a source thread. */
  openSideChat(
    requestId: ThreadMentionRequestId,
    sourceThreadId: MentionableThreadId,
    signal?: AbortSignal,
  ): Promise<{ readonly sidecar: SideChatSidecar; readonly created: boolean }>;
  execute(command: ThreadMentionCommand, signal?: AbortSignal): Promise<ThreadMentionCommandResult>;
}

export class ThreadMentionClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ThreadMentionClientFailure";
    this.status = status;
  }
}

/**
 * Client for the authoritative thread-mention and Side Chat surface.
 *
 * The host decides which threads are mentionable, how much transcript a
 * mention contributes, and which sidecar belongs to which source thread. This
 * client only carries the window capability and returns the server's typed
 * result, so a browser bug cannot promote an unresolved `#text` into a chip
 * or widen a mention's window.
 */
export function createThreadMentionClient(
  options: ThreadMentionClientOptions,
): ThreadMentionClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/thread-mentions/commands", options.baseUrl).toString();

  async function execute(
    command: ThreadMentionCommand,
    signal?: AbortSignal,
  ): Promise<ThreadMentionCommandResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(command),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new ThreadMentionClientFailure("Thread mentions are unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "Thread mentions are unavailable.";
      throw new ThreadMentionClientFailure(message, response.status);
    }
    return decodeThreadMentionCommandResult(body);
  }

  return {
    execute,
    async search(requestId, query, signal) {
      const result = await execute(
        { kind: "search-mentions", requestId, query },
        ...(signal === undefined ? [] : [signal]),
      );
      return result.kind === "mentions-searched" ? result.candidates : [];
    },
    async resolve(requestId, threadIds, signal) {
      if (threadIds.length === 0) return { mentions: [], unavailable: [] };
      const result = await execute(
        { kind: "resolve-mentions", requestId, threadIds: [...threadIds] },
        ...(signal === undefined ? [] : [signal]),
      );
      // A non-resolution is never treated as "resolved nothing quietly": every
      // requested id comes back marked unavailable so the composer can say so.
      return result.kind === "mentions-resolved"
        ? { mentions: result.mentions, unavailable: result.unavailable }
        : {
            mentions: [],
            unavailable: threadIds.map((threadId) => ({
              threadId,
              reason: "unauthorized" as const,
            })),
          };
    },
    async openSideChat(requestId, sourceThreadId, signal) {
      const result = await execute(
        { kind: "open-side-chat", requestId, sourceThreadId },
        ...(signal === undefined ? [] : [signal]),
      );
      if (result.kind !== "side-chat-opened") {
        throw new ThreadMentionClientFailure("Side Chat is unavailable for this thread.", 403);
      }
      return { sidecar: result.sidecar, created: result.created };
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ThreadMentionClientFailure("Thread mention base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new ThreadMentionClientFailure("Thread mention base URL must be loopback.", 0);
  }
}
