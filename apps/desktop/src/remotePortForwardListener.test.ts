import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import { connect as connectTcp, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { RemotePortForward } from "@octant/contracts";
import type { RemoteServerForwarderSignRequest } from "@octant/client-runtime/remote-server-forwarder";
import { listenForPortForward } from "./remotePortForwardListener";
import { upgradeThroughListener } from "./remoteServerPages";

const HOST_ID = "11111111-1111-4111-8111-111111111111";
const FORWARD_ID = `rpf_${"ab".repeat(32)}`;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * A stand-in for the other computer's listener: it accepts the upgrade with
 * the real handshake answer and echoes each binary message it receives back
 * unmasked, as the host's relay sends them.
 */
async function echoingHost(): Promise<{
  readonly port: number;
  readonly upgrades: Array<{ readonly url: string; readonly proof: string | undefined }>;
}> {
  const upgrades: Array<{ readonly url: string; readonly proof: string | undefined }> = [];
  const sockets: Socket[] = [];
  const server: Server = createHttpServer();
  server.on("upgrade", (request, socket: Socket) => {
    sockets.push(socket);
    const proof = request.headers["x-octant-device-proof"];
    upgrades.push({ url: request.url ?? "", proof: typeof proof === "string" ? proof : undefined });
    const accept = createHash("sha1")
      .update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on("data", (chunk: Buffer) => {
      // Frames in this test are small: one byte of length, then the mask.
      const opcode = (chunk[0] ?? 0) & 0x0f;
      const length = (chunk[1] ?? 0) & 0x7f;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length));
      for (let index = 0; index < payload.byteLength; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
      if (opcode === 0x2) socket.write(Buffer.concat([Buffer.from([0x82, length]), payload]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return { port: (server.address() as AddressInfo).port, upgrades };
}

function forward(port: number, expiresAt = Date.now() + 60_000): RemotePortForward {
  return { forwardId: FORWARD_ID, port, expiresAt } as RemotePortForward;
}

describe("a port forward's listener on this computer", () => {
  it("carries a local connection's bytes to the other computer and back under a signed upgrade", async () => {
    const host = await echoingHost();
    const signed: RemoteServerForwarderSignRequest[] = [];
    const listening = await listenForPortForward(
      { hostId: HOST_ID, forward: forward(0) },
      {
        sign: async (request) => {
          signed.push(request);
          return { status: "signed", headers: { "x-octant-device-proof": "proof" } };
        },
        upgradeToHost: (request) =>
          upgradeThroughListener(
            {
              listenerOrigin: "https://192.168.1.20:9443",
              trust: { current: { kind: "platform" } },
            },
            request,
            async () => ({ status: "connected", socket: connectTcp(host.port, "127.0.0.1") }),
          ),
      },
    );
    if (listening.status !== "listening") throw new Error(listening.message);
    cleanups.push(listening.close);

    const client = connectTcp(listening.port, "127.0.0.1");
    cleanups.push(() => client.destroy());
    const echoed = new Promise<string>((resolve) =>
      client.once("data", (chunk: Buffer) => resolve(chunk.toString())),
    );
    client.write("SELECT 1;");
    expect(await echoed).toBe("SELECT 1;");
    expect(signed).toEqual([
      {
        hostId: HOST_ID,
        grantId: FORWARD_ID,
        method: "GET",
        pathQuery: `/api/server-proxy/${FORWARD_ID}`,
        bodyDigest: createHash("sha256").update("").digest("hex"),
      },
    ]);
    expect(host.upgrades).toEqual([{ url: `/api/server-proxy/${FORWARD_ID}`, proof: "proof" }]);
  });

  it("ends a local connection the window will not sign, without reaching the other computer", async () => {
    let reached = 0;
    const listening = await listenForPortForward(
      { hostId: HOST_ID, forward: forward(0) },
      {
        sign: async () => ({ status: "refused", reason: "no-window" }),
        upgradeToHost: async () => {
          reached += 1;
          throw new Error("unreachable");
        },
      },
    );
    if (listening.status !== "listening") throw new Error(listening.message);
    cleanups.push(listening.close);
    const client = connectTcp(listening.port, "127.0.0.1");
    await new Promise<void>((resolve) => client.on("close", () => resolve()));
    expect(reached).toBe(0);
  });

  it("listens on the other computer's port number when it is free, and stops listening when closed", async () => {
    const probe = createHttpServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const free = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const listening = await listenForPortForward(
      { hostId: HOST_ID, forward: forward(free) },
      {
        sign: async () => ({ status: "refused", reason: "no-window" }),
        upgradeToHost: async () => {
          throw new Error("unreachable");
        },
      },
    );
    if (listening.status !== "listening") throw new Error(listening.message);
    expect(listening.port).toBe(free);
    listening.close();
    const refused = await new Promise<boolean>((resolve) => {
      const socket = connectTcp(free, "127.0.0.1");
      socket.on("error", () => resolve(true));
      socket.on("connect", () => {
        socket.destroy();
        resolve(false);
      });
    });
    expect(refused).toBe(true);
  });
});
