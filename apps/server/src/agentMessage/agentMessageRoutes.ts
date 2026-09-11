import {
  decodeAgentMessageMessagingFacts,
  type AgentMessageMessagingFacts,
} from "@octant/contracts";
import { MAX_OPEN_AGENT_MESSAGES_PER_SENDER } from "@octant/domain";
import { authenticateRouteWindowId } from "../principalRouteContext";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { AgentMessageProjection } from "./agentMessageProjection";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type";

export interface AgentMessageRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projection: AgentMessageProjection;
}

/**
 * Read-only facts about the host's agent-to-agent messaging, in the bounds
 * the policy admits. Every authenticated window may read them: they say who
 * petitioned whom and what the host refused, and carry no message bodies.
 */
export function createAgentMessageRouteHandler(
  dependencies: AgentMessageRouteDependencies,
): (request: Request) => Promise<Response | undefined> {
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/agent-messages") return undefined;
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": METHODS,
          "Access-Control-Allow-Headers": HEADERS,
        },
      });
    }
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "method-not-allowed" }), {
        status: 405,
        headers: {
          "content-type": "application/json",
          "Access-Control-Allow-Methods": METHODS,
          "Access-Control-Allow-Headers": HEADERS,
        },
      });
    }
    try {
      authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: Date.now(),
      });
    } catch {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
    const facts: AgentMessageMessagingFacts = decodeAgentMessageMessagingFacts(
      dependencies.projection.messagingFacts(MAX_OPEN_AGENT_MESSAGES_PER_SENDER),
    );
    return new Response(JSON.stringify(facts), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "Access-Control-Allow-Methods": METHODS,
        "Access-Control-Allow-Headers": HEADERS,
      },
    });
  };
}
