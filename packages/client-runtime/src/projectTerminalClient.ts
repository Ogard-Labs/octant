import {
  decodeProjectTerminalResult,
  type ProjectTerminalCommand,
  type ProjectTerminalResult,
} from "@octant/contracts/project-terminals";
import { bindFetchPort } from "./bindFetchPort";

export interface ProjectTerminalClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProjectTerminalClient {
  execute(command: ProjectTerminalCommand, signal?: AbortSignal): Promise<ProjectTerminalResult>;
}

export class ProjectTerminalClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProjectTerminalClientFailure";
    this.status = status;
  }
}

/**
 * Client for terminals a Code Project owns without a thread.
 *
 * It carries the window capability and the command, and returns the host's
 * typed answer. The host decides the root, the posture, and whether this
 * window owns the shell; a refusal comes back as a result, not an exception,
 * so a card can say why it cannot type.
 */
export function createProjectTerminalClient(
  options: ProjectTerminalClientOptions,
): ProjectTerminalClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/code/project-terminals", options.baseUrl).toString();

  return {
    async execute(command, signal) {
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
        throw new ProjectTerminalClientFailure("Project terminals are unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Project terminals are unavailable.";
        throw new ProjectTerminalClientFailure(message, response.status);
      }
      return decodeProjectTerminalResult(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProjectTerminalClientFailure("Project terminal base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new ProjectTerminalClientFailure("Project terminal base URL must be loopback.", 0);
  }
}
