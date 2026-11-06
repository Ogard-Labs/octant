import {
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { once } from "node:events";
import { connect, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPreviewTunnels } from "./serverPreviewTunnel";

const native = vi.hoisted(() => ({
  children: [] as Array<{
    readonly child: ChildProcessWithoutNullStreams;
    readonly closed: Promise<void>;
  }>,
  listeners: [] as Server[],
  ports: [] as number[],
  ready: [] as Array<() => void>,
  delayListen: false,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (_command: string, _args: ReadonlyArray<string>, options: SpawnOptionsWithoutStdio) => {
      // A real owned process that acknowledges startup but keeps its stdio open
      // after SIGTERM. The test releases it explicitly; the deadline is a backstop.
      const child = actual.spawn(
        process.execPath,
        [
          "-e",
          `
        process.on("SIGTERM", () => {});
        process.on("SIGUSR1", () => process.exit(0));
        process.on("SIGUSR2", () => process.exit(255));
        process.stdin.resume();
        setTimeout(() => process.exit(2), 10000);
        process.stdout.write("ready");
      `,
        ],
        { env: options.env, stdio: ["pipe", "pipe", "pipe"] },
      );
      native.children.push({
        child,
        closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
      });
      return child;
    },
  };
});

vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    createServer: (connection: (socket: Socket) => void) => {
      const listener = actual.createServer(connection);
      const listen = listener.listen.bind(listener);
      Object.assign(listener, {
        listen(port: number, host: string, ready: () => void) {
          return listen(port, host, () => {
            const address = listener.address();
            if (address !== null && typeof address !== "string") native.ports.push(address.port);
            if (native.delayListen) native.ready.push(ready);
            else ready();
          });
        },
      });
      native.listeners.push(listener);
      return listener;
    },
  };
});

const owned: ServerPreviewTunnels[] = [];
afterEach(async () => {
  const closing = owned.splice(0).map((tunnels) => tunnels.close());
  for (const ready of native.ready.splice(0)) ready();
  for (const { child } of native.children) {
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      // Every PID here was returned by this fixture's spawn, never discovered by name.
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }
  await Promise.all(native.children.map(({ closed }) => closed));
  await Promise.all(closing);
  for (const listener of native.listeners) {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    expect(listener.address()).toBeNull();
  }
  console.info(
    JSON.stringify({
      fixture: "owned-preview-cleanup",
      processes: native.children.map(({ child }) => ({
        pid: child.pid,
        exitCode: child.exitCode,
        signalCode: child.signalCode,
      })),
      ports: native.ports,
      listenersClosed: native.listeners.every((listener) => listener.address() === null),
    }),
  );
  native.ports.length = 0;
  native.children.length = 0;
  native.listeners.length = 0;
  native.delayListen = false;
});

function fixture() {
  let identity = "original-binding";
  const tunnels = new ServerPreviewTunnels({
    address: () => ({ server: { alias: "web", user: "deploy" }, identity }),
    ownerCurrent: () => true,
    agentSocket: () => undefined,
    record: () => true,
  });
  owned.push(tunnels);
  return {
    tunnels,
    changeBinding: () => {
      identity = "changed-binding";
    },
  };
}
async function opened(tunnels: ServerPreviewTunnels) {
  const result = await tunnels.start("site", "person", 5173, 0);
  if (result.kind !== "tunnel") throw new Error("preview refused");
  return result.view;
}
async function stream(port: number): Promise<ChildProcessWithoutNullStreams> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  const [data] = await once(socket, "data");
  expect(String(data)).toBe("ready");
  const latest = native.children.at(-1);
  if (latest === undefined) throw new Error("missing owned process");
  return latest.child;
}
async function remainsPending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 40));
  expect(settled).toBe(false);
}
function alive(child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (pid === undefined) throw new Error("missing owned PID");
  expect(() => process.kill(pid, 0)).not.toThrow();
}
async function lost(tunnels: ServerPreviewTunnels, port: number) {
  const failed = await stream(port);
  const held = await stream(port);
  failed.kill("SIGUSR2");
  await expect.poll(() => tunnels.read("site", "person")?.status).toBe("lost");
  alive(held);
  return held;
}

