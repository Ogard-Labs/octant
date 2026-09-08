import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ProviderToolDefinition } from "@octant/contracts";

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_JSON_BYTES = 64 * 1024;
const MAX_TOOL_CALL_ID_LENGTH = 256;

export interface PiManagedToolBridgeConfig {
  readonly url: string;
  readonly token: string;
}

export interface PiManagedToolCall {
  readonly toolCallId: string;
  readonly name: string;
  readonly inputJson: string;
  readonly signal: AbortSignal;
}

export interface PiManagedToolAnswer {
  readonly resultJson: string;
  readonly isError: boolean;
}

export interface PiManagedToolsBridge {
  readonly config: PiManagedToolBridgeConfig;
  readonly close: () => Promise<void>;
}

type ExecuteManagedTool = (call: PiManagedToolCall) => Promise<PiManagedToolAnswer>;

interface JsonRecord {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  return value;
}

function responseJson(response: ServerResponse, status: number, value: JsonRecord): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function notFound(response: ServerResponse): void {
  responseJson(response, 404, { error: "not-found" });
}

function readRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_REQUEST_BYTES) {
        reject(new Error("Pi managed-tool request exceeds the protocol limit."));
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
        reject(new Error("Pi managed-tool request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function validJson(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_TOOL_JSON_BYTES) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-session loopback bridge for Pi custom tools. The Pi extension receives
 * only this random URL and token; the callback remains in Octant's provider
 * connection, where the normal app-managed tool authority is applied.
 */
export async function createPiManagedToolsBridge(
  definitions: ReadonlyArray<ProviderToolDefinition>,
  execute: ExecuteManagedTool,
): Promise<PiManagedToolsBridge> {
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) throw new Error("Pi managed-tool names collide.");
    names.add(definition.name);
  }

  const path = `/octant/${randomBytes(24).toString("base64url")}`;
  const token = randomBytes(32).toString("base64url");
  let loopbackHost: string | undefined;
  let closed = false;
  const server = createServer((request, response) => {
    const requestToken = request.headers["x-octant-pi-token"];
    if (
      request.url !== path ||
      request.method !== "POST" ||
      request.headers.origin !== undefined ||
      request.headers.host !== loopbackHost ||
      requestToken !== token
    ) {
      notFound(response);
      return;
    }

    void (async () => {
      const body = await readRequestBody(request);
      if (!isRecord(body)) {
        responseJson(response, 400, { error: "invalid-request" });
        return;
      }
      const toolCallId = text(body.toolCallId, MAX_TOOL_CALL_ID_LENGTH);
      const name = text(body.name, 256);
      if (toolCallId === undefined || name === undefined || !names.has(name)) {
        responseJson(response, 404, { error: "tool-unavailable" });
        return;
      }
      const input = body.input;
      if (!isRecord(input)) {
        responseJson(response, 400, { error: "invalid-input" });
        return;
      }
      const inputJson = JSON.stringify(input);
      if (!validJson(inputJson)) {
        responseJson(response, 413, { error: "input-too-large" });
        return;
      }

      const controller = new AbortController();
      let settled = false;
      const cancel = () => {
        if (settled) return;
        controller.abort();
      };
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        const answer = await execute({ toolCallId, name, inputJson, signal: controller.signal });
        settled = true;
        if (!validJson(answer.resultJson)) {
          responseJson(response, 502, { error: "invalid-tool-result" });
          return;
        }
        responseJson(response, 200, {
          resultJson: answer.resultJson,
          isError: answer.isError,
        });
      } catch {
        settled = true;
        if (!response.destroyed) responseJson(response, 500, { error: "tool-execution-failed" });
      } finally {
        request.off("aborted", cancel);
        response.off("close", cancel);
      }
    })().catch(() => {
      if (!response.headersSent) responseJson(response, 400, { error: "invalid-request" });
      else response.destroy();
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
    server.close();
    throw error;
  }

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Pi managed-tool bridge did not expose a loopback address.");
  }
  loopbackHost = `127.0.0.1:${address.port}`;

  return {
    config: { url: `http://${loopbackHost}${path}`, token },
    close: async () => {
      if (closed) return;
      closed = true;
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
