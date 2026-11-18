import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync } from "node:fs";
import { link, lstat, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";

export interface LinuxControlRelay {
  readonly socketPath: string;
  readonly ready: Promise<URL>;
  readonly close: () => Promise<void>;
}

/** The private namespace's one inbound port, carried through a pinned socket. */
export function startLinuxControlRelay(input: {
  readonly socketPath: string;
  /** Host authority storage: never one of the workload's folder grants. */
  readonly ownerDirectory: string;
  readonly exited: Promise<void>;
  readonly launchReady: Promise<void>;
  readonly timeoutMs: number;
  readonly onLost: () => void;
}): LinuxControlRelay {
  mkdirSync(input.ownerDirectory, { recursive: true, mode: 0o700 });
  const directory = realpathSync(mkdtempSync(join(input.ownerDirectory, "connection-")));
  const held = join(directory, "control.sock");
  const directoryFd = openSync(directory, "r");
  // The held inode may live beneath a long application-data path. The host's
  // directory descriptor keeps its connect address within Unix's path limit.
  const addressPath = `/proc/self/fd/${directoryFd}/control.sock`;
  const sockets = new Set<Socket>();
  let notifyClosed = () => {};
  const closedSignal = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  let closed = false;
  let gone = false;
  let listening = false;
  let listenStarted: Promise<void> | undefined;
  void input.exited.then(() => {
    gone = true;
    void close();
  });
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (closed || sockets.size >= 128) {
      client.destroy();
      return;
    }
    const upstream = connect({ path: addressPath, allowHalfOpen: true });
    sockets.add(client);
    sockets.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end);
    upstream.on("error", end);
    client.on("close", end);
    upstream.on("close", end);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.on("close", () => {
    if (listening && !closed) input.onLost();
  });
  server.on("error", () => {
    if (listening && !closed) input.onLost();
  });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      closed = true;
      notifyClosed();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await listenStarted?.catch(() => undefined);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      closeSync(directoryFd);
      await rm(directory, { recursive: true, force: true });
    })());
  const ready = (async () => {
    const deadline = Date.now() + input.timeoutMs;
    for (;;) {
      if (closed || gone || Date.now() >= deadline)
        throw new Error("The confined control relay did not become ready");
      const source = await lstat(input.socketPath, { bigint: true }).catch(() => undefined);
      if (source !== undefined) {
        if (!source.isSocket()) throw new Error("The confined control endpoint is not a socket");
        await link(input.socketPath, held);
        const pinned = await lstat(held, { bigint: true });
        if (!pinned.isSocket() || pinned.dev !== source.dev || pinned.ino !== source.ino)
          throw new Error("The confined control endpoint changed identity");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let ownershipTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        input.launchReady,
        closedSignal.then(() => {
          throw new Error("The confined control relay expired");
        }),
        new Promise<never>((_resolve, reject) => {
          ownershipTimer = setTimeout(
            () => reject(new Error("Control ownership timed out")),
            Math.max(1, deadline - Date.now()),
          );
        }),
      ]);
    } finally {
      if (ownershipTimer !== undefined) clearTimeout(ownershipTimer);
    }
    if (closed || gone) throw new Error("The confined control relay expired");
    // This first connection releases the trusted forwarder's launch gate.
    // The workload has not run before the host pinned the socket's inode.
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ path: addressPath });
      sockets.add(socket);
      const timer = setTimeout(
        () => {
          socket.destroy();
          reject(new Error("Control relay handshake timed out"));
        },
        Math.max(1, deadline - Date.now()),
      );
      socket.once("connect", () => {
        clearTimeout(timer);
        sockets.delete(socket);
        socket.destroy();
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        clearTimeout(timer);
        sockets.delete(socket);
        reject(new Error("Control relay handshake closed"));
      });
    });
    if (closed || gone) throw new Error("The confined control relay expired");
    listenStarted = new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        server.off("error", failed);
        listening = true;
        resolve();
      });
    });
    await listenStarted;
    if (closed || gone) {
      await close();
      throw new Error("The confined control relay expired");
    }
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("The control relay has no listener");
    return new URL(`http://127.0.0.1:${address.port}/`);
  })().catch(async (error: unknown) => {
    await close();
    throw error;
  });
  void ready.catch(() => undefined);
  return { socketPath: input.socketPath, ready, close };
}
