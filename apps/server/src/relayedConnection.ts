// One connection a paired device made through its hub's device relay
// (decision H36). The bytes are the device's own TLS to this listener, so they
// are opened here with the listener's own certificate, never by the hub, and
// each request then goes through the same remote boundary as one that arrived
// on the private address. Pairing, listener administration and device
// changes are refused before any route runs: a device pairs on the private
// network or by QR, never from the internet.

import { createServer as createHttpsServer, type Server } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { RELAYED_ADMIN_REFUSED } from "@octant/contracts";
import type { RequestTransportFacts } from "./server";
import type { WebSocketPeer, WebSocketPeerEvents } from "./webSocketRelay";

/** Paths a relayed connection never reaches, whatever the method. */
const REFUSED_PREFIXES = [
  "/api/remote/pairing",
  "/api/remote/pairing-requests",
  "/api/remote/pairing-tickets",
  "/api/hub",
  "/api/desktop",
] as const;
/** Paths a relayed connection may read but never change. */
const READ_ONLY_PREFIXES = ["/api/remote/devices", "/api/remote/access-pause"] as const;

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

/**
 * Whether a relayed request is refused before routing: pairing, the hub's
 * member routes, the host's own administration, and any change to the device
 * inventory or the pause. Reading the device list stays open, as for a device
 * on the private network.
 */
export function relayedRequestRefused(method: string, path: string): boolean {
  // The check runs on the raw target, which is then resolved into the URL the
  // routes see; a dot segment (plain or percent-encoded), a backslash, or an
  // absolute-form target would resolve to a different path than the one
  // checked, so none is served at all.
  if (!path.startsWith("/") || path.startsWith("//") || /\\|%2e|%5c/i.test(path)) return true;
  const bare = path.split("?")[0] ?? path;
  if (bare.split("/").some((segment) => segment === "." || segment === "..")) return true;
  if (REFUSED_PREFIXES.some((prefix) => underPrefix(bare, prefix))) return true;
  const reads = method === "GET" || method === "HEAD";
  return !reads && READ_ONLY_PREFIXES.some((prefix) => underPrefix(bare, prefix));
}

/**
 * A stream over one WebSocket: binary messages in are bytes read, bytes
 * written go out as binary messages. Either end closing ends the other.
 */
export function webSocketByteStream(peer: WebSocketPeer): {
  readonly stream: Duplex;
  readonly events: WebSocketPeerEvents;
} {
  let closed = false;
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      if (!closed) peer.send({ text: false, data: chunk });
      callback();
    },
    final(callback) {
      if (!closed) {
        closed = true;
        peer.close(1000, "");
      }
      callback();
    },
    destroy(error, callback) {
      if (!closed) {
        closed = true;
        peer.close(1000, "");
      }
      callback(error);
    },
  });
  return {
    stream,
    events: {
      message: (message) => {
        if (!message.text) stream.push(Buffer.from(message.data));
      },
      closed: () => {
        closed = true;
        stream.push(null);
        stream.destroy();
      },
    },
  };
}

export interface RelayedConnectionOptions {
  readonly socket: Duplex;
  readonly tls: { readonly cert: string | Buffer; readonly key: string | Buffer };
  /** The listener's own origin; every relayed request is read as addressed to it. */
  readonly origin: string;
  readonly fetch: (request: Request, facts?: RequestTransportFacts) => Promise<Response>;
  readonly facts: RequestTransportFacts;
  readonly maxBodyBytes: number;
}

const refusal = (status: number, kind: string): Response =>
  Response.json({ status: "refused", kind }, { status, headers: { "cache-control": "no-store" } });

async function readBody(incoming: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    total += (chunk as Buffer).byteLength;
    if (total > max) return undefined;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function resolveTarget(path: string, origin: string): URL | undefined {
  try {
    const url = new URL(path, origin);
    return url.origin === new URL(origin).origin ? url : undefined;
  } catch {
    return undefined;
  }
}

async function answer(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  options: RelayedConnectionOptions,
): Promise<void> {
  const method = incoming.method ?? "GET";
  const path = incoming.url ?? "/";
  let response: Response;
  // Only a target that passed the raw check is resolved; the resolved path is
  // checked again, and it is the one the routes see.
  const url = relayedRequestRefused(method, path) ? undefined : resolveTarget(path, options.origin);
  if (url === undefined || relayedRequestRefused(method, `${url.pathname}${url.search}`)) {
    incoming.resume();
    response = refusal(403, RELAYED_ADMIN_REFUSED);
  } else {
    const body = await readBody(incoming, options.maxBodyBytes);
    if (body === undefined) {
      response = refusal(413, "too-large");
    } else {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(", "));
      }
      const controller = new AbortController();
      outgoing.once("close", () => controller.abort());
      response = await options.fetch(
        new Request(url, {
          method,
          headers,
          signal: controller.signal,
          ...(method === "GET" || method === "HEAD" || body.byteLength === 0
            ? {}
            : { body: Uint8Array.from(body) }),
        }),
        options.facts,
      );
    }
  }
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Each cookie is its own header line; joined with commas they would break.
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  outgoing.writeHead(response.status, headers);
  if (response.body === null || method === "HEAD") {
    await response.body?.cancel().catch(() => undefined);
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  // A device that goes away mid-answer never drains its side again: its close
  // wakes a write waiting on drain and cancels the response, so neither the
  // reader nor what the route holds for it is left waiting.
  let gone = false;
  const closed = new Promise<void>((done) =>
    outgoing.once("close", () => {
      gone = true;
      done();
    }),
  );
  void closed.then(() => reader.cancel().catch(() => undefined));
  try {
    while (!gone) {
      const next = await reader.read();
      if (next.done) break;
      if (!outgoing.write(next.value)) {
        await Promise.race([new Promise((done) => outgoing.once("drain", done)), closed]);
      }
    }
  } finally {
    if (gone) await reader.cancel().catch(() => undefined);
    outgoing.end();
  }
}

/**
 * Serves HTTPS on one relayed byte stream until it ends. A WebSocket upgrade
 * inside the relay is not served: the request is answered 501 and the
 * connection closed.
 */
export function serveRelayedConnection(options: RelayedConnectionOptions): Server {
  const server = createHttpsServer(
    { cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.3" },
    (incoming, outgoing) => {
      void answer(incoming, outgoing, options).catch(() => {
        if (!outgoing.headersSent) outgoing.writeHead(500);
        outgoing.end();
      });
    },
  );
  server.on("upgrade", (_incoming, socket: Duplex) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
  });
  server.on("tlsClientError", () => options.socket.destroy());
  options.socket.on("error", () => undefined);
  options.socket.once("close", () => server.close());
  server.emit("connection", options.socket);
  return server;
}
