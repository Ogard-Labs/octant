import {
  decodeWorkPromotionCommand,
  decodeWorkPromotionCommandResult,
  decodeWorkPromotionFailure,
  decodeWorkPromotionList,
  decodeProjectId,
  type WorkPromotionCommand,
  type WorkPromotionCommandResult,
  type WorkPromotionFailure,
  type WorkPromotionList,
  type ProjectId,
} from "@octant/contracts";

export interface WorkPromotionClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkPromotionClient {
  list(originProjectId?: ProjectId): Promise<WorkPromotionList>;
  execute(command: WorkPromotionCommand): Promise<WorkPromotionCommandResult>;
}

export class WorkPromotionClientFailure extends Error {
  readonly code: WorkPromotionFailure["code"];

  constructor(failure: WorkPromotionFailure) {
    super(failure.message);
    this.name = "WorkPromotionClientFailure";
    this.code = failure.code;
  }
}

export function createWorkPromotionClient(
  options: WorkPromotionClientOptions,
): WorkPromotionClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    list(originProjectId) {
      const url = new URL("/api/work/promotions", options.baseUrl);
      if (originProjectId !== undefined) {
        url.searchParams.set("originProjectId", String(originProjectId));
      }
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeWorkPromotionList,
      );
    },
    async execute(command) {
      let validated: WorkPromotionCommand;
      try {
        validated = decodeWorkPromotionCommand(command);
      } catch {
        throw invalidCommand();
      }
      return request(
        options.fetch,
        new URL("/api/work/promotions/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(validated),
        },
        decodeWorkPromotionCommandResult,
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
    throw unavailable("Octant Work promotion service is unavailable.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedResponse();
  }
  if (!response.ok) {
    try {
      throw new WorkPromotionClientFailure(decodeWorkPromotionFailure(body));
    } catch (error) {
      if (error instanceof WorkPromotionClientFailure) throw error;
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
    throw unavailable("Work promotion client requires a loopback server URL.");
  }
}

function unavailable(message: string): WorkPromotionClientFailure {
  return new WorkPromotionClientFailure({ code: "unavailable", message });
}

function invalidCommand(): WorkPromotionClientFailure {
  return new WorkPromotionClientFailure({
    code: "invalid",
    message: "Work promotion command is invalid.",
  });
}

function malformedResponse(): WorkPromotionClientFailure {
  return new WorkPromotionClientFailure({
    code: "unavailable",
    message: "Work promotion service returned an invalid response.",
  });
}

export { decodeProjectId };
