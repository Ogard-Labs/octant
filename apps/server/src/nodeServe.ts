import { STATUS_CODES, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { parseListenerRequestHost, requestUrlStaysOnHost } from "./listenerRequestHost";
import { deriveTransportFactsFromPeer } from "./remoteRequestFacts";
import { MAX_CHAT_ATTACHMENT_BYTES, type OctantServer, type RequestTransportFacts } from "./server";
import type { PrivateListenerTls } from "./privateListener";
import {
  WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
  WebSocketEndpoint,
  isWebSocketKey,
  takeWebSocketUpgrade,
  webSocketAcceptFor,
} from "./webSocketRelay";

export interface NodeServeOptions {
  readonly hostname: string;
  readonly port: number;
  readonly maxRequestBodySize?: number;
  readonly listenerTrust?: "loopback" | "remote";
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Response | Promise<Response>;
  readonly tls?: PrivateListenerTls;
}

class RequestBodyTooLarge extends Error {}
class InvalidRequestHost extends Error {}

export async function nodeServe(options: NodeServeOptions): Promise<OctantServer> {
  let baseUrl: URL | undefined;
  const activeBridges = new Set<() => void>();
  const activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const listenerTrust = options.listenerTrust ?? "loopback";
  const requestHandler = (incoming: IncomingMessage, outgoing: ServerResponse) => {
    void bridgeRequest(
      incoming,
      outgoing,
      options.fetch,
      baseUrl,
      options.hostname,
      listenerTrust,
      options.maxRequestBodySize ?? MAX_CHAT_ATTACHMENT_BYTES,
      activeBridges,
      activeReaders,
    ).catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end("Octant could not handle the local request.");
    });
  };
  const server =
    options.tls === undefined
      ? createServer(requestHandler)
      : createHttpsServer(options.tls, requestHandler);
  // Upgraded sockets leave the HTTP server's own connection list, so stopping
  // the server closes them from here.
  const upgradedSockets = new Set<Socket>();
  server.on("upgrade", (incoming: IncomingMessage, socket: Socket, head: Buffer) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    void bridgeUpgrade(
      incoming,
      socket,
      head,
      options.fetch,
      baseUrl,
      options.hostname,
      listenerTrust,
    ).catch(() => socket.destroy());
  });

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
    server.listen(options.port, options.hostname);
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    await closeServer(server);
    throw new Error("Octant Node server did not expose its listening address.");
  }
  baseUrl = new URL(
    `${options.tls === undefined ? "http" : "https"}://${formatHostname(address.address)}:${address.port}/`,
  );

  return {
    url: baseUrl,
    stop: async (closeActiveConnections = false) => {
      for (const cancel of activeBridges) cancel();
      activeBridges.clear();
      for (const reader of activeReaders) {
        await reader.cancel().catch(() => undefined);
      }
      activeReaders.clear();
      const closed = closeServer(server);
      if (closeActiveConnections) server.closeAllConnections();
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      await closed;
    },
  };
}

