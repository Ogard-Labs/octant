// The hub's public entrance: a separate HTTP server, bound to loopback, that a
// front (Tailscale Funnel or the person's own tunnel) carries internet traffic
// to. It shares nothing with the private listener: its own server, its own
// closed route table, no cookie, no session, and no principal a private route
// would accept. Every request that reaches it came from the internet, even
// though Funnel delivers it from 127.0.0.1, so loopback means nothing here.

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import {
  PUBLIC_ENTRANCE_MAX_HEADER_BYTES,
  PUBLIC_ENTRANCE_REQUESTS_PER_MINUTE,
  PUBLIC_FORWARD_MAX_BODY_BYTES,
  type PublicForwardAnswer,
  type PublicForwardEnvelope,
} from "@octant/contracts";

export type PublicRouteName =
  | "visitor-page"
  | "visitor-asset"
  | "visitor-open"
  | "visitor-stream"
  | "visitor-comments"
  | "webhook"
  | "relay"
  | "health";

export type PublicRouteMatch =
  | {
      readonly status: "route";
      readonly name: PublicRouteName;
      readonly params: { readonly id?: string; readonly asset?: string };
    }
  | { readonly status: "method-not-allowed"; readonly allow: string }
  | { readonly status: "not-found" };

const ID = "([A-Za-z0-9_-]{22})";
const TABLE: ReadonlyArray<{
  readonly name: PublicRouteName;
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
}> = [
  { name: "visitor-asset", method: "GET", pattern: /^\/v\/_\/([0-9a-f]{8,64}\.(?:js|css))$/ },
  { name: "visitor-page", method: "GET", pattern: new RegExp(`^/v/${ID}$`) },
  { name: "visitor-open", method: "POST", pattern: new RegExp(`^/v/${ID}/open$`) },
  { name: "visitor-stream", method: "GET", pattern: new RegExp(`^/v/${ID}/stream$`) },
  { name: "visitor-comments", method: "POST", pattern: new RegExp(`^/v/${ID}/comments$`) },
  { name: "webhook", method: "POST", pattern: new RegExp(`^/hooks/${ID}$`) },
  { name: "relay", method: "GET", pattern: /^\/relay\/v1$/ },
  { name: "health", method: "GET", pattern: /^\/healthz$/ },
];

/**
 * The closed route table. A path outside it is not found, whatever the method;
 * a path in it with another method is refused with the one method it takes.
 */
export function matchPublicRoute(method: string, path: string): PublicRouteMatch {
  for (const entry of TABLE) {
    const found = entry.pattern.exec(path);
    if (found === null) continue;
    if (method !== entry.method) return { status: "method-not-allowed", allow: entry.method };
    const captured = found[1];
    return {
      status: "route",
      name: entry.name,
      params:
        captured === undefined
          ? {}
          : entry.name === "visitor-asset"
            ? { asset: captured }
            : { id: captured },
    };
  }
  return { status: "not-found" };
}

/** Who a public request is, for the journal and the handlers: never local, a device, or a member. */
export type PublicPrincipal =
  | { readonly kind: "visitor"; readonly linkId: string }
  | { readonly kind: "webhook"; readonly endpointId: string }
  | { readonly kind: "relay" }
  | { readonly kind: "anonymous" };

export type PublicBody =
  | { readonly status: "read"; readonly bytes: Buffer }
  | { readonly status: "too-large" }
  | { readonly status: "aborted" };

export interface PublicRequest {
  readonly route: PublicRouteName;
  readonly params: { readonly id?: string; readonly asset?: string };
  readonly method: string;
  readonly path: string;
  /** Lowercase names, without cookies, credentials, or forwarding claims. */
  readonly headers: ReadonlyMap<string, string>;
  readonly principal: PublicPrincipal;
  /** Reads the body up to a limit; a handler that never calls it never reads it. */
  readonly readBody: (maxBytes: number) => Promise<PublicBody>;
  /** Aborted when the client goes away or the entrance closes. */
  readonly signal: AbortSignal;
}

export interface PublicAnswer {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | ReadableStream<Uint8Array>;
}

export type PublicRouteHandler = (request: PublicRequest) => Promise<PublicAnswer>;

