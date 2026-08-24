import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { deriveTransportFactsFromPeer } from "./remoteRequestFacts";
import { MAX_CHAT_ATTACHMENT_BYTES, type OctantServer, type RequestTransportFacts } from "./server";
import type { PrivateListenerTls } from "./privateListener";

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

function resolveRequestUrl(
  incoming: IncomingMessage,
  listenerUrl: URL,
  configuredHostname: string,
): string {
  const hostHeader = incoming.headers.host;
  if (
    typeof hostHeader !== "string" ||
    hostHeader.length === 0 ||
    hostHeader.trim() !== hostHeader
  ) {
    throw new InvalidRequestHost();
  }

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${listenerUrl.protocol}//${hostHeader}/`);
  } catch {
    throw new InvalidRequestHost();
  }
  if (
    hostUrl.username !== "" ||
    hostUrl.password !== "" ||
    hostUrl.pathname !== "/" ||
    hostUrl.search !== "" ||
    hostUrl.hash !== "" ||
    !hostMatchesListener(hostUrl.hostname, hostUrl.port, listenerUrl, configuredHostname)
  ) {
    throw new InvalidRequestHost();
  }

  const target = incoming.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) throw new InvalidRequestHost();
  return new URL(target, `${listenerUrl.protocol}//${hostHeader}/`).toString();
}

function hostMatchesListener(
  hostname: string,
  port: string,
  listenerUrl: URL,
  configuredHostname: string,
): boolean {
  const listenerHostname = normalizeHostname(listenerUrl.hostname);
  const configured = normalizeHostname(configuredHostname);
  const requestHostname = normalizeHostname(hostname);
  const hostMatches =
    requestHostname === listenerHostname ||
    requestHostname === configured ||
    (isLoopbackHostname(requestHostname) &&
      (isLoopbackHostname(listenerHostname) || isLoopbackHostname(configured)));
  if (!hostMatches) return false;
  const listenerPort =
    listenerUrl.port === "" ? defaultPort(listenerUrl.protocol) : listenerUrl.port;
  const requestPort = port === "" ? defaultPort(listenerUrl.protocol) : port;
  return requestPort === listenerPort;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
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
