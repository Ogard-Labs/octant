import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { REMOTE_SERVER_PROXY_RELAYED, REMOTE_SERVER_PROXY_RELAYED_HEADER } from "@octant/contracts";
import { relayResponseHeaders, type RemoteServerRelayHeader } from "@octant/domain";
import { webSocketAcceptFor } from "../webSocketRelay";

/** The upstream connection's own bounds; the request body's is the route's. */
export interface RemoteServerRelayLimits {
  /** Past this without a connection the dev server counts as unreachable. */
  readonly connectTimeoutMs: number;
  /** A connection with no byte from the dev server for this long is closed. */
  readonly idleTimeoutMs: number;
}

export const DEFAULT_REMOTE_SERVER_RELAY_LIMITS: RemoteServerRelayLimits = {
  connectTimeoutMs: 5_000,
  idleTimeoutMs: 5 * 60_000,
};

export interface RemoteServerRelayRequest {
  readonly method: string;
  /** The dev server's own path and query, exactly as the page asked for it. */
  readonly pathQuery: string;
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  readonly body: Uint8Array | undefined;
}

export interface RemoteServerRelayInput {
  /** The loopback URL the grant was minted for; the only place this connects. */
  readonly endpointUrl: string;
  readonly request: RemoteServerRelayRequest;
  /**
   * Asked with the SHA-256 of an HTTPS dev server's certificate before any
   * request byte is sent; `false` closes the connection unused.
   */
  readonly acceptCertificate: (fingerprint: string) => boolean;
  /** Aborting it closes the upstream socket and errors the relayed body. */
  readonly signal: AbortSignal;
  /** Called once, when the relayed body ends, fails, or is cancelled. */
  readonly onSettled: () => void;
  readonly limits: RemoteServerRelayLimits;
}

export type RemoteServerRelayAttempt =
  | { readonly kind: "responded"; readonly response: Response }
  | { readonly kind: "unreachable" }
  | { readonly kind: "certificate-changed" }
  | { readonly kind: "aborted" };

interface LoopbackTarget {
  readonly scheme: "http" | "https";
  readonly host: "127.0.0.1" | "::1";
  readonly port: number;
}

/**
 * Relay one request to a dev server on this host's loopback.
 *
 * The connection goes to the IP literal and port of the grant's endpoint and
 * nowhere else: the request's own target, `Host`, and any redirect the dev
 * server answers never choose where it connects, and no redirect is followed.
 * Each request gets its own connection, opened after the host re-checked the
 * grant, and the dev server is asked to close it after answering.
 *
 * An HTTPS dev server's certificate is not verified against a trust store
 * (a dev server's is self-signed); the caller pins the first one it sees for
 * the grant's life and refuses any other.
 *
 * The response streams back unmodified apart from its headers, with no size
 * cap, until the dev server finishes, falls silent for the idle bound, or the
 * signal aborts.
 */
export async function relayToDevServer(
  input: RemoteServerRelayInput,
): Promise<RemoteServerRelayAttempt> {
  const target = loopbackTarget(input.endpointUrl);
  if (target === undefined) return settledWith(input, { kind: "unreachable" });
  if (input.signal.aborted) return settledWith(input, { kind: "aborted" });

  let socket: Socket | TLSSocket;
  try {
    socket = await connect(target, input.limits.connectTimeoutMs, input.signal);
  } catch {
    return settledWith(input, { kind: input.signal.aborted ? "aborted" : "unreachable" });
  }
  if (target.scheme === "https") {
    const raw = (socket as TLSSocket).getPeerCertificate(true).raw;
    if (raw === undefined || !input.acceptCertificate(sha256(raw))) {
      socket.destroy();
      return settledWith(input, {
        kind: raw === undefined ? "unreachable" : "certificate-changed",
      });
    }
  }
  return exchange(socket, input);
}

