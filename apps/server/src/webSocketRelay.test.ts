import { createServer, connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketEndpoint } from "./webSocketRelay";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A connected socket whose other end never reads. */
async function stalledPeer(): Promise<Socket> {
  const server = createServer((socket) => socket.pause());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  cleanups.push(() => {
    socket.destroy();
    server.close();
  });
  return socket;
}

describe("WebSocketEndpoint", () => {
  it("never queues more than twice the message cap for a peer that stops reading", async () => {
    const maxMessageBytes = 1024;
    const socket = await stalledPeer();
    const closes: number[] = [];
    const endpoint = new WebSocketEndpoint(socket, "server", maxMessageBytes);
    endpoint.start(
      { message: () => undefined, closed: (code) => closes.push(code) },
      new Uint8Array(),
    );
    let queuedMost = 0;
    for (let sent = 0; sent < 100_000 && closes.length === 0; sent += 1) {
      endpoint.send({ text: false, data: new Uint8Array(1000) });
      queuedMost = Math.max(queuedMost, socket.writableLength);
    }
    expect(closes).toEqual([1008]);
    // The close frame itself may follow the last message that fit.
    expect(queuedMost).toBeLessThanOrEqual(2 * maxMessageBytes + 128);
  });
});
