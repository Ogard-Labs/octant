import { request as httpRequest } from "node:http";
import {
  TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT,
  TERMINAL_BROWSER_TOKEN_ENVIRONMENT,
} from "@octant/contracts";

/**
 * `octant mcp`: a stdio MCP server that is a pipe to the Browser endpoint a
 * thread terminal's Browser grant lent it.
 *
 * It holds no policy. Which tools exist, what needs approval, Plan, and
 * revocation are all the host's; this command only moves JSON-RPC messages
 * between the calling CLI (one JSON message per line on stdin and stdout) and
 * the endpoint (HTTP POST). Its only inputs are the two variables the host put
 * into the terminal: it never reads a data directory, the desktop bridge
 * secret, or a provider's configuration, and it writes nothing to disk.
 *
 * The endpoint address carries a secret path, so no message here ever names the
 * address, the path, or the token.
 */

export const NO_BROWSER_GRANT_MESSAGE =
  "This terminal has no Browser grant, so Octant lends it no tools. A Browser grant is " +
  "switched on for one thread terminal at a time from the Octant window; start the " +
  "terminal again with it on.";

export const MCP_COMMAND_HELP = [
  "octant mcp",
  "",
  "A stdio MCP server for a provider CLI typed into a Code thread terminal that has a",
  "Browser grant. It lends that CLI the thread's Browser tool and nothing else; every",
  "rule about it stays with Octant.",
  "",
  `It reads ${TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT} and ${TERMINAL_BROWSER_TOKEN_ENVIRONMENT} from the`,
  "terminal's environment and nothing else. Without them it lists no tools. It stops",
  "when Octant ends the grant, and exits with a non-zero status.",
  "",
].join("\n");

const GRANT_ENDED_MESSAGE =
  "Octant ended this terminal's Browser grant, so the Browser is no longer available here.";
const HOST_UNREACHABLE_MESSAGE =
  "Octant is no longer answering for this terminal's Browser grant, so the Browser is no " +
  "longer available here.";

const SUPPORTED_PROTOCOL_VERSION = "2025-06-18";
const UNAUTHORIZED_TEXT = '{"error":"unauthorized"}';
const SESSION_CLOSE_TIMEOUT_MS = 1_000;

/** What the two variables resolve to; the endpoint exists only for a usable grant. */
export type BrowserGrantResolution =
  | { readonly kind: "granted"; readonly endpoint: BrowserGrantEndpoint }
  | { readonly kind: "no-grant"; readonly reason: "missing" | "not-loopback" };

export interface BrowserGrantEndpoint {
  readonly port: number;
  /** Secret: the path alone locates the grant's endpoint. */
  readonly path: string;
  readonly token: string;
}

/**
 * Both variables must be present and non-empty, and the address must be plain
 * `http://127.0.0.1:<port>/...`. The variables are settable by anything in the
 * shell, so any other host, scheme, or embedded credential is refused rather
 * than trusted with the bearer token.
 */
export function resolveBrowserGrant(
  environment: Readonly<Record<string, string | undefined>>,
): BrowserGrantResolution {
  const address = environment[TERMINAL_BROWSER_ENDPOINT_ENVIRONMENT]?.trim() ?? "";
  const token = environment[TERMINAL_BROWSER_TOKEN_ENVIRONMENT]?.trim() ?? "";
  if (address === "" || token === "") return { kind: "no-grant", reason: "missing" };
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { kind: "no-grant", reason: "not-loopback" };
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port === "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    url.pathname === "/"
  ) {
    return { kind: "no-grant", reason: "not-loopback" };
  }
  return { kind: "granted", endpoint: { port, path: `${url.pathname}${url.search}`, token } };
}

export interface McpCommandPorts {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The calling CLI's messages, one JSON message per line. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Protocol frames only. */
  readonly stdout: { readonly write: (chunk: string) => unknown };
  /** Everything a person should read. */
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

type JsonObject = Readonly<Record<string, unknown>>;
type JsonRpcId = string | number;

/**
 * Runs until the caller closes its input or the host ends the grant. Returns 0
 * when the caller ended a live grant's session, and 1 when there was no usable
 * grant or the host ended it.
 */
export async function runMcpCommand(ports: McpCommandPorts): Promise<number> {
  const resolution = resolveBrowserGrant(ports.environment);
  if (resolution.kind === "no-grant") {
    ports.stderr.write(`${NO_BROWSER_GRANT_MESSAGE}\n`);
    for await (const message of messagesFrom(ports.input)) {
      const answer = answerWithoutGrant(message);
      if (answer !== undefined) ports.stdout.write(`${JSON.stringify(answer)}\n`);
    }
    return 1;
  }
  return pipeToHost(resolution.endpoint, ports);
}

/**
 * `octant mcp` as typed: its arguments are only `--help`. Shared by the full
 * command and the launcher the desktop app puts on a terminal's `PATH`, so both
 * answer a stray argument the same way.
 */
export async function runMcpCliCommand(
  args: ReadonlyArray<string>,
  ports: McpCommandPorts,
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    ports.stdout.write(MCP_COMMAND_HELP);
    return 0;
  }
  if (args.length > 0) {
    // stdout carries protocol frames only.
    ports.stderr.write("octant mcp takes no arguments. Run `octant mcp --help`.\n");
    return 1;
  }
  return await runMcpCommand(ports);
}

