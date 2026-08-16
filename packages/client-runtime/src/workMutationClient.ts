import {
  decodeWorkMutationReply,
  decodeWorkMutationRequest,
  type WorkMutationReply,
  type WorkMutationRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkMutationClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkMutationClient {
  mutate(request: WorkMutationRequest): Promise<WorkMutationReply>;
}

export class WorkMutationClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkMutationClientFailure";
    this.status = status;
  }
}

export function createWorkMutationClient(options: WorkMutationClientOptions): WorkMutationClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    async mutate(request) {
      let validated: WorkMutationRequest;
      try {
        validated = decodeWorkMutationRequest(request);
      } catch {
        throw new WorkMutationClientFailure("Work mutation request is invalid.", 0);
      }

      let response: Response;
      try {
        response = await fetch(new URL("/api/work/mutations", options.baseUrl).toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(validated),
        });
      } catch {
        throw new WorkMutationClientFailure("Work mutation service is unavailable.", 0);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Work mutation request failed.";
        throw new WorkMutationClientFailure(message, response.status);
      }

      try {
        return decodeWorkMutationReply(body);
      } catch {
        throw new WorkMutationClientFailure(
          "Work mutation service returned an invalid response.",
          0,
        );
      }
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkMutationClientFailure("Work mutation base URL is invalid.", 0);
  }
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
    throw new WorkMutationClientFailure("Work mutation base URL must be loopback.", 0);
  }
}
