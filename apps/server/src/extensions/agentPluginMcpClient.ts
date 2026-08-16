import type { Readable, Writable } from "node:stream";
import type { AgentPluginsMcpLaunchSpec } from "@octant/plugin-host/agent-plugins";
import { readBoundedResponseBody } from "./boundedResponseBody";

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface AgentPluginMcpSession {
  readonly transport: "stdio" | "streamable-http";
  readonly name: string;
  readonly tools: ReadonlyArray<McpToolDefinition>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface AgentPluginMcpStdioProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stop: () => Promise<void>;
  once(event: "exit", listener: () => void): unknown;
}

export interface AgentPluginMcpStdioProcessPort {
  start(
    launch: Extract<AgentPluginsMcpLaunchSpec, { transport: "stdio" }>,
    signal?: AbortSignal,
  ): Promise<AgentPluginMcpStdioProcess>;
}

const MAX_STDIO_MCP_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_MCP_TOOL_PAGES = 16;
const MAX_MCP_TOOLS = 256;

/**
 * Open an MCP session using the declared Agent Plugins transport and complete
 * the initialize handshake + tools/list. Failures here are connection failures
 * for that server only.
 */
export async function connectAgentPluginMcpSession(
  launch: AgentPluginsMcpLaunchSpec,
  options: {
    readonly signal?: AbortSignal;
    readonly fetch?: typeof globalThis.fetch;
    readonly stdioProcess?: AgentPluginMcpStdioProcessPort;
    readonly cleanupTimeoutMs?: number;
    readonly onTransportClosed?: () => void;
  } = {},
): Promise<AgentPluginMcpSession> {
  if (launch.transport === "stdio") {
    if (options.stdioProcess === undefined) {
      throw new Error("MCP stdio requires the supervised extension runtime.");
    }
    return connectStdio(launch, options.stdioProcess, options.signal, options.onTransportClosed);
  }
  return connectStreamableHttp(
    launch,
    options.fetch ?? globalThis.fetch,
    options.signal,
    options.cleanupTimeoutMs,
  );
}

async function connectStdio(
  launch: Extract<AgentPluginsMcpLaunchSpec, { transport: "stdio" }>,
  processPort: AgentPluginMcpStdioProcessPort,
  signal?: AbortSignal,
  onTransportClosed?: () => void,
): Promise<AgentPluginMcpSession> {
  if (signal?.aborted) throw new DOMException("MCP connection was interrupted.", "AbortError");
  const process = await processPort.start(launch, signal);
  const transport = new StdioJsonRpcTransport(process, onTransportClosed);
  try {
    const tools = await initializeAndListTools(transport, signal);
    return {
      transport: "stdio",
      name: launch.name,
      tools,
      callTool: (name, args, callSignal) =>
        transport.request("tools/call", { name, arguments: args ?? {} }, callSignal),
      close: async () => transport.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function connectStreamableHttp(
  launch: Extract<AgentPluginsMcpLaunchSpec, { transport: "streamable-http" | "sse" }>,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
  cleanupTimeoutMs?: number,
): Promise<AgentPluginMcpSession> {
  if (launch.transport === "sse") {
    throw new Error("Legacy HTTP+SSE MCP transport is not enabled.");
  }
  const transport = new StreamableHttpJsonRpcTransport(
    launch.url,
    launch.headers,
    fetchImpl,
    cleanupTimeoutMs,
  );
  try {
    const tools = await initializeAndListTools(transport, signal);
    return {
      transport: "streamable-http",
      name: launch.name,
      tools,
      callTool: (name, args, callSignal) =>
        transport.request("tools/call", { name, arguments: args ?? {} }, callSignal),
      close: async () => transport.close(),
    };
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }
}

async function initializeAndListTools(
  transport: JsonRpcTransport,
  signal?: AbortSignal,
): Promise<McpToolDefinition[]> {
  const initializeResult = (await transport.request(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "octant", version: "1.0.0" },
    },
    signal,
  )) as { protocolVersion?: unknown };
  const negotiatedProtocolVersion =
    typeof initializeResult?.protocolVersion === "string" &&
    initializeResult.protocolVersion.length > 0
      ? initializeResult.protocolVersion
      : "2025-03-26";
  transport.setProtocolVersion?.(negotiatedProtocolVersion);
  await transport.notify("notifications/initialized", {}, signal);
  const tools: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }> = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_MCP_TOOL_PAGES; page += 1) {
    const listed = (await transport.request(
      "tools/list",
      cursor === undefined ? {} : { cursor },
      signal,
    )) as {
      tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
      nextCursor?: unknown;
    };
    if (Array.isArray(listed.tools)) tools.push(...listed.tools);
    if (tools.length > MAX_MCP_TOOLS) throw new Error("MCP tool catalogue exceeds the limit.");
    if (listed.nextCursor === undefined || listed.nextCursor === null) break;
    if (typeof listed.nextCursor !== "string" || listed.nextCursor.length === 0) {
      throw new Error("MCP tool catalogue cursor is invalid.");
    }
    if (seenCursors.has(listed.nextCursor)) {
      throw new Error("MCP tool catalogue cursor repeated.");
    }
    seenCursors.add(listed.nextCursor);
    cursor = listed.nextCursor;
    if (page === MAX_MCP_TOOL_PAGES - 1) {
      throw new Error("MCP tool catalogue exceeds the page limit.");
    }
  }
  return tools
    .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
    .map((tool) => ({
      name: tool.name as string,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    }));
}

interface JsonRpcTransport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
  setProtocolVersion?(protocolVersion: string): void;
}

class StdioJsonRpcTransport implements JsonRpcTransport {
  readonly #child: AgentPluginMcpStdioProcess;
  readonly #onTransportClosed: (() => void) | undefined;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #nextId = 1;
  #closed = false;
  #lineBuffer = "";
  readonly #ready: Promise<void>;