function exchange(
  socket: Socket | TLSSocket,
  input: RemoteServerRelayInput,
): Promise<RemoteServerRelayAttempt> {
  const { request, signal } = input;
  return new Promise((resolve) => {
    // The request takes the socket's errors over once it is attached; until
    // then one must not escape as an unhandled error.
    socket.on("error", () => undefined);
    let answered = false;
    let settled = false;
    let fail: ((error: Error) => void) | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      socket.destroy();
      input.onSettled();
    };
    const refuse = (attempt: RemoteServerRelayAttempt) => {
      if (answered) return;
      answered = true;
      settle();
      resolve(attempt);
    };
    function onAbort() {
      if (!answered) {
        refuse({ kind: "aborted" });
        return;
      }
      fail?.(new Error("The grant this response travelled under closed."));
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.setTimeout(input.limits.idleTimeoutMs, () => {
      if (!answered) refuse({ kind: "unreachable" });
      else fail?.(new Error("The dev server sent nothing within the idle bound."));
    });

    const upstream = httpRequest({
      method: request.method,
      path: request.pathQuery,
      setHost: false,
      headers: nodeHeaders(request.headers),
      createConnection: () => socket,
    });
    upstream.on("error", () => {
      if (!answered) refuse({ kind: "unreachable" });
      else fail?.(new Error("The dev server's connection failed."));
    });
    // Nothing here asked to upgrade, so a switch of protocol is a broken answer.
    upstream.on("upgrade", () => refuse({ kind: "unreachable" }));
    upstream.on("response", (response) => {
      if (answered) {
        response.destroy();
        return;
      }
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        refuse({ kind: "unreachable" });
        return;
      }
      answered = true;
      const relayed = relayedResponse(response, status, request.method, settle, (failWith) => {
        fail = failWith;
      });
      resolve({ kind: "responded", response: relayed });
    });
    if (signal.aborted) {
      onAbort();
      return;
    }
    upstream.end(request.body === undefined ? undefined : Buffer.from(request.body));
  });
}

/** The most of a dev server's handshake answer the host reads before giving up on it. */
const MAX_HANDSHAKE_ANSWER_BYTES = 16 * 1024;

export interface RemoteServerWebSocketInput {
  /** The loopback URL the grant was minted for; the only place this connects. */
  readonly endpointUrl: string;
  /** The dev server's own path and query. */
  readonly pathQuery: string;
  /** The handshake's headers, already made the host's own, with this key. */
  readonly headers: ReadonlyArray<RemoteServerRelayHeader>;
  readonly key: string;
  /** The subprotocols the page offered; the dev server may choose only one of these. */
  readonly protocols: ReadonlyArray<string>;
  readonly acceptCertificate: (fingerprint: string) => boolean;
  /** Aborting it before the handshake ends closes the connection unused. */
  readonly signal: AbortSignal;
  readonly limits: RemoteServerRelayLimits;
}

export type RemoteServerWebSocketAttempt =
  | {
      readonly kind: "opened";
      readonly socket: Socket | TLSSocket;
      /** Bytes the dev server sent after its handshake answer: its first frames. */
      readonly head: Uint8Array;
      readonly protocol: string | undefined;
    }
  /** The dev server answered, but not with a WebSocket the host can relay. */
  | { readonly kind: "declined" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "certificate-changed" }
  | { readonly kind: "aborted" };

/**
 * Open a WebSocket to a dev server on this host's loopback, for a page's
 * upgrade the host has accepted under a grant. Like {@link relayToDevServer},
 * it connects to the grant's endpoint literal and nowhere else, and pins an
 * HTTPS dev server's certificate. The dev server must answer 101 with the
 * accept value for the host's own key, no extension, and either no
 * subprotocol or one the page offered; any other answer is declined and the
 * connection closed. The whole answer must arrive within the connect bound.
 */
