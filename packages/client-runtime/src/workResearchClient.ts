import {
  decodeWorkResearchCommandResult,
  decodeProjectId,
  type WorkResearchBrief,
  type WorkResearchClaim,
  type WorkResearchCommand,
  type WorkResearchCommandResult,
  type WorkResearchEvidence,
  type WorkResearchReport,
  type WorkSourceRecord,
  type ProjectId,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface WorkResearchClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** One projected brief with its recorded provenance, as served by the host. */
export interface WorkResearchBriefView {
  readonly briefId: string;
  readonly brief: WorkResearchBrief;
  readonly sources: ReadonlyArray<WorkSourceRecord>;
  readonly revokedSourceIds: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<WorkResearchEvidence>;
  readonly claims: ReadonlyArray<WorkResearchClaim>;
  readonly report?: WorkResearchReport;
}

export interface WorkResearchClient {
  listBriefs(
    projectId: ProjectId,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<WorkResearchBriefView>>;
  execute(command: WorkResearchCommand, signal?: AbortSignal): Promise<WorkResearchCommandResult>;
}

export class WorkResearchClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkResearchClientFailure";
    this.status = status;
  }
}

/**
 * Client for the authoritative Work research surface.
 *
 * The host owns provenance, source policy, and citation authority; this client
 * only carries the window capability and returns the server's typed result.
 * Command results are decoded so a denial keeps its typed shape rather than
 * arriving as an untyped body.
 */
export function createWorkResearchClient(options: WorkResearchClientOptions): WorkResearchClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async listBriefs(projectId, signal) {
      const url = new URL("/api/work/research/briefs", options.baseUrl);
      url.searchParams.set("projectId", String(decodeProjectId(projectId)));
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "Work research briefs are unavailable.",
      );
      const briefs = (body as { briefs?: unknown }).briefs;
      return Array.isArray(briefs) ? (briefs as ReadonlyArray<WorkResearchBriefView>) : [];
    },

    async execute(command, signal) {
      const url = new URL("/api/work/research/commands", options.baseUrl);
      const body = await send(
        fetch,
        url.toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "Work research command failed.",
      );
      return decodeWorkResearchCommandResult(body);
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  unavailableMessage: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new WorkResearchClientFailure(unavailableMessage, 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : unavailableMessage;
    throw new WorkResearchClientFailure(message, response.status);
  }
  return body;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new WorkResearchClientFailure("Work research base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new WorkResearchClientFailure("Work research base URL must be loopback.", 0);
  }
}