describe.skipIf(process.platform === "win32")("owned preview cleanup receipts", () => {
  it("waits for the same stopped cleanup when shutdown races a delayed child close", async () => {
    const { tunnels } = fixture();
    const view = await opened(tunnels);
    const child = await stream(view.localPort);
    const stopping = tunnels.stop("site", "person");
    const closing = tunnels.close();
    try {
      await remainsPending(closing);
      await remainsPending(stopping);
      alive(child);
    } finally {
      child.kill("SIGUSR1");
    }
    expect(await stopping).toMatchObject({ kind: "tunnel", view: { status: "stopped" } });
    expect(await closing).toEqual({ status: "settled" });
    expect(child.exitCode).toBe(0);
  });

  it("waits for an in-flight listen and closes its actual listener before shutdown succeeds", async () => {
    const { tunnels } = fixture();
    native.delayListen = true;
    const starting = tunnels.start("site", "person", 5173, 0);
    await expect.poll(() => native.ready.length).toBe(1);
    const listener = native.listeners[0];
    if (listener === undefined) throw new Error("missing pending listener");
    expect(listener.address()).not.toBeNull();
    const closing = tunnels.close();
    try {
      await remainsPending(closing);
    } finally {
      for (const ready of native.ready.splice(0)) ready();
    }
    expect(await starting).toMatchObject({ kind: "refused" });
    expect(await closing).toEqual({ status: "settled" });
    expect(listener.address()).toBeNull();
    expect(tunnels.read("site", "person")).toBeUndefined();
  });

  it("retains a delayed listen after shutdown times out until its actual cleanup settles", async () => {
    const { tunnels } = fixture();
    native.delayListen = true;
    const starting = tunnels.start("site", "person", 5173, 0);
    await expect.poll(() => native.ready.length).toBe(1);
    const listener = native.listeners[0];
    if (listener === undefined) throw new Error("missing pending listener");
    let closingAgain: Promise<unknown> | undefined;
    try {
      expect(await tunnels.close()).toEqual({ status: "unsettled" });
      expect(listener.address()).not.toBeNull();
      closingAgain = tunnels.close();
      await remainsPending(closingAgain);
    } finally {
      for (const ready of native.ready.splice(0)) ready();
    }
    expect(await starting).toMatchObject({ kind: "refused" });
    expect(await closingAgain).toEqual({ status: "settled" });
    expect(listener.address()).toBeNull();
  });

  it("keeps a replacement start pending until the stopped preview's process has closed", async () => {
    const { tunnels } = fixture();
    const view = await opened(tunnels);
    const child = await stream(view.localPort);
    const stopping = tunnels.stop("site", "person");
    const starting = tunnels.start("site", "person", 5173, view.localPort);
    try {
      await remainsPending(starting);
      expect(native.listeners).toHaveLength(1);
      alive(child);
    } finally {
      child.kill("SIGUSR1");
    }
    await stopping;
    expect(await starting).toMatchObject({ kind: "tunnel", view: { localPort: view.localPort } });
    expect(child.exitCode).toBe(0);
  });

  it("waits for lost-stream cleanup before reconnecting once to the exact same endpoint", async () => {
    const { tunnels } = fixture();
    const view = await opened(tunnels);
    const child = await lost(tunnels, view.localPort);
    const reconnecting = tunnels.reconnect("site", "person");
    try {
      await remainsPending(reconnecting);
      expect(native.listeners).toHaveLength(1);
      expect(await tunnels.reconnect("site", "person")).toMatchObject({ kind: "refused" });
      alive(child);
    } finally {
      child.kill("SIGUSR1");
    }
    expect(await reconnecting).toMatchObject({
      kind: "tunnel",
      view: { remotePort: 5173, localPort: view.localPort, status: "listening" },
    });
    expect(child.exitCode).toBe(0);
    await stream(view.localPort);
  });

  it("lets stop cancel a reconnect while the previous process still owns cleanup", async () => {
    const { tunnels } = fixture();
    const view = await opened(tunnels);
    const child = await lost(tunnels, view.localPort);
    const reconnecting = tunnels.reconnect("site", "person");
    const stopping = tunnels.stop("site", "person");
    try {
      await remainsPending(stopping);
    } finally {
      child.kill("SIGUSR1");
    }
    expect(await reconnecting).toMatchObject({ kind: "refused" });
    expect(await stopping).toMatchObject({ kind: "tunnel", view: { status: "stopped" } });
    expect(native.listeners).toHaveLength(1);
  });

  it("refuses a changed binding after waiting for the old reconnect cleanup", async () => {
    const { tunnels, changeBinding } = fixture();
    const view = await opened(tunnels);
    const child = await lost(tunnels, view.localPort);
    const reconnecting = tunnels.reconnect("site", "person");
    changeBinding();
    child.kill("SIGUSR1");
    expect(await reconnecting).toMatchObject({ kind: "refused" });
    expect(native.listeners).toHaveLength(1);
  });

  it("reports bounded failure without forgetting an owned process that cannot be signalled", async () => {
    const { tunnels } = fixture();
    const view = await opened(tunnels);
    const child = await stream(view.localPort);
    const denied = vi.spyOn(child, "kill").mockImplementation(() => false);
    const stopping = tunnels.stop("site", "person");
    const closing = tunnels.close();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.all([stopping, closing]),
        new Promise<"unbounded">((resolve) => {
          deadline = setTimeout(() => resolve("unbounded"), 4_200);
        }),
      ]);
      expect(result).not.toBe("unbounded");
      if (result === "unbounded") return;
      expect(result[0]).toEqual({ kind: "refused", reason: "cleanup-unsettled" });
      expect(result[1]).toEqual({ status: "unsettled" });
      alive(child);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      denied.mockRestore();
      child.kill("SIGUSR1");
      await Promise.all([stopping, closing]);
    }
    expect(await tunnels.close()).toEqual({ status: "settled" });
  });
});