export async function openDevServerWebSocket(
  input: RemoteServerWebSocketInput,
): Promise<RemoteServerWebSocketAttempt> {
  const target = loopbackTarget(input.endpointUrl);
  if (target === undefined) return { kind: "unreachable" };
  if (input.signal.aborted) return { kind: "aborted" };
  // The handshake is written by hand, so nothing in it may end a line early.
  if (
    !/^\/[!-~]*$/.test(input.pathQuery) ||
    input.headers.some(
      ([name, value]) =>
        !/^[!-9;-~]+$/.test(name) || /[\r\n]/.test(value) || value.includes("\u0000"),
    )
  ) {
    return { kind: "declined" };
  }
  let socket: Socket | TLSSocket;
  try {
    socket = await connect(target, input.limits.connectTimeoutMs, input.signal);
  } catch {
    return { kind: input.signal.aborted ? "aborted" : "unreachable" };
  }
  if (target.scheme === "https") {
    const raw = (socket as TLSSocket).getPeerCertificate(true).raw;
    if (raw === undefined || !input.acceptCertificate(sha256(raw))) {
      socket.destroy();
      return { kind: raw === undefined ? "unreachable" : "certificate-changed" };
    }
  }
  return handshake(socket, input);
}

function handshake(
  socket: Socket | TLSSocket,
  input: RemoteServerWebSocketInput,
): Promise<RemoteServerWebSocketAttempt> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const finish = (attempt: RemoteServerWebSocketAttempt) => {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
      socket.off("data", onData);
      socket.off("close", onClose);
      if (attempt.kind === "opened") socket.pause();
      else socket.destroy();
      resolve(attempt);
    };
    const onAbort = () => finish({ kind: "aborted" });
    const onClose = () => finish({ kind: "unreachable" });
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf("\r\n\r\n");
      if (end < 0) {
        if (received.byteLength > MAX_HANDSHAKE_ANSWER_BYTES) finish({ kind: "declined" });
        return;
      }
      const answer = parseHandshakeAnswer(received.subarray(0, end).toString("latin1"));
      const protocol = answer.headers.get("sec-websocket-protocol");
      const opened =
        answer.status === 101 &&
        answer.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        answer.headers.get("sec-websocket-accept") === webSocketAcceptFor(input.key) &&
        !answer.headers.has("sec-websocket-extensions") &&
        (protocol === undefined || input.protocols.includes(protocol));
      finish(
        opened
          ? {
              kind: "opened",
              socket,
              head: Uint8Array.from(received.subarray(end + 4)),
              protocol,
            }
          : { kind: "declined" },
      );
    };
    const timer = setTimeout(() => finish({ kind: "unreachable" }), input.limits.connectTimeoutMs);
    socket.on("error", () => undefined);
    socket.on("data", onData);
    socket.once("close", onClose);
    input.signal.addEventListener("abort", onAbort, { once: true });
    if (input.signal.aborted) {
      onAbort();
      return;
    }
    const lines = [`GET ${input.pathQuery} HTTP/1.1`];
    for (const [name, value] of input.headers) lines.push(`${name}: ${value}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

function parseHandshakeAnswer(text: string): {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
} {
  const [statusLine = "", ...fields] = text.split("\r\n");
  const status = /^HTTP\/1\.1 (\d{3})(?: |$)/.exec(statusLine)?.[1];
  const headers = new Map<string, string>();
  for (const field of fields) {
    const colon = field.indexOf(":");
    if (colon <= 0) continue;
    const name = field.slice(0, colon).trim().toLowerCase();
    const value = field.slice(colon + 1).trim();
    const existing = headers.get(name);
    headers.set(name, existing === undefined ? value : `${existing}, ${value}`);
  }
  return { status: status === undefined ? 0 : Number(status), headers };
}

/** Statuses and methods whose response has no body to relay. */
function hasNoBody(method: string, status: number): boolean {
  return method === "HEAD" || status === 204 || status === 205 || status === 304;
}

function relayedResponse(
  response: IncomingMessage,
  status: number,
  method: string,
  settle: () => void,
  setFail: (fail: (error: Error) => void) => void,
): Response {
  const headers = new Headers();
  const pairs: RemoteServerRelayHeader[] = [];
  for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
    pairs.push([response.rawHeaders[index] ?? "", response.rawHeaders[index + 1] ?? ""]);
  }
  for (const [name, value] of relayResponseHeaders(pairs)) {
    try {
      headers.append(name, value);
    } catch {
      // A header the platform cannot represent is left out rather than
      // failing the whole response.
    }
  }
  headers.set(REMOTE_SERVER_PROXY_RELAYED_HEADER, REMOTE_SERVER_PROXY_RELAYED);

  let body: ReadableStream<Uint8Array> | null = null;
  if (hasNoBody(method, status)) {
    setFail(() => settle());
    response.resume();
    response.once("close", settle);
  } else {
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        let done = false;
        const finish = (end: () => void) => {
          if (done) return;
          done = true;
          settle();
          try {
            end();
          } catch {
            // The reader already went away.
          }
        };
        setFail((error) => finish(() => controller.error(error)));
        response.on("data", (chunk: Buffer) => {
          if (done) return;
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 1) <= 0) response.pause();
        });
        response.once("end", () => finish(() => controller.close()));
        response.once("error", () =>
          finish(() => controller.error(new Error("The dev server's response failed."))),
        );
        response.once("close", () => {
          if (!response.complete) {
            finish(() => controller.error(new Error("The dev server's response was cut short.")));
          }
        });
      },
      pull() {
        response.resume();
      },
      cancel() {
        settle();
      },
    });
  }
  try {
    return new Response(body, { status, statusText: response.statusMessage ?? "", headers });
  } catch {
    return new Response(body, { status, headers });
  }
}

/**
 * The grant's endpoint as an IP literal on this host's loopback, or nothing.
 * The listing only ever records `127.0.0.1` or `[::1]`, so anything else (a
 * name that resolves, another address) is refused rather than looked up.
 */
function loopbackTarget(endpointUrl: string): LoopbackTarget | undefined {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    return undefined;
  }
  const scheme =
    url.protocol === "http:" ? "http" : url.protocol === "https:" ? "https" : undefined;
  const host =
    url.hostname === "127.0.0.1" ? "127.0.0.1" : url.hostname === "[::1]" ? "::1" : undefined;
  const port = Number(url.port);
  if (scheme === undefined || host === undefined || !Number.isSafeInteger(port) || port <= 0) {
    return undefined;
  }
  return { scheme, host, port };
}

function connect(
  target: LoopbackTarget,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket =
      target.scheme === "https"
        ? tlsConnect({
            host: target.host,
            port: target.port,
            servername: "localhost",
            ALPNProtocols: ["http/1.1"],
            // Verified by the grant's pin instead; see relayToDevServer.
            rejectUnauthorized: false,
          })
        : netConnect({ host: target.host, port: target.port });
    const ready = target.scheme === "https" ? "secureConnect" : "connect";
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      socket.off(ready, onReady);
      socket.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => onError(new Error("aborted"));
    const timer = setTimeout(() => onError(new Error("connect timeout")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once(ready, onReady);
    socket.once("error", onError);
  });
}

export function nodeHeaders(headers: ReadonlyArray<RemoteServerRelayHeader>): OutgoingHttpHeaders {
  // No prototype: a header named `constructor` or `__proto__` is an ordinary
  // key here, never an inherited value or a prototype assignment.
  const result: Record<string, string | string[]> = Object.create(null);
  for (const [name, value] of headers) {
    const existing = result[name];
    if (existing === undefined) result[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[name] = [existing, value];
  }
  return result;
}

function settledWith(
  input: RemoteServerRelayInput,
  attempt: RemoteServerRelayAttempt,
): RemoteServerRelayAttempt {
  input.onSettled();
  return attempt;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