/**
 * What later features plug in. A feature that is off leaves its handler out,
 * and its routes answer 404 exactly as an unknown path does.
 */
export interface PublicEntranceHandlers {
  readonly visitorPage?: PublicRouteHandler;
  readonly visitorAsset?: PublicRouteHandler;
  readonly visitorOpen?: PublicRouteHandler;
  readonly visitorStream?: PublicRouteHandler;
  readonly visitorComments?: PublicRouteHandler;
  readonly webhook?: PublicRouteHandler;
  /** Takes over the raw connection after the WebSocket upgrade request. */
  readonly relay?: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
}

/**
 * Whether this host serves the entrance (it is the acting hub), hands each
 * request to the acting hub (it is a member that is not), or turns everything
 * away (paused, or neither).
 */
export type PublicEntranceRole = "serve" | "forward" | "closed";

export interface PublicEntranceOptions {
  /** 0 asks the system for a free port; the service saves what it got. */
  readonly port: number;
  readonly role: () => PublicEntranceRole;
  readonly handlers: PublicEntranceHandlers | (() => PublicEntranceHandlers);
  /** Hands an admitted request to the acting hub; undefined when it could not be reached. */
  readonly forward?: (envelope: PublicForwardEnvelope) => Promise<PublicForwardAnswer | undefined>;
  readonly requestsPerMinute?: number;
  readonly now?: () => number;
}

export interface PublicEntrance {
  readonly port: number;
  /** Runs a request another member's entrance forwarded, as if it had arrived here. */
  readonly dispatchForwarded: (envelope: PublicForwardEnvelope) => Promise<PublicForwardAnswer>;
  readonly close: () => Promise<void>;
}

const DROPPED_HEADERS = new Set([
  "cookie",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "x-real-ip",
  "connection",
  "keep-alive",
  "upgrade",
  "transfer-encoding",
  "te",
  "trailer",
  "host",
]);

const HARDENING: Readonly<Record<string, string>> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
};
const PAGE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const HEADER_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Room for every visitor stream and relay tunnel the caps allow, plus ordinary
// requests; a socket that never sends headers counts until its timeout.
const MAX_CONNECTIONS = 256;
const MAX_FORWARDS_IN_FLIGHT = 32;
const MINUTE_MS = 60_000;

/** Request headers a handler may read: the hop-by-hop, cookie, credential and forwarding ones never pass. */
export function publicRequestHeaders(
  raw: IncomingHttpHeaders | Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const kept = new Map<string, string>();
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (DROPPED_HEADERS.has(lower) || lower.startsWith("x-forwarded-")) continue;
    if (typeof value === "string") kept.set(lower, value);
    else if (Array.isArray(value)) kept.set(lower, value.join(", "));
  }
  return kept;
}

function principalFor(match: Extract<PublicRouteMatch, { status: "route" }>): PublicPrincipal {
  const id = match.params.id;
  if (match.name === "webhook" && id !== undefined) return { kind: "webhook", endpointId: id };
  if (match.name.startsWith("visitor") && id !== undefined) return { kind: "visitor", linkId: id };
  if (match.name === "relay") return { kind: "relay" };
  return { kind: "anonymous" };
}

function handlerFor(
  handlers: PublicEntranceHandlers,
  name: PublicRouteName,
): PublicRouteHandler | undefined {
  switch (name) {
    case "visitor-page":
      return handlers.visitorPage;
    case "visitor-asset":
      return handlers.visitorAsset;
    case "visitor-open":
      return handlers.visitorOpen;
    case "visitor-stream":
      return handlers.visitorStream;
    case "visitor-comments":
      return handlers.visitorComments;
    case "webhook":
      return handlers.webhook;
    case "relay":
    case "health":
      return undefined;
  }
}

/** A counter per clock minute: enough to cap a flood without remembering any caller. */
class MinuteCap {
  readonly #limit: number;
  readonly #now: () => number;
  #minute = -1;
  #count = 0;

  constructor(limit: number, now: () => number) {
    this.#limit = limit;
    this.#now = now;
  }

