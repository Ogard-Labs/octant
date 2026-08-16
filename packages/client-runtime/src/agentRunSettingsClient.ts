import {
  decodeAgentRunPolicySettings,
  type AgentRunCreationPosture,
  type AgentRunPolicySettings,
} from "@octant/contracts";

export interface AgentRunSettingsClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface AgentRunSettingsClient {
  current(): Promise<AgentRunPolicySettings>;
  update(input: {
    readonly creationPosture: AgentRunCreationPosture;
    readonly expectedVersion: number;
  }): Promise<AgentRunPolicySettings>;
}

export class AgentRunSettingsClientFailure extends Error {
  constructor(
    readonly code: "unauthorized" | "invalid" | "unavailable" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunSettingsClientFailure";
  }
}

/**
 * Client for the Agents settings route: Off / Ask /
 * Automatic creation posture with server-authoritative persistence. Never
 * caches a posture across a failed request — every read/write round-trips.
 */
export function createAgentRunSettingsClient(
  options: AgentRunSettingsClientOptions,
): AgentRunSettingsClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    async current() {
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-run-settings", options.baseUrl).toString(),
        { method: "GET", headers },
      );
      return decodeSettings(body);
    },
    async update(input) {
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-run-settings", options.baseUrl).toString(),
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      return decodeSettings(body);
    },
  };
}

function decodeSettings(body: unknown): AgentRunPolicySettings {
  if (!isRecord(body)) {
    throw new AgentRunSettingsClientFailure("unavailable", "AgentRun settings are malformed.");
  }
  try {
    return decodeAgentRunPolicySettings(body.settings);
  } catch {
    throw new AgentRunSettingsClientFailure("unavailable", "AgentRun settings are malformed.");
  }
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new AgentRunSettingsClientFailure(
      "unavailable",
      "Octant Agents settings service is unavailable.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentRunSettingsClientFailure(
      "unavailable",
      "AgentRun settings response is malformed.",
    );
  }
  if (response.status === 401) {
    throw new AgentRunSettingsClientFailure(
      "unauthorized",
      "AgentRun settings request is unauthorized.",
    );
  }
  if (response.status === 409) {
    throw new AgentRunSettingsClientFailure("conflict", "AgentRun settings changed concurrently.");
  }
  if (!response.ok) {
    throw new AgentRunSettingsClientFailure("invalid", "AgentRun settings request is invalid.");
  }
  return body;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
    ) {
      throw new Error("invalid");
    }
  } catch {
    throw new AgentRunSettingsClientFailure(
      "unavailable",
      "AgentRun settings client requires a loopback server URL.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