function answerWithoutGrant(message: ParsedMessage): JsonObject | undefined {
  if (message.kind === "malformed") return message.answer;
  const { id, method, params } = message;
  if (id === undefined) return undefined;
  switch (method) {
    case "initialize":
      return result(id, {
        protocolVersion:
          typeof params?.["protocolVersion"] === "string"
            ? params["protocolVersion"]
            : SUPPORTED_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "octant", version: "1" },
        instructions: NO_BROWSER_GRANT_MESSAGE,
      });
    case "tools/list":
      return result(id, { tools: [] });
    case "tools/call":
      return result(id, {
        content: [{ type: "text", text: NO_BROWSER_GRANT_MESSAGE }],
        isError: true,
      });
    case "ping":
      return result(id, {});
    default:
      return failure(id, -32601, "Method not found");
  }
}

async function pipeToHost(endpoint: BrowserGrantEndpoint, ports: McpCommandPorts): Promise<number> {
  const aborted = new AbortController();
  /** Requests the caller is still waiting on, by id, with the method it asked. */
  const pending = new Map<string, { readonly id: JsonRpcId; readonly method: string }>();
  const inFlight = new Set<Promise<void>>();
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let ended = false;
  let resolveEnded!: () => void;
  const endedSignal = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  const write = (message: JsonObject) => {
    ports.stdout.write(`${JSON.stringify(message)}\n`);
  };

  // The grant is over: every call the caller is waiting on is refused, then
  // the command stops. The host's answer is never retried.
  const endGrant = (reason: string) => {
    if (ended) return;
    ended = true;
    for (const waiting of pending.values()) write(refusal(waiting.id, waiting.method));
    pending.clear();
    ports.stderr.write(`${reason}\n`);
    aborted.abort();
    resolveEnded();
  };

  const deliver = (message: JsonObject) => {
    if (ended) return;
    const id = responseId(message);
    const waiting = id === undefined ? undefined : pending.get(idKey(id));
    if (id !== undefined && waiting !== undefined) {
      pending.delete(idKey(id));
      if (waiting.method === "initialize") {
        const version = asObject(message["result"])?.["protocolVersion"];
        if (typeof version === "string") protocolVersion = version;
      }
    }
    write(message);
    if (isUnauthorizedAnswer(message)) endGrant(GRANT_ENDED_MESSAGE);
  };

  const forward = async (message: Extract<ParsedMessage, { kind: "message" }>) => {
    const { id, method, body } = message;
    const waiting = id !== undefined && method !== undefined;
    if (waiting) pending.set(idKey(id), { id, method });
    const exchange = await postToHost(endpoint, {
      body,
      sessionId,
      protocolVersion,
      signal: aborted.signal,
      onMessage: deliver,
    });
    if (ended) return;
    if (exchange.kind === "unreachable" || (exchange.kind === "refused" && isGrantOver(exchange))) {
      endGrant(exchange.kind === "unreachable" ? HOST_UNREACHABLE_MESSAGE : GRANT_ENDED_MESSAGE);
      return;
    }
    if (exchange.kind === "answered" && exchange.sessionId !== undefined) {
      sessionId ??= exchange.sessionId;
    }
    if (waiting && pending.has(idKey(id))) {
      // The host did not answer a request it accepted; the caller must not wait forever.
      pending.delete(idKey(id));
      write(failure(id, -32603, "Octant could not answer this request."));
    }
  };

  const readInput = async () => {
    // Nothing follows `initialize` until the host has answered it: the session
    // id and protocol version in its answer belong on every later request.
    let handshake: Promise<void> | undefined;
    for await (const message of messagesFrom(ports.input)) {
      await handshake;
      if (ended) return;
      if (message.kind === "malformed") {
        write(message.answer);
        continue;
      }
      const running = forward(message);
      if (message.method === "initialize") handshake = running;
      inFlight.add(running);
      void running.finally(() => inFlight.delete(running));
    }
    // The caller closed its input: let the calls it made finish, then leave.
    await Promise.all(inFlight);
  };

  await Promise.race([readInput(), endedSignal]);
  if (ended) return 1;
  if (sessionId !== undefined) await closeHostSession(endpoint, sessionId);
  return 0;
}

type HostExchange =
  | { readonly kind: "answered"; readonly sessionId: string | undefined }
  | { readonly kind: "refused"; readonly status: number }
  | { readonly kind: "unreachable" };

/**
 * The endpoint answers 404 for a wrong, closed, or unknown grant and 401 or
 * 403 for a refused credential; all of them mean this terminal's grant is over.
 */
function isGrantOver(exchange: { readonly status: number }): boolean {
  return exchange.status === 401 || exchange.status === 403 || exchange.status === 404;
}

