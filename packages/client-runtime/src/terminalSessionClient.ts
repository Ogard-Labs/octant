import {
  TerminalSessionHistoryResponse,
  TerminalSessionListResponse,
  decodeHostAnswer,
  type ImportedTerminalSession,
  type ProjectId,
  type TerminalSessionSummary,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface TerminalSessionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** The sessions in a Project's folder, and the history a thread started from. */
export interface TerminalSessionClient {
  list(projectId: ProjectId, signal?: AbortSignal): Promise<ReadonlyArray<TerminalSessionSummary>>;
  history(threadId: string, signal?: AbortSignal): Promise<ImportedTerminalSession | undefined>;
}

export class TerminalSessionClientFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TerminalSessionClientFailure";
  }
}

/** Loopback only: the sessions are files in the person's home folder on the host. */
export function createTerminalSessionClient(
  options: TerminalSessionClientOptions,
): TerminalSessionClient {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
    base.username !== "" ||
    base.password !== ""
  ) {
    throw new Error("Terminal sessions require a loopback HTTP destination.");
  }
  const fetch = bindFetchPort(options.fetch);
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(new URL(path, base), {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new TerminalSessionClientFailure(0, "Terminal sessions are unavailable.");
    }
    const answer: unknown = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new TerminalSessionClientFailure(response.status, failureMessage(answer));
    return answer;
  };
  return {
    async list(projectId, signal) {
      const answer = await post("/api/terminal-sessions/list", { projectId }, signal);
      return decodeHostAnswer(TerminalSessionListResponse)(answer).sessions;
    },
    async history(threadId, signal) {
      const answer = await post("/api/terminal-sessions/history", { threadId }, signal);
      return decodeHostAnswer(TerminalSessionHistoryResponse)(answer).imported;
    },
  };
}

function failureMessage(value: unknown): string {
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : "Terminal session request failed.";
}
