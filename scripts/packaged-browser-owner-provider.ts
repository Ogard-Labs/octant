import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const OWNED_BROWSER_FIXTURE_MODEL = "owned-browser-fixture";
export const OWNED_BROWSER_FIXTURE_NAME = "Owned native Browser fixture";
const MAX_REQUESTS = 32;
const MAX_BODY_BYTES = 65_536;

export async function startOwnedBrowserProvider(input: {
  readonly signal: AbortSignal;
  readonly lifetimeMs: number;
}) {
  if (
    input.signal.aborted ||
    !Number.isSafeInteger(input.lifetimeMs) ||
    input.lifetimeMs < 1 ||
    input.lifetimeMs > 180_000
  )
    throw Error("The owned provider requires a live finite owner.");
  let requests = 0;
  let models = 0;
  let responsesRefused = 0;
  let chatProbes = 0;
  let rejected = 0;
  const sockets = new Set<Socket>();
  const evidence = () => ({ requests, models, responsesRefused, chatProbes, rejected });
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json", connection: "close" });
    response.end(JSON.stringify(body));
  };
  const read = async (request: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : undefined;
      if (buffer === undefined || (bytes += buffer.length) > MAX_BODY_BYTES)
        throw Error("Owned provider body exceeds its fixed bound.");
      chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const server = createServer((request, response) => {
    requests += 1;
    if (
      requests > MAX_REQUESTS ||
      request.headers.authorization !== undefined ||
      request.headers["x-api-key"] !== undefined ||
      request.headers["api-key"] !== undefined ||
      request.headers["proxy-authorization"] !== undefined ||
      request.headers.cookie !== undefined
    ) {
      rejected += 1;
      send(response, 400, { error: "owned-fixture-request-refused" });
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      models += 1;
      send(response, 200, {
        object: "list",
        data: [
          { id: OWNED_BROWSER_FIXTURE_MODEL, object: "model", created: 0, owned_by: "octant" },
        ],
      });
      return;
    }
    if (
      request.method !== "POST" ||
      (request.url !== "/v1/responses" && request.url !== "/v1/chat/completions")
    ) {
      rejected += 1;
      send(response, 404, { error: "owned-fixture-path-refused" });
      return;
    }
    void read(request)
      .then((body: unknown) => {
        if (request.url === "/v1/responses") {
          responsesRefused += 1;
          send(response, 404, {
            error: { message: "Responses is unsupported by this owned chat fixture." },
          });
          return;
        }
        if (
          typeof body !== "object" ||
          body === null ||
          !("model" in body) ||
          body.model !== OWNED_BROWSER_FIXTURE_MODEL ||
          !("tool_choice" in body) ||
          body.tool_choice !== "required" ||
          !("tools" in body) ||
          !Array.isArray(body.tools) ||
          body.tools.length !== 1
        ) {
          rejected += 1;
          send(response, 400, { error: "owned-fixture-accepts-only-explicit-tool-probe" });
          return;
        }
        const tool: unknown = body.tools[0];
        if (
          typeof tool !== "object" ||
          tool === null ||
          !("function" in tool) ||
          typeof tool.function !== "object" ||
          tool.function === null ||
          !("name" in tool.function) ||
          tool.function.name !== "octant_capability_echo"
        ) {
          rejected += 1;
          send(response, 400, { error: "owned-fixture-tool-refused" });
          return;
        }
        const messages: unknown = "messages" in body ? body.messages : undefined;
        const last: unknown = Array.isArray(messages) ? messages.at(-1) : undefined;
        if (
          typeof last !== "object" ||
          last === null ||
          !("role" in last) ||
          last.role !== "user" ||
          !("content" in last) ||
          last.content !== "echo ready"
        ) {
          rejected += 1;
          send(response, 400, { error: "owned-fixture-probe-prompt-refused" });
          return;
        }
        chatProbes += 1;
        const call = {
          id: "owned-tool-check",
          type: "function",
          function: {
            name: "octant_capability_echo",
            arguments: JSON.stringify({ echo: "ready" }),
          },
        };
        if ("stream" in body && body.stream === true) {
          response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
          const chunks = [
            {
              id: "owned-probe",
              object: "chat.completion.chunk",
              model: OWNED_BROWSER_FIXTURE_MODEL,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", tool_calls: [{ index: 0, ...call }] },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "owned-probe",
              object: "chat.completion.chunk",
              model: OWNED_BROWSER_FIXTURE_MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
            {
              id: "owned-probe",
              object: "chat.completion.chunk",
              model: OWNED_BROWSER_FIXTURE_MODEL,
              choices: [],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            },
          ];
          response.end(
            chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
              "data: [DONE]\n\n",
          );
        } else {
          send(response, 200, {
            id: "owned-probe",
            object: "chat.completion",
            model: OWNED_BROWSER_FIXTURE_MODEL,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, tool_calls: [call] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
      })
      .catch(() => {
        rejected += 1;
        if (!response.destroyed) send(response, 413, { error: "owned-fixture-body-refused" });
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
  if (address === null || typeof address === "string") throw Error("No owned provider listener.");
  let closing: Promise<void> | undefined;
  const close = () => {
    clearTimeout(lifetime);
    input.signal.removeEventListener("abort", abort);
    closing ??= new Promise<void>((resolve, reject) => {
      const bound = setTimeout(() => reject(Error("Owned provider cleanup did not join.")), 1000);
      server.close((error) => {
        clearTimeout(bound);
        if (error !== undefined) reject(error);
        else resolve();
      });
      for (const socket of sockets) socket.destroy();
    });
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  const lifetime = setTimeout(abort, input.lifetimeMs);
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    evidence,
    close: async () => {
      clearTimeout(lifetime);
      input.signal.removeEventListener("abort", abort);
      await close();
      if (sockets.size !== 0) throw Error("Owned provider sockets remain after cleanup.");
    },
  };
}
