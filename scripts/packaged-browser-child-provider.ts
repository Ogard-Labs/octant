import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const CHILD_FIXTURE_MODEL = "owned-browser-child";
export const CHILD_FIXTURE_PARENT_TASK = "Owned Browser parent";
const CHILD_TASK = "Owned Browser child";
const ORIGIN = "https://example.com";

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite local model fixture; it never forwards a request to a provider. */
export async function startOwnedChildProvider(input: {
  readonly signal: AbortSignal;
  readonly providerInstanceId: string;
  readonly lifetimeMs: number;
}) {
  if (input.signal.aborted || input.lifetimeMs < 1 || input.lifetimeMs > 180_000)
    throw Error("The child provider requires a finite live owner.");
  const sockets = new Set<Socket>();
  const counts = { requests: 0, probes: 0, parentTurns: 0, childTurns: 0, rejected: 0 };
  let phase: "before-grant" | "after-grant" | "after-revoke" = "before-grant";
  let held: { readonly response: ServerResponse; readonly reply: () => void } | undefined;
  let childObservations: ReadonlyArray<string> = [];
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(body));
  };
  const answer = (
    response: ServerResponse,
    stream: boolean,
    call: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> } | string,
  ) => {
    const tool =
      typeof call === "string"
        ? undefined
        : {
            id: `owned-child-${counts.requests}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          };
    const message =
      tool === undefined
        ? { role: "assistant", content: call }
        : { role: "assistant", content: null, tool_calls: [tool] };
    const finish = tool === undefined ? "stop" : "tool_calls";
    if (!stream) {
      send(response, 200, {
        id: "owned-child",
        object: "chat.completion",
        model: CHILD_FIXTURE_MODEL,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const delta =
      tool === undefined
        ? message
        : {
            role: "assistant",
            tool_calls: [{ index: 0, ...tool }],
          };
    const chunk = (delta: unknown, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: "owned-child",
        object: "chat.completion.chunk",
        model: CHILD_FIXTURE_MODEL,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    response.end(chunk(delta, null) + chunk({}, finish) + "data: [DONE]\n\n");
  };
  const browserCall = {
    name: "octant_browser",
    arguments: {
      operation: "navigate",
      url: ORIGIN,
      profile: "personal",
      include: ["text"],
    },
  };
  const server = createServer((request, response) => {
    counts.requests++;
    if (
      counts.requests > 32 ||
      request.headers.authorization !== undefined ||
      request.headers.cookie !== undefined ||
      request.headers["x-api-key"] !== undefined
    ) {
      counts.rejected++;
      request.resume();
      send(response, 400, { error: "owned-child-request-refused" });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      request.resume();
      send(response, 200, { object: "list", data: [{ id: CHILD_FIXTURE_MODEL, object: "model" }] });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      request.resume();
      send(response, 404, { error: "owned-child-path-refused" });
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk)
          ? chunk
          : typeof chunk === "string"
            ? Buffer.from(chunk)
            : undefined;
        if (buffer === undefined || (bytes += buffer.length) > 262_144)
          throw Error("Body exceeds fixture bound.");
        chunks.push(buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !record(body) ||
        body.model !== CHILD_FIXTURE_MODEL ||
        !Array.isArray(body.messages) ||
        !Array.isArray(body.tools)
      )
        throw Error("Unexpected fixture turn.");
      const stream = body.stream === true;
      const names = body.tools.flatMap((tool: unknown) =>
        record(tool) && record(tool.function) && typeof tool.function.name === "string"
          ? [tool.function.name]
          : [],
      );
      const last: unknown = body.messages.at(-1);
      if (
        names.length === 1 &&
        names[0] === "octant_capability_echo" &&
        record(last) &&
        last.role === "user" &&
        last.content === "echo ready"
      ) {
        counts.probes++;
        answer(response, stream, { name: "octant_capability_echo", arguments: { echo: "ready" } });
        return;
      }
      const messages = JSON.stringify(body.messages);
      const parent = body.messages.some(
        (message: unknown) =>
          record(message) &&
          message.role === "user" &&
          JSON.stringify(message.content).includes(CHILD_FIXTURE_PARENT_TASK),
      );
      const child = !parent && messages.includes(CHILD_TASK);
      if (!child && !messages.includes(CHILD_FIXTURE_PARENT_TASK))
        throw Error("No exact owned task marker.");
      if (!child) {
        counts.parentTurns++;
        if (!names.includes("octant_agents")) throw Error("Real parent has no delegation tool.");
        answer(
          response,
          stream,
          counts.parentTurns === 1
            ? {
                name: "octant_agents",
                arguments: {
                  operation: "delegate",
                  role: "implementation",
                  task: CHILD_TASK,
                  providerInstanceId: input.providerInstanceId,
                  modelId: CHILD_FIXTURE_MODEL,
                  includeParentContext: false,
                },
              }
            : "The owned child is available for local review.",
        );
        return;
      }
      counts.childTurns++;
      if (!names.includes("octant_browser")) throw Error("Real child has no Browser tool.");
      if (record(last) && last.role === "tool" && typeof last.content === "string")
        childObservations = [...childObservations, last.content];
      if (counts.childTurns === 1) {
        answer(response, stream, browserCall);
      } else if (counts.childTurns === 2 || counts.childTurns === 3) {
        if (held !== undefined) throw Error("A fixture response is already held.");
        held = { response, reply: () => answer(response, stream, browserCall) };
        response.once("close", () => {
          if (held?.response === response) held = undefined;
        });
      } else {
        answer(response, stream, "The owned Browser authority check has finished.");
      }
    })().catch(() => {
      counts.rejected++;
      if (!response.destroyed && !response.headersSent)
        send(response, 400, { error: "owned-child-turn-refused" });
      else response.destroy();
    });
  });
  server.maxConnections = 8;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw Error("No owned child provider listener.");
  let closing: Promise<void> | undefined;
  const close = () => {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    closing ??= new Promise<void>((resolve, reject) => {
      const bound = setTimeout(() => reject(Error("The owned child provider did not stop.")), 1000);
      server.close((error) => {
        clearTimeout(bound);
        if (error !== undefined) reject(error);
        else resolve();
      });
      for (const socket of sockets) socket.destroy();
      held = undefined;
    });
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  const timer = setTimeout(abort, input.lifetimeMs);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    origin: ORIGIN,
    evidence: () => ({ ...counts, phase, held: held !== undefined, childObservations }),
    advance: (next: "after-grant" | "after-revoke") => {
      if (
        held === undefined ||
        (next === "after-grant" ? phase !== "before-grant" : phase !== "after-grant")
      )
        throw Error("The child fixture cannot advance without its exact pending turn.");
      phase = next;
      const pending = held;
      held = undefined;
      pending.reply();
    },
    close,
  };
}
