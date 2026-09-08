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
import { AcpFailure, type AcpMcpHttpServer } from "./acpProtocol";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const ATTESTATION_TIMEOUT_MS = 15_000;

export interface AcpManagedToolsBridge {
  /** The exact HTTP MCP declaration sent in the ACP session request. */
  readonly server: AcpMcpHttpServer;
  /** The one loopback port the ACP process must reach for this session. */
  readonly port: number;
  /** Resolves only after the agent initialized this endpoint and listed its exact tools. */
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
 * The MCP SDK's Node transport has wider optional callback properties than its
 * protocol interface under exactOptionalPropertyTypes. Keep that compatibility
 * boundary inside this bridge and forward every lifecycle callback.
 */
class AcpMcpTransport implements Transport {
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
 * Owns a loopback-only, session-scoped MCP endpoint for ACP. The unguessable
 * path and matching bearer header are the only provider-visible credentials;
 * there is no inherited or user configured server set.
 */
export async function createAcpManagedToolsBridge(
  definitions: ReadonlyArray<ProviderToolDefinition>,
  execute: ExecuteManagedTool,
): Promise<AcpManagedToolsBridge> {
  const managed = createManagedMcpTools(definitions, execute);
  if (managed.kind !== "ready") throw new Error("ACP tool catalogue is invalid.");

  const token = randomBytes(32).toString("base64url");
  const path = `/mcp/${randomBytes(24).toString("base64url")}`;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await managed.server.connect(new AcpMcpTransport(transport));

  let closed = false;
  let loopbackHost: string | undefined;
  let observedInitialize = false;
  let observedToolsList = false;
  let resolveAttested!: () => void;
  let rejectAttested!: (error: Error) => void;
  let attestationTimer: ReturnType<typeof setTimeout> | undefined;
  const attested = new Promise<void>((resolve, reject) => {
    resolveAttested = resolve;
    rejectAttested = reject;
    attestationTimer = setTimeout(
      () => reject(new AcpFailure("protocol", "ACP MCP bridge was not attested by the runtime.")),
      ATTESTATION_TIMEOUT_MS,
    );
  });
  void attested.catch(() => undefined);
  const markAttested = () => {
    if (!observedInitialize || !observedToolsList) return;
    if (attestationTimer !== undefined) clearTimeout(attestationTimer);
    resolveAttested();
  };
  const server = createServer((request, response) => {
    if (
      request.url !== path ||
      request.headers.origin !== undefined ||
      request.headers.authorization !== `Bearer ${token}` ||
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
      let method: unknown;
      if (typeof body === "object" && body !== null && !Array.isArray(body) && "method" in body) {
        method = body.method;
      }
      await transport.handleRequest(request, response, body);
      if (method === "initialize") observedInitialize = true;
      if (method === "tools/list") observedToolsList = true;
      markAttested();
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
    throw new Error("ACP MCP endpoint did not expose a loopback address.");
  }
  loopbackHost = `127.0.0.1:${address.port}`;

  return {
    server: {
      type: "http",
      name: "octant-browser",
      url: `http://${loopbackHost}${path}`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      if (attestationTimer !== undefined) clearTimeout(attestationTimer);
      rejectAttested(new AcpFailure("closed", "ACP MCP bridge closed before runtime attestation."));
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
    attested,
  };
}