  take(): boolean {
    const minute = Math.floor(this.#now() / MINUTE_MS);
    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#count = 0;
    }
    this.#count += 1;
    return this.#count <= this.#limit;
  }
}

const notFound: PublicAnswer = { status: 404, body: "" };
const json = (status: number, value: unknown): PublicAnswer => ({
  status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

function readFrom(incoming: IncomingMessage) {
  let consumed = false;
  return (maxBytes: number): Promise<PublicBody> => {
    if (consumed) return Promise.resolve({ status: "aborted" });
    consumed = true;
    const declared = Number(incoming.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) {
      return Promise.resolve({ status: "too-large" });
    }
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const settle = (body: PublicBody) => {
        if (settled) return;
        settled = true;
        resolve(body);
      };
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          incoming.pause();
          settle({ status: "too-large" });
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => settle({ status: "read", bytes: Buffer.concat(chunks) }));
      incoming.on("error", () => settle({ status: "aborted" }));
      incoming.on("close", () => settle({ status: "aborted" }));
    });
  };
}

async function writeAnswer(response: ServerResponse, answer: PublicAnswer): Promise<void> {
  const headers: Record<string, string> = { ...HARDENING };
  for (const [name, value] of Object.entries(answer.headers ?? {})) {
    const lower = name.toLowerCase();
    // A handler cannot set a cookie: one set here would also reach the private
    // listener on the same host name, since cookies ignore the port.
    if (lower === "set-cookie" || lower in HARDENING) continue;
    headers[lower] = value;
  }
  if ((headers["content-type"] ?? "").startsWith("text/html")) {
    headers["content-security-policy"] = PAGE_POLICY;
  }
  response.writeHead(answer.status, headers);
  const body = answer.body;
  if (body === undefined || typeof body === "string" || body instanceof Uint8Array) {
    response.end(body ?? "");
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!response.write(next.value)) {
        await new Promise((resolve) => response.once("drain", resolve));
      }
    }
  } catch {
    // The client went away; the handler's stream ends with the request's signal.
  } finally {
    response.end();
  }
}

/**
 * Starts the entrance on 127.0.0.1. Only the front reaches it there; the
 * service refuses any other bind before it calls this.
 */