  constructor(child: AgentPluginMcpStdioProcess, onTransportClosed?: () => void) {
    this.#child = child;
    this.#onTransportClosed = onTransportClosed;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onData(String(chunk)));
    this.#ready = Promise.resolve();
    child.once("exit", () => {
      const unexpected = !this.#closed;
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("MCP stdio session closed."));
      }
      this.#pending.clear();
      if (unexpected) this.#onTransportClosed?.();
    });
  }

  #onData(chunk: string): void {
    if (this.#closed) return;
    this.#lineBuffer += chunk;
    if (Buffer.byteLength(this.#lineBuffer, "utf8") > MAX_STDIO_MCP_MESSAGE_BYTES) {
      this.#fail(new Error("MCP stdio message exceeded the protocol limit."));
      return;
    }
    let newline = this.#lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#lineBuffer.slice(0, newline).replace(/\r$/, "");
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      this.#onLine(line);
      if (Buffer.byteLength(this.#lineBuffer, "utf8") > MAX_STDIO_MCP_MESSAGE_BYTES) {
        this.#fail(new Error("MCP stdio message exceeded the protocol limit."));
        return;
      }
      newline = this.#lineBuffer.indexOf("\n");
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#onTransportClosed?.();
    void this.#child.stop().catch(() => undefined);
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.#ready;
    if (this.#closed) throw new Error("MCP stdio session is closed.");
    if (signal?.aborted) throw new DOMException("MCP request was interrupted.", "AbortError");
    const id = this.#nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return await new Promise<unknown>((resolve, reject) => {
      const onAbort = () => {
        this.#pending.delete(id);
        reject(new DOMException("MCP request was interrupted.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this.#child.stdin.write(`${payload}\n`, (error) => {
        if (error) {
          this.#pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      });
    });
  }

  async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    await this.#ready;
    if (signal?.aborted) throw new DOMException("MCP request was interrupted.", "AbortError");
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(`${payload}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    await this.#child.stop();
  }

  #onLine(line: string): void {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      typeof (message as { id: unknown }).id !== "number"
    ) {
      return;
    }
    const id = (message as { id: number }).id;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if ("error" in message) {
      const error = (message as { error?: { message?: string } }).error;
      pending.reject(new Error(error?.message ?? "MCP request failed."));
      return;
    }
    pending.resolve((message as { result?: unknown }).result);
  }
}

class StreamableHttpJsonRpcTransport implements JsonRpcTransport {
  readonly #url: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #cleanupTimeoutMs: number;
  #sessionId: string | undefined;
  #nextId = 1;
  #closed = false;
  #protocolVersion: string | undefined;

  constructor(
    url: string,
    headers: Readonly<Record<string, string>>,
    fetchImpl: typeof fetch,
    cleanupTimeoutMs = 1_000,
  ) {
    this.#url = url;
    this.#headers = headers;
    this.#fetch = fetchImpl;
    this.#cleanupTimeoutMs = cleanupTimeoutMs;
  }

  setProtocolVersion(protocolVersion: string): void {
    this.#protocolVersion = protocolVersion;
  }

  #requestHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return {
      ...this.#headers,
      ...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId }),
      ...(this.#protocolVersion === undefined
        ? {}
        : { "mcp-protocol-version": this.#protocolVersion }),
      ...extra,
    };
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error("MCP HTTP session is closed.");
    const id = this.#nextId++;
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        ...this.#requestHeaders({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      ...(signal === undefined ? {} : { signal }),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    if (!response.ok) {
      throw new Error(`MCP HTTP request failed with status ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const payload = await readMatchingSseResponse(response, id, signal);
      if (payload.error) throw new Error(payload.error.message ?? "MCP request failed.");
      return payload.result;
    }
    const payload = JSON.parse(
      new TextDecoder().decode(
        await readBoundedResponseBody(
          response,
          MAX_STDIO_MCP_MESSAGE_BYTES,
          "MCP HTTP JSON response exceeds the message limit.",
        ),
      ),
    ) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (payload.error) throw new Error(payload.error.message ?? "MCP request failed.");
    return payload.result;
  }

  async notify(method: string, params: unknown, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error("MCP HTTP session is closed.");
    const response = await this.#fetch(this.#url, {
      method: "POST",
      headers: {
        ...this.#requestHeaders({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      ...(signal === undefined ? {} : { signal }),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.#sessionId = sessionId;
    if (!response.ok) {
      throw new Error(`MCP HTTP notification failed with status ${response.status}.`);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sessionId === undefined) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#cleanupTimeoutMs);
    timeout.unref?.();
    try {
      await this.#fetch(this.#url, {
        method: "DELETE",
        headers: this.#requestHeaders(),
        signal: controller.signal,
      });
    } catch {
      // Best-effort session delete.
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readMatchingSseResponse(
  response: Response,
  requestId: number,
  signal?: AbortSignal,
): Promise<{ readonly result?: unknown; readonly error?: { readonly message?: string } }> {
  if (response.body === null) throw new Error("MCP HTTP SSE response was empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("MCP request was interrupted.", "AbortError");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STDIO_MCP_MESSAGE_BYTES) {
        throw new Error("MCP HTTP SSE response exceeds the message limit.");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trimStart())
          .join("\n");
        if (data === "") continue;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (
          typeof payload === "object" &&
          payload !== null &&
          "id" in payload &&
          (payload as { id?: unknown }).id === requestId
        ) {
          await reader.cancel().catch(() => undefined);
          return payload as { result?: unknown; error?: { message?: string } };
        }
      }
    }
    throw new Error("MCP HTTP SSE response did not contain the request result.");
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
