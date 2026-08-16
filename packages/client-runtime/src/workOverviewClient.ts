import {
  decodeWorkOverviewProjection,
  decodeProjectId,
  type WorkOverviewProjection,
  type ProjectId,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkOverviewClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface WorkOverviewClient {
  load(projectId: ProjectId): Promise<WorkOverviewProjection>;
}

export class WorkOverviewClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkOverviewClientFailure";
    this.status = status;
  }
}

export function createWorkOverviewClient(options: WorkOverviewClientOptions): WorkOverviewClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  return {
    async load(projectId) {
      const url = new URL("/api/work/overview", options.baseUrl);
      url.searchParams.set("projectId", String(decodeProjectId(projectId)));
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
        });
      } catch {
        throw new WorkOverviewClientFailure("Work overview is unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Work overview request failed.";
        throw new WorkOverviewClientFailure(message, response.status);
      }
      return decodeWorkOverviewProjection(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkOverviewClientFailure("Work overview base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new WorkOverviewClientFailure("Work overview base URL must be loopback.", 0);
  }
}