export async function startPublicEntrance(options: PublicEntranceOptions): Promise<PublicEntrance> {
  const now = options.now ?? Date.now;
  const cap = new MinuteCap(options.requestsPerMinute ?? PUBLIC_ENTRANCE_REQUESTS_PER_MINUTE, now);
  const closing = new AbortController();
  let forwarding = 0;
  const handlers = () =>
    typeof options.handlers === "function" ? options.handlers() : options.handlers;

  /** The table, the cap, the role, and then a handler; shared by direct and forwarded requests. */
  const answer = async (input: {
    readonly method: string;
    readonly path: string;
    readonly headers: ReadonlyMap<string, string>;
    readonly readBody: PublicRequest["readBody"];
    readonly signal: AbortSignal;
    readonly forwarded: boolean;
  }): Promise<PublicAnswer> => {
    const match = matchPublicRoute(input.method, input.path);
    if (match.status === "not-found") return notFound;
    if (match.status === "method-not-allowed") {
      return { status: 405, headers: { allow: match.allow }, body: "" };
    }
    const role = options.role();
    if (role === "closed") return notFound;
    if (!cap.take()) return { status: 429, headers: { "retry-after": "60" }, body: "" };
    if (
      role === "forward" &&
      !input.forwarded &&
      (match.name === "visitor-open" ||
        match.name === "visitor-stream" ||
        match.name === "visitor-comments")
    ) {
      // A live stream does not cross members yet, and an open forwarded from
      // here would bind the link to a key this origin keeps, which the hub's
      // own address could never use again.
      return { status: 501, headers: {}, body: "" };
    }
    if (role === "forward" && !input.forwarded) {
      // Each forward holds its body in memory twice (raw and base64), so the
      // number in flight is bounded, not just the number a minute.
      if (forwarding >= MAX_FORWARDS_IN_FLIGHT) {
        return { status: 503, headers: { "retry-after": "5" }, body: "" };
      }
      forwarding += 1;
      try {
        const body = await input.readBody(PUBLIC_FORWARD_MAX_BODY_BYTES);
        if (body.status === "too-large") return { status: 413, body: "" };
        if (body.status === "aborted") return { status: 400, body: "" };
        const reply = await options.forward?.({
          method: input.method as PublicForwardEnvelope["method"],
          path: input.path,
          headers: Object.fromEntries(input.headers),
          body: body.bytes.toString("base64"),
        });
        return reply === undefined
          ? { status: 503, body: "" }
          : {
              status: reply.status,
              headers: reply.headers,
              body: Buffer.from(reply.body, "base64"),
            };
      } finally {
        forwarding -= 1;
      }
    }
    if (match.name === "health") return json(200, { ok: true });
    const handler = handlerFor(handlers(), match.name);
    if (handler === undefined) return notFound;
    return handler({
      route: match.name,
      params: match.params,
      method: input.method,
      path: input.path,
      headers: input.headers,
      principal: principalFor(match),
      readBody: input.readBody,
      signal: input.signal,
    });
  };

  const server: Server = createServer(
    { maxHeaderSize: PUBLIC_ENTRANCE_MAX_HEADER_BYTES },
    (incoming, response) => {
      const path = (incoming.url ?? "/").split("?")[0] ?? "/";
      const request = new AbortController();
      const abort = () => request.abort();
      // The request's own "close" fires once its body is read, so a stream
      // would end early; the visitor leaving is the response closing unfinished.
      response.on("close", () => {
        if (!response.writableFinished) abort();
      });
      closing.signal.addEventListener("abort", abort, { once: true });
      void answer({
        method: incoming.method ?? "GET",
        path,
        headers: publicRequestHeaders(incoming.headers),
        readBody: readFrom(incoming),
        signal: request.signal,
        forwarded: false,
      })
        .catch((): PublicAnswer => ({ status: 500, body: "" }))
        .then((reply) =>
          writeAnswer(response, incoming.method === "HEAD" ? { ...reply, body: "" } : reply),
        )
        .finally(() => closing.signal.removeEventListener("abort", abort));
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = HEADER_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  // Node's closeAllConnections skips upgraded sockets and close() waits for
  // them, so an idle device tunnel held turning the entrance off until the
  // device left. Closing ends each relay this listener handed out.
  const relaySockets = new Set<Duplex>();
  server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (incoming.url ?? "/").split("?")[0] ?? "/";
    const match = matchPublicRoute(incoming.method ?? "GET", path);
    const relay = handlers().relay;
    if (
      match.status !== "route" ||
      match.name !== "relay" ||
      relay === undefined ||
      options.role() !== "serve" ||
      !cap.take()
    ) {
      socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
      return;
    }
    relaySockets.add(socket);
    socket.once("close", () => relaySockets.delete(socket));
    relay(incoming, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : options.port;

  return {
    port,
    dispatchForwarded: async (envelope) => {
      const bytes = Buffer.from(envelope.body, "base64");
      let read = false;
      const reply = await answer({
        method: envelope.method,
        path: envelope.path,
        headers: publicRequestHeaders(envelope.headers),
        readBody: async (maxBytes) => {
          if (read) return { status: "aborted" };
          read = true;
          return bytes.byteLength > maxBytes ? { status: "too-large" } : { status: "read", bytes };
        },
        signal: closing.signal,
        forwarded: true,
      });
      const body = reply.body;
      // A stream does not cross members in this form; the answer says so, and
      // cancelling it frees whatever the handler holds for it.
      if (body !== undefined && !(typeof body === "string" || body instanceof Uint8Array)) {
        await body.cancel().catch(() => undefined);
        return { status: 501, headers: {}, body: "" };
      }
      if (Buffer.byteLength(body ?? "") > PUBLIC_FORWARD_MAX_BODY_BYTES) {
        return { status: 502, headers: {}, body: "" };
      }
      return {
        status: reply.status,
        headers: { ...reply.headers },
        body: Buffer.from(body ?? "").toString("base64"),
      };
    },
    close: () =>
      new Promise<void>((resolve) => {
        closing.abort();
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of relaySockets) socket.destroy();
      }),
  };
}
