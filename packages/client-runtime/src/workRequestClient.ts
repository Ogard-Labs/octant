import {
  decodeWorkRequestCommand,
  decodeWorkRequestCommandResult,
  decodeWorkRequestFailure,
  decodeWorkRequestList,
  decodeProjectId,
  type WorkRequestCommand,
  type WorkRequestCommandResult,
  type WorkRequestFailure,
  type WorkRequestList,
  type WorkThreadId,
  type ProjectId,
} from "@octant/contracts";

export interface WorkRequestClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkRequestClient {
  list(projectId: ProjectId, threadId?: WorkThreadId): Promise<WorkRequestList>;
  execute(command: WorkRequestCommand): Promise<WorkRequestCommandResult>;
}

export class WorkRequestClientFailure extends Error {
  readonly code: WorkRequestFailure["code"];

  constructor(failure: WorkRequestFailure) {
    super(failure.message);
    this.name = "WorkRequestClientFailure";
    this.code = failure.code;
  }
}

export function createWorkRequestClient(options: WorkRequestClientOptions): WorkRequestClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    list(projectId, threadId) {
      const url = new URL("/api/work/requests", options.baseUrl);
      url.searchParams.set("projectId", String(projectId));
      if (threadId !== undefined) {
        url.searchParams.set("threadId", String(threadId));
      }
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeWorkRequestList,
      );
    },
    async execute(command) {
      let validated: WorkRequestCommand;
      try {
        validated = decodeWorkRequestCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        options.fetch,
        new URL("/api/work/requests/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeWorkRequestCommandResult,
      );
    },
  };
}

async function request<T>(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw unavailable("Octant Work request service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new WorkRequestClientFailure(decodeWorkRequestFailure(body));
    } catch (error) {
      if (error instanceof WorkRequestClientFailure) throw error;
      throw malformedResponse();
    }
  }
  try {
    return decode(body);
  } catch {
    throw malformedResponse();
  }
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("invalid base url");
    }
  } catch {
    throw unavailable("Work request client requires a loopback server URL.");
  }
}

function unavailable(message: string): WorkRequestClientFailure {
  return new WorkRequestClientFailure({ code: "unavailable", message });
}

function invalidCommand(): WorkRequestClientFailure {
  return new WorkRequestClientFailure({
    code: "invalid",
    message: "Work request command is invalid.",
  });
}

function malformedResponse(): WorkRequestClientFailure {
  return new WorkRequestClientFailure({
    code: "unavailable",
    message: "Work request service returned an invalid response.",
  });
}

export { decodeProjectId };
