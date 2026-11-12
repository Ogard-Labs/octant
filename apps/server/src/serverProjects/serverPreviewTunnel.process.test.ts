import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServerPreviewTunnels } from "./serverPreviewTunnel";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("a server preview over a throwaway SSH server", () => {
  let ssh: ThrowawaySshd;
  let tunnels: ServerPreviewTunnels;
  const app = createServer((_request, response) => response.end("remote app"));
  let remotePort = 0;
  const upgrades = new Set<Duplex>();
  beforeAll(async () => {
    ssh = await startThrowawaySshd();
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const address = app.address();
    if (address === null || typeof address === "string") throw new Error("missing app address");
    remotePort = address.port;
    app.on("upgrade", (request, socket) => {
      upgrades.add(socket);
      socket.once("close", () => upgrades.delete(socket));
      const key = request.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.write(Buffer.from([0x81, 3, 104, 109, 114]));
      socket.on("error", () => socket.destroy());
      socket.on("data", () => socket.end());
    });
    tunnels = new ServerPreviewTunnels({
      now: () => Date.now(),
      address: () => ({ server: { alias: ssh.alias, user: ssh.user }, identity: "same" }),
      ownerCurrent: () => true,
      agentSocket: () => ssh.agentSocket,
      configFile: ssh.configFile,
      record: () => true,
    });
  });
  afterAll(async () => {
    await tunnels?.close();
    for (const socket of upgrades) socket.destroy();
    app.closeAllConnections();
    ssh?.stop();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  });
  it("forwards HTTP and WebSocket hot reload without running a remote program", async () => {
    const result = await tunnels.start("site", "person", remotePort, 0);
    expect(result.kind).toBe("tunnel");
    if (result.kind !== "tunnel") return;
    expect(await (await fetch(result.view.endpoint)).text()).toBe("remote app");
    const message = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(result.view.endpoint.replace("http:", "ws:"));
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket did not answer"));
      }, 5_000);
      socket.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(String(event.data));
        socket.close();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket failed"));
      };
    });
    expect(message).toBe("hmr");
    expect(await (await fetch(result.view.endpoint)).text()).toBe("remote app");
    expect(tunnels.read("site", "person")?.status).toBe("listening");
    await tunnels.stop("site", "person");
  });
  it("shows a dropped connection and reconnects only the same selected endpoint", async () => {
    const result = await tunnels.start("site", "person", remotePort, 0);
    if (result.kind !== "tunnel") throw new Error("preview refused");
    const socket = new WebSocket(result.view.endpoint.replace("http:", "ws:"));
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed"));
    });
    ssh.dropConnections();
    await expect.poll(() => tunnels.read("site", "person")?.status).toBe("lost");
    expect(await tunnels.reconnect("site", "person")).toMatchObject({
      kind: "tunnel",
      view: { remotePort, localPort: result.view.localPort },
    });
    expect(await (await fetch(result.view.endpoint)).text()).toBe("remote app");
    socket.close();
  });
});
