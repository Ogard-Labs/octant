import {
  decodeAgentMessageMessagingFacts,
  type AgentMessageMessagingFacts,
} from "@octant/contracts";

export interface AgentMessageClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface AgentMessageClient {
  /** The host's messaging facts in the bounds the policy admits. */
  facts(): Promise<AgentMessageMessagingFacts>;
}

export class AgentMessageClientFailure extends Error {
  constructor(
    readonly code: "unauthorized" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AgentMessageClientFailure";
  }
}

/** Read-only client for the agent message facts route. Never caches a read. */
export function createAgentMessageClient(options: AgentMessageClientOptions): AgentMessageClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    async facts() {
      const body = await requestJson(
        options.fetch,
        new URL("/api/agent-messages", options.baseUrl).toString(),
        { method: "GET", headers },
      );
      return decodeAgentMessageMessagingFacts(body);
    },
  };
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
    throw new AgentMessageClientFailure(
      "unavailable",
      "Octant agent messaging service is unavailable.",
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentMessageClientFailure("unavailable", "Agent message response is malformed.");
  }
  if (response.status === 401) {
    throw new AgentMessageClientFailure("unauthorized", "Agent message request is unauthorized.");
  }
  if (!response.ok) {
    throw new AgentMessageClientFailure("invalid", "Agent message request is invalid.");
  }
  return body;
}
