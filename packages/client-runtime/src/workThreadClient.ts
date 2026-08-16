import {
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommand,
  decodeWorkThreadCommandResult,
  type WorkThreadBootstrap,
  type WorkThreadCommand,
  type WorkThreadCommandResult,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkThreadClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkThreadClient {
  bootstrap(): Promise<WorkThreadBootstrap>;
  execute(command: WorkThreadCommand): Promise<WorkThreadCommandResult>;
}

export class WorkThreadClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkThreadClientFailure";
    this.status = status;
  }
}

export function createWorkThreadClient(options: WorkThreadClientOptions): WorkThreadClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    async bootstrap() {
      let response: Response;
      try {
        response = await fetch(new URL("/api/work/threads/bootstrap", options.baseUrl).toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
        });
      } catch {
        throw new WorkThreadClientFailure("Work thread service is unavailable.", 0);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new WorkThreadClientFailure(
          responseMessage(body, "Work thread bootstrap failed."),
          response.status,
        );
      }

      try {
        return decodeWorkThreadBootstrap(body);
      } catch {
        throw new WorkThreadClientFailure(
          "Work thread service returned an invalid bootstrap response.",
          0,
        );
      }
    },

    async execute(command) {
      let validated: WorkThreadCommand;
      try {
        validated = decodeWorkThreadCommand(command);
      } catch {
        throw new WorkThreadClientFailure("Work thread command is invalid.", 0);
      }

      let response: Response;
      try {
        response = await fetch(new URL("/api/work/threads/commands", options.baseUrl).toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(validated),
        });
      } catch {
        throw new WorkThreadClientFailure("Work thread service is unavailable.", 0);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new WorkThreadClientFailure(
          responseMessage(body, "Work thread command failed."),
          response.status,
        );
      }

      try {
        return decodeWorkThreadCommandResult(body);
      } catch {
        throw new WorkThreadClientFailure(
          "Work thread service returned an invalid command response.",
          0,
        );
      }
    },
  };
}

function responseMessage(body: unknown, fallback: string): string {
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
    throw new WorkThreadClientFailure("Work thread base URL is invalid.", 0);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new WorkThreadClientFailure("Work thread base URL must be loopback.", 0);
  }
}
