import { decodeHostAnswer } from "@octant/contracts";
import {
  type ServerProjectsCommand,
  ServerProjectsCommandResult,
  ServerProjectsView,
} from "@octant/contracts/server-projects";
import { bindFetchPort } from "./bindFetchPort";

/**
 * The Code Projects bound to a folder on one of the person's registered
 * servers. A refused change is a value the caller shows; only a transport
 * failure throws.
 */

export interface ServerProjectsClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ServerProjectsClient {
  read(signal?: AbortSignal): Promise<ServerProjectsView>;
  command(
    command: ServerProjectsCommand,
    signal?: AbortSignal,
  ): Promise<ServerProjectsCommandResult>;
}

export class ServerProjectsClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ServerProjectsClientFailure";
    this.status = status;
  }
}

const PATH = "/api/server-projects";

export function createServerProjectsClient(
  options: ServerProjectsClientOptions,
): ServerProjectsClient {
  const fetch = bindFetchPort(options.fetch);
  const target = new URL(PATH, options.baseUrl).toString();
  const send = async (init: RequestInit): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetch(target, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": options.windowCapability,
        },
      });
    } catch {
      throw new ServerProjectsClientFailure("Server Projects are unavailable.", 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ServerProjectsClientFailure(
        "The server Projects answer is malformed.",
        response.status,
      );
    }
    const refusal =
      typeof body === "object" &&
      body !== null &&
      (body as { kind?: unknown }).kind === "server-projects-refused";
    if (!response.ok && !refusal) {
      const message =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : "The server Projects request failed.";
      throw new ServerProjectsClientFailure(message, response.status);
    }
    return body;
  };
  return {
    async read(signal) {
      const body = await send({ method: "GET", ...(signal === undefined ? {} : { signal }) });
      return decodeHostAnswer(ServerProjectsView)((body as { view?: unknown }).view);
    },
    async command(command, signal) {
      return decodeHostAnswer(ServerProjectsCommandResult)(
        await send({
          method: "POST",
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        }),
      );
    },
  };
}
