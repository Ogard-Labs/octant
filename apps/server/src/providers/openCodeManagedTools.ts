import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderToolDefinition } from "@octant/provider-sdk/driver";
import {
  createManagedMcpTools,
  type ManagedToolAnswer,
  type ManagedToolCallContext,
} from "./managedMcpTools";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export interface OpenCodeManagedToolsBridge {
  readonly url: string;
  readonly port: number;
  /** Resolves only after the provider initializes and lists this bridge's tools. */
  readonly attested: Promise<void>;
  readonly close: () => Promise<void>;
}

type ExecuteManagedTool = (
  name: string,
  inputJson: string,
  signal: AbortSignal,
  context?: ManagedToolCallContext,
) => Promise<ManagedToolAnswer>;

/**
 * The SDK's Node transport is emitted with a wider optional-property shape
 * than its protocol interface under exactOptionalPropertyTypes. Keep the
 * compatibility boundary local while forwarding every lifecycle callback.
 */
class OpenCodeMcpTransport implements Transport {
  readonly #inner: StreamableHTTPServerTransport;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;

  constructor(inner: StreamableHTTPServerTransport) {
    this.#inner = inner;
  }

  start(): Promise<void> {
    this.#inner.onclose = this.onclose;
    this.#inner.onerror = this.onerror;
    this.#inner.onmessage = this.onmessage;
    return this.#inner.start();
  }

  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    return this.#inner.send(message, options);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }
}

function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("MCP request exceeds the protocol limit."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      if (body.trim() === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function notFound(response: ServerResponse): void {
  response.statusCode = 404;
  response.end();
}

/**
 * Owns the loopback MCP endpoint used by an OpenCode connection. The random
 * path is the only credential exposed to the provider process; no external
 * MCP configuration or host service is reachable through this listener.
 */
export async function createOpenCodeManagedToolsBridge(
  definitions: ReadonlyArray<ProviderToolDefinition>,
  execute: ExecuteManagedTool,
): Promise<OpenCodeManagedToolsBridge> {
  const managed = createManagedMcpTools(definitions, execute);
  if (managed.kind !== "ready") throw new Error("OpenCode tool catalogue is invalid.");

  const path = `/mcp/${randomBytes(24).toString("base64url")}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await managed.server.connect(new OpenCodeMcpTransport(transport));

  let initialized = false;
  let listed = false;
  let attest: () => void = () => undefined;
  const attested = new Promise<void>((resolve) => {
    attest = resolve;
  });
  const observeProtocolRequest = (body: unknown): void => {
    if (typeof body !== "object" || body === null || Array.isArray(body)) return;
    if (!("method" in body)) return;
    const method = body.method;
    if (method === "initialize") initialized = true;
    if (method === "tools/list") listed = true;
    if (initialized && listed) attest();
  };

  let closed = false;
  let loopbackHost: string | undefined;
  const server = createServer((request, response) => {
    if (
      request.url !== path ||
      request.headers.origin !== undefined ||
      request.headers.host !== loopbackHost
    ) {
      notFound(response);
      return;
    }
    if (request.method !== "POST" && request.method !== "GET" && request.method !== "DELETE") {
      response.statusCode = 405;
      response.setHeader("allow", "DELETE, GET, POST");
      response.end();
      return;
    }
    void (async () => {
      const body = request.method === "POST" ? await readRequestBody(request) : undefined;
      observeProtocolRequest(body);
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) {
        response.statusCode = 400;
        response.end();
      } else {
        response.destroy();
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
  } catch (error) {
    await managed.server.close().catch(() => undefined);
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await managed.server.close().catch(() => undefined);
    throw new Error("OpenCode MCP endpoint did not expose a loopback address.");
  }
  loopbackHost = `127.0.0.1:${address.port}`;

  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    port: address.port,
    attested,
    close: async () => {
      if (closed) return;
      closed = true;
      await transport.close().catch(() => undefined);
      await managed.server.close().catch(() => undefined);
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };
}
