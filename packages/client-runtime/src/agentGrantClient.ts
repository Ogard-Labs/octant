import {
  AgentAccessResult,
  AgentThreadAttributions,
  decodeHostAnswer,
  type AgentGrantRevokeRequest,
} from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface AgentGrantClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class AgentGrantClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AgentGrantClientFailure";
    this.status = status;
  }
}

/**
 * What a local window and a paired device both ask about outside agents: the
 * grants, ending one, and which threads each agent started. Making or changing
 * a grant is a local window's alone and goes through the desktop bridge.
 */
export interface AgentGrantClient {
  grants(signal?: AbortSignal): Promise<AgentAccessResult>;
  revoke(request: AgentGrantRevokeRequest): Promise<AgentAccessResult>;
  threads(signal?: AbortSignal): Promise<AgentThreadAttributions>;
}

export function createAgentGrantClient(options: AgentGrantClientOptions): AgentGrantClient {
  const fetch = bindFetchPort(options.fetch);
  const get = async (path: string, signal: AbortSignal | undefined): Promise<unknown> =>
    send(fetch, new URL(path, options.baseUrl).toString(), {
      method: "GET",
      redirect: "error",
      headers: { "x-octant-window-capability": options.windowCapability },
      ...(signal === undefined ? {} : { signal }),
    });
  return {
    async grants(signal) {
      return decodeHostAnswer(AgentAccessResult)(await get("/api/agent-grants", signal));
    },
    async threads(signal) {
      return decodeHostAnswer(AgentThreadAttributions)(
        await get("/api/agent-grants/threads", signal),
      );
    },
    async revoke(request) {
      const body = await send(
        fetch,
        new URL("/api/agent-grants/revoke", options.baseUrl).toString(),
        {
          method: "POST",
          redirect: "error",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
        },
        // The host answers a refused revoke with 409 and the refusal, which
        // says why (the grant is gone or already revoked).
        true,
      );
      return decodeHostAnswer(AgentAccessResult)(body);
    },
  };
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  refusalIsAnswer = false,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new AgentGrantClientFailure("Agent access is unavailable.", 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AgentGrantClientFailure("Agent access is unavailable.", response.status);
  }
  if (response.ok || (refusalIsAnswer && response.status === 409)) return body;
  const message =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : "Agent access is unavailable.";
  throw new AgentGrantClientFailure(message, response.status);
}
