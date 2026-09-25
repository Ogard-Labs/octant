import {
  decodeProjectBrowserResult,
  type ProjectBrowserCommand,
  type ProjectBrowserResult,
} from "@octant/contracts/project-browser";
import { bindFetchPort } from "./bindFetchPort";

export interface ProjectBrowserClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProjectBrowserClient {
  execute(command: ProjectBrowserCommand, signal?: AbortSignal): Promise<ProjectBrowserResult>;
}

export class ProjectBrowserClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProjectBrowserClientFailure";
    this.status = status;
  }
}

/**
 * Client for the browser a Work or Code Project owns without a thread.
 *
 * It carries the window capability and the command and returns the host's
 * typed answer. The host decides whether this window holds the Project and
 * which isolated context the page lives in; a refusal is a result, so a dock
 * can say why it cannot open a page.
 */
export function createProjectBrowserClient(
  options: ProjectBrowserClientOptions,
): ProjectBrowserClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);
  const url = new URL("/api/browser/project-contexts", options.baseUrl).toString();

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
        throw new ProjectBrowserClientFailure("Project browsers are unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "message" in body &&
          typeof body.message === "string"
            ? body.message
            : "Project browsers are unavailable.";
        throw new ProjectBrowserClientFailure(message, response.status);
      }
      return decodeProjectBrowserResult(body);
    },
  };
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ProjectBrowserClientFailure("Project browser base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new ProjectBrowserClientFailure("Project browser base URL must be loopback.", 0);
  }
}
