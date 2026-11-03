import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";

export const STABLE_HOST_ONLY_SWITCH = "--octant-host-only";
const MAX_FRAME_BYTES = 131_072;
const REQUEST_BOUND_MS = 30_000;

function sameSecret(value: unknown, expected: string): boolean {
  if (typeof value !== "string") return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function readFrames(socket: Socket, receive: (value: unknown) => void): void {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) return socket.destroy();
    let newline: number;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const frame = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        receive(JSON.parse(frame));
      } catch {
        socket.destroy();
        return;
      }
    }
  });
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined;
}

/** The stable process retains its host and native brokers for authenticated Nightly clients. */
export async function serveStableDesktopClients(options: {
  readonly path: string;
  readonly secret: () => string;
  readonly onEmpty: () => void;
  readonly request: (channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>;
}) {
  // The stable app holds its single-instance lock before reaching this point.
  // Refuse anything other than our own stale Unix socket rather than unlinking a file.
  const previous = await lstat(options.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (previous !== undefined) {
    if (!previous.isSocket() || previous.uid !== process.getuid?.()) {
      throw new Error("Octant could not open its desktop client endpoint.");
    }
    await unlink(options.path);
  }
  const clients = new Set<Socket>();
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    const deadline = setTimeout(() => socket.destroy(), 5_000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(deadline);
      connections.delete(socket);
      if (clients.delete(socket) && clients.size === 0) options.onEmpty();
    });
    readFrames(socket, (value) => {
      const frame = record(value);
      if (!clients.has(socket)) {
        if (frame?.protocol !== 1 || !sameSecret(frame.secret, options.secret())) {
          socket.end(`${JSON.stringify({ status: "refused" })}\n`);
          return;
        }
        clearTimeout(deadline);
        clients.add(socket);
        socket.write(`${JSON.stringify({ status: "ready", protocol: 1 })}\n`);
        return;
      }
      if (frame === undefined || !Number.isSafeInteger(frame.id) || typeof frame.channel !== "string" || !Array.isArray(frame.args)) {
        socket.destroy();
        return;
      }
      const id = frame.id;
      void options.request(frame.channel, frame.args).then(
        (result) => socket.write(`${JSON.stringify({ id, status: "done", result })}\n`),
        () => socket.write(`${JSON.stringify({ id, status: "refused" })}\n`),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(options.path, 0o600);
  return {
    hasClients: () => clients.size > 0,
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(options.path).catch(() => undefined);
    },
  };
}

export interface StableDesktopClient {
  readonly connected: () => boolean;
  readonly close: () => void;
  readonly request: (channel: string, args: ReadonlyArray<unknown>) => Promise<unknown>;
}

export function connectStableDesktopClient(options: {
  readonly path: string;
  readonly secret: string;
}): Promise<StableDesktopClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(options.path);
    let ready = false;
    let nextId = 0;
    const pending = new Map<number, { readonly resolve: (value: unknown) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }>();
    const failure = () => new Error("Needs a newer Octant. Install or update Octant, then open Octant Nightly again.");
    const deadline = setTimeout(() => socket.destroy(failure()), 5_000);
    socket.on("error", () => reject(failure()));
    socket.once("close", () => {
      clearTimeout(deadline);
      ready = false;
      reject(failure());
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(failure());
      }
      pending.clear();
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({ protocol: 1, secret: options.secret })}\n`));
    readFrames(socket, (value) => {
      const frame = record(value);
      if (!ready) {
        if (frame?.status !== "ready" || frame.protocol !== 1) {
          socket.destroy(failure());
          return;
        }
        ready = true;
        clearTimeout(deadline);
        resolve({
          connected: () => ready,
          close: () => socket.destroy(),
          request: (channel, args) => new Promise((resolveRequest, rejectRequest) => {
            if (!ready) return rejectRequest(failure());
            const id = ++nextId;
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error("Octant did not answer. Check the saved state before trying again."));
            }, REQUEST_BOUND_MS);
            pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
            socket.write(`${JSON.stringify({ id, channel, args })}\n`);
          }),
        });
        return;
      }
      if (typeof frame?.id !== "number") return socket.destroy();
      const request = pending.get(frame.id);
      if (request === undefined) return;
      clearTimeout(request.timer);
      pending.delete(frame.id);
      if (frame.status === "done") request.resolve(frame.result);
      else request.reject(new Error("Octant refused the credential operation. Open Octant to review it."));
    });
  });
}
