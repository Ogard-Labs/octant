import { IncomingMessage, ServerResponse, type RequestListener } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createBrowserSurfaceHost } from "./browserSurfaceHost";

const transport = vi.hoisted<{
  listener?: RequestListener;
  listenFailure?: Error;
  closed: number;
  connectionsClosed: number;
}>(() => ({ closed: 0, connectionsClosed: 0 }));

vi.mock("node:http", async (original) => {
  const http = await original<typeof import("node:http")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...http,
    createServer: (listener: RequestListener) => {
      transport.listener = listener;
      const server = new EventEmitter();
      let listening = false;
      Object.defineProperty(server, "listening", { get: () => listening });
      return Object.assign(server, {
        listen: (_port: number, _address: string, ready: () => void) => {
          if (transport.listenFailure !== undefined)
            queueMicrotask(() => server.emit("error", transport.listenFailure));
          else {
            listening = true;
            ready();
          }
        },
        address: () => ({ address: "127.0.0.1", family: "IPv4", port: 41234 }),
        close: (done: (error?: Error) => void) => {
          listening = false;
          transport.closed++;
          done();
        },
        closeAllConnections: () => {
          transport.connectionsClosed++;
        },
      });
    },
  };
});

import { startBrowserRuntimeBroker } from "./browserRuntimeBroker";

function incoming(token: string) {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const request = new IncomingMessage(socket);
  request.method = "POST";
  request.url = "/v1/contexts/describe-point";
  request.headers = { "content-type": "application/json", "x-octant-browser-broker-token": token };
  request.push(
    Buffer.from(
      JSON.stringify({
        contextId: "60000000-0000-4000-8000-000000000001",
        selectionId: "60000000-0000-4000-8000-000000000002",
        point: { x: 0.25, y: 0.25 },
      }),
    ),
  );
  // The HTTP parser sets this when the complete request body has arrived.
  request.complete = true;
  request.push(null);
  return { request, response: new ServerResponse(request), socket };
}

describe("broker owned failure cleanup", () => {
  it("releases subscriptions and surface resources after failed listen", async () => {
    const base = createBrowserSurfaceHost({
      createView: () => {
        throw Error("No native view needed");
      },
    });
    const gone = vi.fn(),
      input = vi.fn(),
      closeAll = vi.fn(async () => undefined);
    transport.listenFailure = Error("Listen unavailable");
    try {
      await expect(
        startBrowserRuntimeBroker({
          ...base,
          onContextGone: () => gone,
          onPersonInput: () => input,
          closeAll,
        }),
      ).rejects.toThrow("Listen unavailable");
      expect(gone).toHaveBeenCalledOnce();
      expect(input).toHaveBeenCalledOnce();
      expect(closeAll).toHaveBeenCalledOnce();
    } finally {
      delete transport.listenFailure;
    }
  });

  it("closes HTTP connections exactly once even when host close fails", async () => {
    const base = createBrowserSurfaceHost({
      createView: () => {
        throw Error("No native view needed");
      },
    });
    const gone = vi.fn(),
      input = vi.fn(),
      failed = Error("Surface close failed");
    const closeAll = vi.fn(async () => {
      throw failed;
    });
    const closed = transport.closed,
      connections = transport.connectionsClosed;
    const broker = await startBrowserRuntimeBroker({
      ...base,
      onContextGone: () => gone,
      onPersonInput: () => input,
      closeAll,
    });
    const pending = broker.close();
    const error: unknown = await pending.catch((failure: unknown) => failure);
    expect(broker.close()).toBe(pending);
    expect(transport.closed - closed).toBe(1);
    expect(transport.connectionsClosed - connections).toBe(1);
    expect(error).toMatchObject({ errors: [failed] });
    expect(gone).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledOnce();
    expect(closeAll).toHaveBeenCalledOnce();
  });
});

describe("the real broker request handler's point-read cancellation", () => {
  it("aborts a held native read when the response disconnects after its body completed", async () => {
    const base = createBrowserSurfaceHost({
      createView: () => {
        throw new Error("No native view needed for transport proof");
      },
    });
    let readSignal: AbortSignal | undefined;
    const read: typeof base.describePoint = async (_context, _point, signal) => {
      readSignal = signal;
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { status: "unavailable", reason: "page-changed" };
    };
    const host = { ...base, describePoint: read };
    const broker = await startBrowserRuntimeBroker(host);
    const io = incoming(broker.token);
    const once = vi.spyOn(io.request, "once");
    try {
      transport.listener?.(io.request, io.response);
      await vi.waitFor(() => expect(readSignal).toBeDefined());
      expect(io.request.readableEnded).toBe(true);
      expect(io.request.aborted).toBe(false);
      io.response.emit("close");
      await vi.waitFor(() => expect(readSignal?.aborted).toBe(true));
      await vi.waitFor(() => expect(io.response.listenerCount("close")).toBe(0));
      const cancelled = once.mock.calls.find(([event]) => event === "aborted")?.[1];
      expect(cancelled).toBeTypeOf("function");
      // Node's async body iterator can retain its own abort listener; the
      // broker must remove the specific listener it registered before reading.
      await vi.waitFor(() => expect(io.request.listeners("aborted")).not.toContain(cancelled));
    } finally {
      io.response.destroy();
      io.socket.destroy();
      await broker.close();
    }
  });

  it("does not cancel a completed normal response and removes both read listeners", async () => {
    const base = createBrowserSurfaceHost({
      createView: () => {
        throw new Error("No native view needed for transport proof");
      },
    });
    let readSignal: AbortSignal | undefined;
    const read: typeof base.describePoint = async (_context, _point, signal) => {
      readSignal = signal;
      return { status: "no-element" };
    };
    const host = { ...base, describePoint: read };
    const broker = await startBrowserRuntimeBroker(host);
    const io = incoming(broker.token);
    const once = vi.spyOn(io.request, "once");
    try {
      transport.listener?.(io.request, io.response);
      await vi.waitFor(() => expect(io.response.writableEnded).toBe(true));
      io.response.emit("close");
      expect(readSignal?.aborted).toBe(false);
      expect(io.response.listenerCount("close")).toBe(0);
      const cancelled = once.mock.calls.find(([event]) => event === "aborted")?.[1];
      expect(cancelled).toBeTypeOf("function");
      expect(io.request.listeners("aborted")).not.toContain(cancelled);
    } finally {
      io.response.destroy();
      io.socket.destroy();
      await broker.close();
    }
  });
});
