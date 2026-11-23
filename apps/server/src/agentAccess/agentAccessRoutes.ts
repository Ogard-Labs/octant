import { AGENT_PROOF_HEADER } from "@octant/contracts";
import {
  agentToolList,
  callAgentTool,
  initializeResult,
  type ToolAnswer,
} from "@octant/cli/agent-tools";
import { remoteAccessPausedResponse } from "../remote/remoteHttpAuthentication";
import type { RemoteRouteFacts } from "../remoteRoutePolicy";
import type { AgentAccessService } from "./agentAccessService";
import {
  agentToolPolicy,
  createAgentSession,
  type AgentSessionDependencies,
} from "./agentAccessSession";

import {
  eventFailure,
  modernAgentMcp,
  validateEventHeaders,
  type AgentEventRoutes,
} from "./agentEventRoutes";

export const AGENT_ACCESS_LISTENER_ROUTES = {
  claim: "/api/agent-access/claim",
  mcp: "/api/agent-access/mcp",
} as const;

export const MAX_AGENT_MCP_BODY_BYTES = 262_144;
export const MAX_AGENT_MCP_RESPONSE_BYTES = 1_048_576;
const KEEPALIVE_MS = 5_000;

type JsonObject = Readonly<Record<string, unknown>>;

export interface AgentAccessListenerRouteOptions {
  readonly service: AgentAccessService;
  readonly session: AgentSessionDependencies;
  readonly version: string;
  readonly pollIntervalMs?: number;
  readonly events?: AgentEventRoutes;
  /**
   * Whether remote access is paused, read again once a request's body has
   * arrived: the pause may have been made while it was still uploading,
   * after the gateway read it. The loopback server never passes this; an
   * MCP client on this computer is not remote access.
   */
  readonly remoteAccessPaused?: () => boolean;
}

/**
 * The agent-access routes: `claim`, where an agent's machine offers its new
 * key against a one-time ticket, and `mcp`, the one endpoint an outside agent
 * reaches. The private listener serves both to the LAN-private and Tailscale
 * source classes. The loopback server serves `mcp` alone, to an MCP client on
 * this computer that joined as a bridge does: its key was still claimed over
 * the listener and confirmed by the person, and loopback adds nothing to what
 * the grant allows. Every credential failure is the same 401.
 */
