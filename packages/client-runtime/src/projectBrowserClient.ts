import {
  type ProjectBrowserCommand,
  ProjectBrowserResult,
} from "@octant/contracts/project-browser";
import {
  BrowserExtensionsResult,
  decodeBrowserExtensionsCommand,
  type BrowserExtensionsCommand,
} from "@octant/contracts/browser-extensions";
import {
  BrowserProfilesResult,
  decodeBrowserProfilesCommand,
  type BrowserProfilesCommand,
} from "@octant/contracts/browser-profiles";
import { decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ProjectBrowserClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ProjectBrowserClient {
  execute(command: ProjectBrowserCommand, signal?: AbortSignal): Promise<ProjectBrowserResult>;
  /** The extensions enabled in the dock's profile, for the toolbar's extensions button. */
  manageExtensions?(
    command: BrowserExtensionsCommand,
    signal?: AbortSignal,
  ): Promise<BrowserExtensionsResult>;
  /** Sign out of a stored profile from the dock's own profile menu. */
  manageProfiles?(
    command: BrowserProfilesCommand,
    signal?: AbortSignal,
  ): Promise<BrowserProfilesResult>;
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
  const profilesUrl = new URL("/api/browser/profiles", options.baseUrl).toString();
  const extensionsUrl = new URL("/api/browser/extensions", options.baseUrl).toString();

  async function post(target: string, command: unknown, signal: AbortSignal | undefined) {
    let response: Response;
    try {
      response = await fetch(target, {
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
    return body;
  }

  return {
    async execute(command, signal) {
      return decodeHostAnswer(ProjectBrowserResult)(await post(url, command, signal));
    },
    async manageExtensions(command, signal) {
      return decodeHostAnswer(BrowserExtensionsResult)(
        await post(extensionsUrl, decodeBrowserExtensionsCommand(command), signal),
      );
    },
    async manageProfiles(command, signal) {
      return decodeHostAnswer(BrowserProfilesResult)(
        await post(profilesUrl, decodeBrowserProfilesCommand(command), signal),
      );
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