async function bridgeRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  handler: NodeServeOptions["fetch"],
  baseUrl: URL | undefined,
  configuredHostname: string,
  listenerTrust: "loopback" | "remote",
  maxRequestBodySize: number,
  activeBridges: Set<() => void>,
  activeReaders: Set<ReadableStreamDefaultReader<Uint8Array>>,
): Promise<void> {
  if (baseUrl === undefined) throw new Error("Octant Node server is not ready.");
  let requestUrl: string;
  try {
    requestUrl = resolveRequestUrl(incoming, baseUrl, configuredHostname);
  } catch (error) {
    if (error instanceof InvalidRequestHost) {
      respondInvalidHost(outgoing);
      return;
    }
    throw error;
  }
  const method = incoming.method ?? "GET";
  if (safeMethodDeclaresBody(incoming)) {
    respondPayloadTooLarge(incoming, outgoing);
    return;
  }
  if (declaredBodyExceedsLimit(incoming, maxRequestBodySize)) {
    respondPayloadTooLarge(incoming, outgoing);
    return;
  }
  let receivedBody: Buffer;
  try {
    receivedBody = await readBody(incoming, maxRequestBodySize);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      respondPayloadTooLarge(incoming, outgoing);
      return;
    }
    throw error;
  }
  const body = method === "GET" || method === "HEAD" ? undefined : Uint8Array.from(receivedBody);
  const abortController = new AbortController();
  const cancelBridge = () => abortController.abort();
  const unregister = () => {
    activeBridges.delete(cancelBridge);
    incoming.off("aborted", cancelBridge);
    incoming.off("close", cancelBridge);
    outgoing.off("close", cancelBridge);
  };
  activeBridges.add(cancelBridge);
  incoming.once("aborted", cancelBridge);
  incoming.once("close", cancelBridge);
  outgoing.once("close", cancelBridge);
  try {
    const facts = deriveTransportFactsFromPeer({
      peerAddress: incoming.socket?.remoteAddress,
      listenerTrust,
    });
    const response = await handler(
      new Request(requestUrl, {
        method,
        headers: requestHeaders(incoming),
        signal: abortController.signal,
        ...(body === undefined ? {} : { body }),
      }),
      facts,
    );
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });
    outgoing.writeHead(response.status, headers);
    if (method === "HEAD" || response.body === null) {
      // HEAD discards any response body: cancel the upstream reader to release
      // admission and transport resources that the body's lifecycle would
      // otherwise hold.
      if (response.body !== null) {
        response.body.cancel().catch(() => undefined);
      }
      outgoing.end();
      return;
    }
    const reader = response.body.getReader();
    activeReaders.add(reader);
    try {
      for (;;) {
        if (abortController.signal.aborted) {
          await reader.cancel();
          return;
        }
        const next = await readChunk(reader, abortController.signal);
        if (next.done) break;
        if (!outgoing.write(Buffer.from(next.value))) {
          await waitForDrainOrAbort(outgoing, abortController.signal);
          if (abortController.signal.aborted) {
            await reader.cancel();
            return;
          }
        }
      }
      outgoing.end();
    } catch {
      await reader.cancel();
      if (!outgoing.writableEnded) outgoing.destroy();
    } finally {
      activeReaders.delete(reader);
    }
  } finally {
    unregister();
  }
}

/**
 * A request that asks to switch protocols goes through the same fetch handler
 * as any other. Only an answer carrying an accepted WebSocket upgrade switches
 * the socket; every other answer is written as plain HTTP and the socket is
 * closed after it, so a route that does not accept upgrades refuses them by
 * answering as it always does.
 */