function postToHost(
  endpoint: BrowserGrantEndpoint,
  input: {
    readonly body: string;
    readonly sessionId: string | undefined;
    readonly protocolVersion: string | undefined;
    readonly signal: AbortSignal;
    readonly onMessage: (message: JsonObject) => void;
  },
): Promise<HostExchange> {
  return new Promise((resolve) => {
    // Node's own client, with no agent, redirect following, or proxy: the
    // bearer token goes to the loopback address and nowhere else.
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        path: endpoint.path,
        method: "POST",
        agent: false,
        signal: input.signal,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(input.body),
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${endpoint.token}`,
          ...(input.sessionId === undefined ? {} : { "mcp-session-id": input.sessionId }),
          ...(input.protocolVersion === undefined
            ? {}
            : { "mcp-protocol-version": input.protocolVersion }),
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          response.once("end", () => resolve({ kind: "refused", status }));
          return;
        }
        const header = response.headers["mcp-session-id"];
        const sessionId = typeof header === "string" ? header : undefined;
        const stream = response.headers["content-type"]?.includes("text/event-stream") === true;
        const reader = stream
          ? serverSentMessages(input.onMessage)
          : wholeBodyMessage(input.onMessage);
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => reader.push(chunk));
        response.once("end", () => {
          reader.end();
          resolve({ kind: "answered", sessionId });
        });
        response.once("error", () => resolve({ kind: "unreachable" }));
      },
    );
    request.once("error", () => resolve({ kind: "unreachable" }));
    request.end(input.body);
  });
}

/** Releases the endpoint's session slot; the grant may already be over, which is fine. */
function closeHostSession(endpoint: BrowserGrantEndpoint, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        path: endpoint.path,
        method: "DELETE",
        agent: false,
        signal: AbortSignal.timeout(SESSION_CLOSE_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          "mcp-session-id": sessionId,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve());
        response.once("error", () => resolve());
      },
    );
    request.once("error", () => resolve());
    request.end();
  });
}

interface BodyReader {
  readonly push: (chunk: string) => void;
  readonly end: () => void;
}

function wholeBodyMessage(onMessage: (message: JsonObject) => void): BodyReader {
  let body = "";
  return {
    push: (chunk) => {
      body += chunk;
    },
    end: () => {
      const message = parseObject(body);
      if (message !== undefined) onMessage(message);
    },
  };
}

/** Each server-sent event's data is one JSON message, delivered as it arrives. */
function serverSentMessages(onMessage: (message: JsonObject) => void): BodyReader {
  let buffer = "";
  const flushEvent = (event: string) => {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    const message = parseObject(data);
    if (message !== undefined) onMessage(message);
  };
  return {
    push: (chunk) => {
      buffer = (buffer + chunk).replaceAll("\r\n", "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        flushEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    },
    end: () => {
      if (buffer.trim() !== "") flushEvent(buffer);
      buffer = "";
    },
  };
}

type ParsedMessage =
  | {
      readonly kind: "message";
      readonly body: string;
      readonly id: JsonRpcId | undefined;
      readonly method: string | undefined;
      readonly params: JsonObject | undefined;
    }
  | { readonly kind: "malformed"; readonly answer: JsonObject };

async function* messagesFrom(input: AsyncIterable<string | Uint8Array>) {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of input) {
    buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const parsed = parseLine(line);
      if (parsed !== undefined) yield parsed;
    }
  }
  const last = parseLine(buffered + decoder.decode());
  if (last !== undefined) yield last;
}

function parseLine(line: string): ParsedMessage | undefined {
  if (line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "malformed", answer: failure(null, -32700, "Parse error") };
  }
  const object = asObject(value);
  if (object === undefined) {
    return { kind: "malformed", answer: failure(null, -32600, "Invalid Request") };
  }
  const id = object["id"];
  const method = object["method"];
  return {
    kind: "message",
    body: JSON.stringify(object),
    id: typeof id === "string" || typeof id === "number" ? id : undefined,
    method: typeof method === "string" ? method : undefined,
    params: asObject(object["params"]),
  };
}

function parseObject(text: string): JsonObject | undefined {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function responseId(message: JsonObject): JsonRpcId | undefined {
  const id = message["id"];
  const answer = "result" in message || "error" in message;
  return answer && (typeof id === "string" || typeof id === "number") ? id : undefined;
}

/** The host's own refusal of a call, as it travels inside an MCP tool result. */
function isUnauthorizedAnswer(message: JsonObject): boolean {
  const answer = asObject(message["result"]);
  if (answer?.["isError"] !== true || !Array.isArray(answer["content"])) return false;
  return answer["content"].some((part) => {
    const text = asObject(part)?.["text"];
    return typeof text === "string" && parseObject(text)?.["error"] === "unauthorized";
  });
}

function result(id: JsonRpcId, value: JsonObject): JsonObject {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: JsonRpcId | null, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** What a call the host can no longer answer looks like to the caller: refused `unauthorized`. */
function refusal(id: JsonRpcId, method: string): JsonObject {
  return method === "tools/call"
    ? result(id, { content: [{ type: "text", text: UNAUTHORIZED_TEXT }], isError: true })
    : failure(id, -32001, "unauthorized");
}
