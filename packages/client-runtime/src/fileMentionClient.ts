import {
  decodeFileMentionCommandResult,
  type FileMentionCandidate,
  type FileMentionCommand,
  type FileMentionCommandResult,
  type FileMentionRequestId,
  type FileMentionScope,
  type ResolvedFileMention,
  type UnavailableFileMention,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface FileMentionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface FileMentionClient {
  complete(
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    query: string,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<FileMentionCandidate>>;
  resolve(
    requestId: FileMentionRequestId,
    scope: FileMentionScope,
    paths: ReadonlyArray<string>,
    signal?: AbortSignal,
  ): Promise<{
    readonly mentions: ReadonlyArray<ResolvedFileMention>;
    readonly unavailable: ReadonlyArray<UnavailableFileMention>;
  }>;
  execute(command: FileMentionCommand, signal?: AbortSignal): Promise<FileMentionCommandResult>;
}

export class FileMentionClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FileMentionClientFailure";
    this.status = status;
  }
}

/**
 * Client for the authoritative `@file` mention surface.
 *
 * The host decides which paths sit inside the bound root and how much of a
 * file one mention contributes. This client only carries the window capability
 * and returns the server's typed result, so a browser bug cannot include
 * bytes from outside the root.
 */
export function createFileMentionClient(options: FileMentionClientOptions): FileMentionClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/file-mentions/commands", options.baseUrl).toString();

  async function execute(
    command: FileMentionCommand,
    signal?: AbortSignal,
  ): Promise<FileMentionCommandResult> {
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
      throw new FileMentionClientFailure("File mentions are unavailable.", 0);
    }
    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "message" in body &&
        typeof body.message === "string"
          ? body.message
          : "File mentions are unavailable.";
      throw new FileMentionClientFailure(message, response.status);
    }
    return decodeFileMentionCommandResult(body);
  }

  return {
    execute,
    async complete(requestId, scope, query, signal) {
      const result = await execute(
        { kind: "complete-file-mentions", requestId, scope, query },
        ...(signal === undefined ? [] : [signal]),
      );
      return result.kind === "file-mentions-completed" ? result.candidates : [];
    },
    async resolve(requestId, scope, paths, signal) {
      if (paths.length === 0) return { mentions: [], unavailable: [] };
      const result = await execute(
        { kind: "resolve-file-mentions", requestId, scope, paths: [...paths] },
        ...(signal === undefined ? [] : [signal]),
      );
      return result.kind === "file-mentions-resolved"
        ? { mentions: result.mentions, unavailable: result.unavailable }
        : {
            mentions: [],
            unavailable: paths.map((path) => ({ path, reason: "unauthorized" as const })),
          };
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new FileMentionClientFailure("File mention base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new FileMentionClientFailure("File mention base URL must be loopback.", 0);
  }
}