async function bridgeUpgrade(
  incoming: IncomingMessage,
  socket: Socket,
  head: Buffer,
  handler: NodeServeOptions["fetch"],
  baseUrl: URL | undefined,
  configuredHostname: string,
  listenerTrust: "loopback" | "remote",
): Promise<void> {
  socket.on("error", () => undefined);
  if (baseUrl === undefined) throw new Error("Octant Node server is not ready.");
  let requestUrl: string;
  try {
    requestUrl = resolveRequestUrl(incoming, baseUrl, configuredHostname);
  } catch (error) {
    if (!(error instanceof InvalidRequestHost)) throw error;
    await writeRawResponse(socket, new Response("Invalid Host header", { status: 400 }), "GET");
    return;
  }
  const method = incoming.method ?? "GET";
  if (safeMethodDeclaresBody(incoming)) {
    await writeRawResponse(socket, new Response("Request body too large", { status: 413 }), method);
    return;
  }
  if (method !== "GET") {
    await writeRawResponse(socket, new Response("Upgrade needs a GET", { status: 400 }), method);
    return;
  }
  // The handshake has no body, and a client sends nothing more before the
  // answer, so the socket is not read until the upgrade is decided. A
  // connection that fails meanwhile aborts the request.
  socket.pause();
  const abortController = new AbortController();
  const onClose = () => abortController.abort();
  socket.once("close", onClose);
  let response: Response;
  try {
    response = await handler(
      new Request(requestUrl, {
        method,
        headers: requestHeaders(incoming),
        signal: abortController.signal,
      }),
      deriveTransportFactsFromPeer({ peerAddress: socket.remoteAddress, listenerTrust }),
    );
  } finally {
    socket.off("close", onClose);
  }
  const acceptance = takeWebSocketUpgrade(response);
  if (acceptance === undefined) {
    await writeRawResponse(socket, response, method);
    return;
  }
  const key = incoming.headers["sec-websocket-key"];
  if (
    socket.destroyed ||
    !isWebSocketKey(key) ||
    incoming.headers["sec-websocket-version"] !== "13"
  ) {
    acceptance.cancel();
    await writeRawResponse(
      socket,
      new Response("Bad WebSocket handshake", { status: 400 }),
      method,
    );
    return;
  }
  const lines = [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${webSocketAcceptFor(key)}`,
    ...(acceptance.protocol === undefined
      ? []
      : [`Sec-WebSocket-Protocol: ${acceptance.protocol}`]),
  ];
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  const client = new WebSocketEndpoint(socket, "server", WEBSOCKET_RELAY_MAX_MESSAGE_BYTES);
  client.start(acceptance.open(client), head);
}

/**
 * Write a fetch answer as HTTP/1.1 on a socket that will not be reused: the
 * body streams until it ends, and the end of the connection ends it.
 */
async function writeRawResponse(socket: Socket, response: Response, method: string): Promise<void> {
  if (socket.destroyed) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const lines = [`HTTP/1.1 ${response.status} ${STATUS_CODES[response.status] ?? ""}`];
  response.headers.forEach((value, name) => {
    if (name === "content-length" || name === "transfer-encoding" || name === "connection") return;
    lines.push(`${name}: ${value}`);
  });
  lines.push("connection: close");
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  if (method === "HEAD" || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    socket.end();
    return;
  }
  const reader = response.body.getReader();
  const onClose = () => void reader.cancel().catch(() => undefined);
  socket.once("close", onClose);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done || socket.destroyed) break;
      if (!socket.write(next.value)) {
        await new Promise<void>((resolve) => {
          socket.once("drain", resolve);
          socket.once("close", resolve);
        });
      }
    }
  } catch {
    // The answer failed midway; the connection ends with what was written.
  } finally {
    socket.off("close", onClose);
    socket.end();
  }
}

function resolveRequestUrl(
  incoming: IncomingMessage,
  listenerUrl: URL,
  configuredHostname: string,
): string {
  const hostHeader = incoming.headers.host;
  const hostUrl = parseListenerRequestHost(hostHeader, listenerUrl, configuredHostname);
  if (hostUrl === undefined) throw new InvalidRequestHost();

  const target = incoming.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) throw new InvalidRequestHost();
  const resolved = new URL(target, hostUrl);
  // The host header is validated above, but resolution can still carry the
  // request off it: URL treats a backslash like a slash for these schemes, so
  // `/\attacker.example/path` resolves exactly as `//attacker.example/path`
  // does and reaches the handler wearing somebody else's origin. Rather than
  // enumerate every separator a parser might accept, the resolved URL has to
  // land on the host that was checked.
  if (!requestUrlStaysOnHost(resolved, hostUrl)) throw new InvalidRequestHost();
  return resolved.toString();
}

async function readBody(incoming: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of incoming) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new RequestBodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function declaredBodyExceedsLimit(incoming: IncomingMessage, maxBytes: number): boolean {
  const value = incoming.headers["content-length"];
  if (value === undefined || !/^\d+$/.test(value)) return false;
  return BigInt(value) > BigInt(maxBytes);
}

function safeMethodDeclaresBody(incoming: IncomingMessage): boolean {
  const method = incoming.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") return false;
  const contentLength = incoming.headers["content-length"];
  const hasPositiveContentLength =
    contentLength !== undefined && /^\d+$/.test(contentLength) && BigInt(contentLength) > 0n;
  return hasPositiveContentLength || !!incoming.headers["transfer-encoding"];
}

function respondPayloadTooLarge(incoming: IncomingMessage, outgoing: ServerResponse): void {
  outgoing.writeHead(413, {
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  outgoing.end("Request body too large", () => incoming.destroy());
}

function respondInvalidHost(outgoing: ServerResponse): void {
  outgoing.writeHead(400, {
    connection: "close",
    "content-type": "text/plain; charset=utf-8",
  });
  outgoing.end("Invalid Host header");
}

function requestHeaders(incoming: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function formatHostname(hostname: string): string {
  return hostname.includes(":") ? `[${hostname}]` : hostname;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortSignal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (abortSignal.aborted) {
    await reader.cancel();
    return { done: true, value: undefined as undefined };
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    const onAbort = () => {
      abortSignal.removeEventListener("abort", onAbort);
      reader.cancel().then(
        () => resolve({ done: true, value: undefined as undefined }),
        (error) => reject(error),
      );
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        abortSignal.removeEventListener("abort", onAbort);
        resolve(result as ReadableStreamReadResult<Uint8Array>);
      },
      (error) => {
        abortSignal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function waitForDrainOrAbort(
  outgoing: ServerResponse,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      outgoing.off("drain", onDrain);
      abortSignal.removeEventListener("abort", onAbort);
      resolve();
    };
    const onDrain = () => finish();
    const onAbort = () => finish();
    outgoing.once("drain", onDrain);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}
