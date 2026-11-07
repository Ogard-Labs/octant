import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { chmod, link, lstat, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { Socket } from "node:net";
import type { DesktopPreviewRelay } from "@octant/plugin-api/desktop-provider";
import { isWebSocketKey, webSocketAcceptFor, WebSocketEndpoint } from "../webSocketRelay";

const PROOF_HEADER = "x-octant-preview-key";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_MESSAGE = 1024 * 1024;
const MAX_CONNECTIONS = 8;
const MAX_OPERATIONS = 8;
const UNAVAILABLE = "Preview unavailable.";

/** One private socket in one lease's existing home; the relay already holds the exact approved target. */
export async function createDesktopPreviewBridge(options: {
  readonly socketPath: string;
  /** Exact inode exposed to the guest; the bind pathname stays outside its mounts. */
  readonly exposedPath: string;
  readonly nonce: string;
  readonly relay: DesktopPreviewRelay;
  readonly signal: AbortSignal;
}): Promise<{ readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const controllers = new Map<AbortController, Socket>();
  let closing: Promise<void> | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  let stopped = false;
  const proof = Buffer.from(options.nonce);
  const authorized = (request: IncomingMessage) => {
    const value = request.headers[PROOF_HEADER];
    if (stopped || options.signal.aborted || typeof value !== "string") return false;
    const bytes = Buffer.from(value);
    return bytes.length === proof.length && timingSafeEqual(bytes, proof);
  };
  const pathValid = (value: string | undefined) =>
    value !== undefined &&
    value.length <= 8192 &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code > 32 && code !== 127;
    });
  const headersOf = (request: IncomingMessage): ReadonlyArray<readonly [string, string]> => {
    const headers: Array<readonly [string, string]> = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index]?.toLowerCase();
      const value = request.rawHeaders[index + 1];
      if (
        name !== undefined &&
        value !== undefined &&
        name !== PROOF_HEADER &&
        name !== "host" &&
        !name.startsWith("x-forwarded-") &&
        name !== "forwarded"
      )
        headers.push([name, value]);
    }
    return headers;
  };
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    if (request.socket.destroyed) return;
    // HTTP pipelining can create many operations on one connection. Do not
    // queue a rejection behind its held responses or allocate more body work.
    if (controllers.size >= MAX_OPERATIONS) {
      request.socket.destroy();
      return;
    }
    if (!authorized(request)) {
      response.writeHead(401).end(UNAVAILABLE);
      return;
    }
    const method = request.method ?? "";
    if (
      !pathValid(request.url) ||
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)
    ) {
      response.writeHead(400).end(UNAVAILABLE);
      return;
    }
    const controller = new AbortController();
    controllers.set(controller, request.socket);
    const abort = () => controller.abort();
    response.once("close", abort);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY) {
          response.writeHead(413).end(UNAVAILABLE);
          return;
        }
        chunks.push(bytes);
      }
      if (!authorized(request)) {
        response.writeHead(401).end(UNAVAILABLE);
        return;
      }
      const answered = await options.relay.request({
        method,
        pathQuery: request.url ?? "/",
        headers: headersOf(request),
        ...(size === 0 ? {} : { body: Buffer.concat(chunks) }),
        signal: controller.signal,
      });
      if (!authorized(request) || controller.signal.aborted) {
        response.destroy();
        return;
      }
      const cookies = answered.headers.getSetCookie();
      response.writeHead(answered.status, {
        ...Object.fromEntries(answered.headers),
        // Set-Cookie is repeatable and an Expires value can itself contain a
        // comma. Preserve the relay's separate fields through Node's array form.
        ...(cookies.length === 0 ? {} : { "set-cookie": cookies }),
      });
      if (answered.body !== null) {
        const reader = answered.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          while (!controller.signal.aborted) {
            const next = await reader.read();
            if (next.done) break;
            if (!response.write(next.value))
              await once(response, "drain", { signal: controller.signal });
          }
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
        }
      }
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(502).end(UNAVAILABLE);
      else response.destroy();
    } finally {
      response.removeListener("close", abort);
      controllers.delete(controller);
      controller.abort();
    }
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    if (stopped || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      for (const [controller, owner] of controllers) if (owner === socket) controller.abort();
    });
  });
  server.on("upgrade", async (request, connection, head) => {
    if (!(connection instanceof Socket)) {
      connection.destroy();
      return;
    }
    const socket = connection;
    if (socket.destroyed || controllers.size >= MAX_OPERATIONS) {
      socket.destroy();
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (
      !authorized(request) ||
      !pathValid(request.url) ||
      request.method !== "GET" ||
      request.headers.upgrade?.toLowerCase() !== "websocket" ||
      typeof key !== "string" ||
      !isWebSocketKey(key)
    ) {
      socket.destroy();
      return;
    }
    const controller = new AbortController();
    controllers.set(controller, socket);
    socket.once("close", () => {
      controllers.delete(controller);
      controller.abort();
    });
    try {
      const opened = await options.relay.upgrade({
        pathQuery: request.url ?? "/",
        headers: headersOf(request),
        signal: controller.signal,
      });
      if (opened.status !== "opened") {
        socket.destroy();
        return;
      }
      if (!authorized(request) || controller.signal.aborted) {
        opened.cancel();
        socket.destroy();
        return;
      }
      const offered = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
      if (
        opened.protocol !== undefined &&
        (!offered.includes(opened.protocol) ||
          !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(opened.protocol))
      ) {
        opened.cancel();
        socket.destroy();
        return;
      }
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${webSocketAcceptFor(key)}\r\n${opened.protocol === undefined ? "" : `Sec-WebSocket-Protocol: ${opened.protocol}\r\n`}\r\n`,
      );
      const peer = new WebSocketEndpoint(socket, "server", MAX_MESSAGE);
      peer.start(opened.open(peer), head);
    } catch {
      socket.destroy();
    }
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      stopped = true;
      options.signal.removeEventListener("abort", abort);
      for (const controller of controllers.keys()) controller.abort();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      const existing = await lstat(options.exposedPath).catch(() => undefined);
      if (
        identity !== undefined &&
        existing?.isSocket() &&
        existing.dev === identity.dev &&
        existing.ino === identity.ino
      )
        await unlink(options.exposedPath).catch(() => undefined);
    })();
    return closing;
  };
  const abort = () => {
    void close();
  };
  if (options.signal.aborted) throw new Error("Preview ended.");
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const socket = await lstat(options.socketPath);
  identity = { dev: socket.dev, ino: socket.ino };
  try {
    await chmod(options.socketPath, 0o600);
    await link(options.socketPath, options.exposedPath);
  } catch (error) {
    await close();
    throw error;
  }
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) await close();
  return { close };
}