export function createAgentAccessListenerRouteHandler(
  options: AgentAccessListenerRouteOptions,
): (
  request: Request,
  facts?: Pick<RemoteRouteFacts, "sourceClass">,
  pauseSignal?: AbortSignal,
) => Promise<Response | undefined> {
  return async (request, facts, pauseSignal) => {
    const url = new URL(request.url);
    if (
      url.pathname !== AGENT_ACCESS_LISTENER_ROUTES.claim &&
      url.pathname !== AGENT_ACCESS_LISTENER_ROUTES.mcp
    ) {
      return undefined;
    }
    const sourceClass = facts?.sourceClass;
    if (sourceClass === undefined || sourceClass === "unknown") return unauthorized();
    if (sourceClass === "loopback" && url.pathname !== AGENT_ACCESS_LISTENER_ROUTES.mcp) {
      return unauthorized();
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    const bytes = await readBody(request, MAX_AGENT_MCP_BODY_BYTES);
    if (bytes === undefined) return Response.json({ error: "too-large" }, { status: 413 });
    // Judged again now the upload has arrived, before the request's grant is
    // read and any tool runs: a pause made while this body streamed refuses
    // it here, the same answer the gateway would have given.
    if (
      sourceClass !== "loopback" &&
      (options.remoteAccessPaused?.() === true || pauseSignal?.aborted === true)
    ) {
      return remoteAccessPausedResponse();
    }

    if (url.pathname === AGENT_ACCESS_LISTENER_ROUTES.claim) {
      const claimed = options.service.claim(parseJson(new TextDecoder().decode(bytes)));
      return claimed.kind === "pending"
        ? Response.json(
            {
              kind: "pending",
              message:
                "Octant holds this key until the person confirms its fingerprint in Settings › Agent access or with octant agent-access confirm.",
            },
            { status: 202 },
          )
        : unauthorized();
    }

    const authenticated = options.service.authenticate({
      method: request.method,
      pathWithQuery: `${url.pathname}${url.search}`,
      body: bytes,
      proof: request.headers.get(AGENT_PROOF_HEADER),
      authorization: request.headers.get("authorization"),
      sourceClass,
    });
    if (authenticated.kind === "limited") {
      return Response.json(
        { error: "rate-limited" },
        { status: 429, headers: { "retry-after": String(authenticated.retryAfterSeconds) } },
      );
    }
    if (authenticated.kind !== "authenticated") return unauthorized();

    const message = asObject(parseJson(new TextDecoder().decode(bytes)));
    if (message === undefined) return rpc(failure(null, -32700, "Parse error"));
    const id = message["id"];
    const method = message["method"];
    const params = asObject(message["params"]);
    if (typeof id !== "string" && typeof id !== "number") {
      // A notification or a response from the client: nothing to answer.
      return new Response(null, { status: 202 });
    }
    const grant = authenticated.grant;
    const policy = agentToolPolicy(grant, options.session);
    const modern = modernAgentMcp(request, params);
    const events = options.events;
    const access = {
      grantId: String(grant.grantId),
      grantSignal: authenticated.signal,
      allowed: grant.scope.tools.includes("read_thread"),
      canRead: (threadId: string) => {
        const current = options.service.readActive(String(grant.grantId));
        if (current === undefined || !current.scope.tools.includes("read_thread")) return false;
        const project = options.session.threadProject(threadId);
        return (
          project !== undefined &&
          (project.projectId === undefined || options.service.projectIsActive(project.projectId)) &&
          agentToolPolicy(current, options.session).threadAllowed(threadId)
        );
      },
    };
    const compatibility = events?.compatibility(access) ?? false;
    if (typeof method === "string" && method.startsWith("events/") && events !== undefined) {
      try {
        return await events.handle({ request, id, method, params, access, compatibility });
      } catch {
        return eventFailure(id, -32603, "Octant could not read thread milestones");
      }
    }
    if (modern && typeof method === "string") {
      const invalid = validateEventHeaders(
        request,
        id,
        method,
        params,
        method === "server/discover" && compatibility,
        method === "tools/call",
      );
      if (invalid !== undefined) return invalid;
    }
    if (method === "server/discover" && events !== undefined) {
      if (!modern && !compatibility) return eventFailure(id, -32020, "HeaderMismatch", 400);
      return events.discover(id, access, options.version);
    }
    if (method === "initialize" && !modern) {
      const initialized = initializeResult(params, options.version);
      return rpc(
        result(
          id,
          compatibility ? { ...initialized, capabilities: { tools: {}, events: {} } } : initialized,
        ),
      );
    }
    const complete = (value: JsonObject) =>
      result(id, modern ? { resultType: "complete", ...value } : value);
    if (method === "ping") return rpc(complete({}));
    if (method === "tools/list") return rpc(complete({ tools: agentToolList(policy) }));
    if (method !== "tools/call") {
      return modern
        ? eventFailure(id, -32601, "Method not found", 404)
        : rpc(failure(id, -32601, "Method not found"));
    }

    const name = params?.["name"];
    if (typeof name !== "string" || !agentToolList(policy).some((tool) => tool["name"] === name)) {
      return rpc(failure(id, -32602, `Unknown tool: ${String(name)}`));
    }
    // A grant revoked while the body uploaded, or since it was read, aborts
    // the signal the tool run binds to; refuse before the tool runs.
    if (authenticated.signal.aborted) return unauthorized();
    const signal = AbortSignal.any([
      authenticated.signal,
      request.signal,
      ...(pauseSignal === undefined || sourceClass === "loopback" ? [] : [pauseSignal]),
    ]);
    const call = callAgentTool(name, asObject(params?.["arguments"]) ?? {}, {
      openSession: async () => createAgentSession({ grant, signal, deps: options.session }),
      signal,
      policy,
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    }).catch(
      (error: unknown): ToolAnswer => ({
        value: `Octant could not finish this call: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }),
    );
    const answer = (value: ToolAnswer) =>
      complete({
        content: [
          {
            type: "text",
            text:
              typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2),
          },
        ],
        ...(value.isError ? { isError: true } : {}),
      });
    if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
      return rpc(answer(await call));
    }
    // A waiting call can outlast the server's idle limit, so the answer comes
    // as one server-sent event after comment frames that keep the line open.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const keepalive = setInterval(
          () => controller.enqueue(encoder.encode(": keepalive\n\n")),
          KEEPALIVE_MS,
        );
        void call.then((value) => {
          clearInterval(keepalive);
          controller.enqueue(
            encoder.encode(`event: message\ndata: ${JSON.stringify(answer(value))}\n\n`),
          );
          controller.close();
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  };
}

async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const buffer = new Uint8Array(
    await request.arrayBuffer().catch(() => new ArrayBuffer(limit + 1)),
  );
  return buffer.byteLength > limit ? undefined : buffer;
}

function rpc(message: JsonObject): Response {
  return Response.json(message, { status: 200, headers: { "cache-control": "no-store" } });
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

function result(id: string | number, value: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: string | number | null, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
