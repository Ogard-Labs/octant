import {
  decodeAgentMessageMessagingFacts,
  type AgentMessageMessagingFacts,
} from "@octant/contracts";
import type { WindowId } from "@octant/contracts";
import { MAX_OPEN_AGENT_MESSAGES_PER_SENDER } from "@octant/domain";
import { authenticateRouteWindowId } from "../principalRouteContext";
import type { WindowAuthorityStore } from "../windowAuthorityStore";
import type { AgentMessageProjection } from "./agentMessageProjection";

const METHODS = "GET, OPTIONS";
const HEADERS = "content-type";

export interface AgentMessageRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projection: AgentMessageProjection;
  /** Whether this window may open the thread, archived or not, in any mode. */
  readonly windowCanOpenThread: (windowId: WindowId, threadId: string) => Promise<boolean>;
}

/**
 * Read-only facts about the host's agent-to-agent messaging, in the bounds
 * the policy admits. They say who petitioned whom and what the host refused,
 * and carry no message bodies. A window reads only the messages whose sender
 * thread it may open: the sender is who is told of a refusal, and the
 * recipient id is one that sender's own transcript already holds, so a
 * refusal never names a thread to a window that could not already see it.
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
    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
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
    const visible = new Set<string>();
    for (const senderThreadId of dependencies.projection.senderThreadIds()) {
      if (await dependencies.windowCanOpenThread(windowId, senderThreadId)) {
        visible.add(senderThreadId);
      }
    }
    const facts: AgentMessageMessagingFacts = decodeAgentMessageMessagingFacts(
      dependencies.projection.messagingFacts(
        MAX_OPEN_AGENT_MESSAGES_PER_SENDER,
        undefined,
        (senderThreadId) => visible.has(senderThreadId),
      ),
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
