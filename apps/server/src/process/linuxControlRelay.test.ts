import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startLinuxControlRelay } from "./linuxControlRelay";

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe.skipIf(process.platform !== "linux")("confined provider control", () => {
  it("waits for ownership and keeps the authenticated endpoint after its socket path is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-control-"));
    const socketPath = join(root, "source.sock");
    let connections = 0;
    const endpoint = createServer((socket) => {
      connections += 1;
      socket.once("data", (request) => {
        const authenticated = request.toString().includes("Authorization: Basic secret");
        socket.end(
          `HTTP/1.1 ${authenticated ? "200 OK" : "401 Unauthorized"}\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK`,
        );
      });
    });
    let release = () => {};
    const launchReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let exit = () => {};
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    await listen(endpoint, socketPath);
    const relay = startLinuxControlRelay({
      socketPath,
      ownerDirectory: join(root, "authority"),
      exited,
      launchReady,
      timeoutMs: 3000,
      onLost: () => {
        throw new Error("Unexpected relay loss");
      },
    });
    const impostor = createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(connections).toBe(0);
      release();
      const url = await relay.ready;
      await unlink(socketPath);
      await listen(impostor, socketPath);
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { Authorization: "Basic secret" } })).status).toBe(200);
      expect(connections).toBe(3);
      exit();
      await relay.close();
      await expect(fetch(url)).rejects.toThrow();
    } finally {
      release();
      exit();
      await relay.close();
      await close(endpoint);
      await close(impostor);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels a provider before its private endpoint exists without leaving a listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-control-"));
    let exit = () => {};
    const relay = startLinuxControlRelay({
      socketPath: join(root, "absent.sock"),
      ownerDirectory: join(root, "authority"),
      exited: new Promise<void>((resolve) => {
        exit = resolve;
      }),
      launchReady: Promise.resolve(),
      timeoutMs: 3000,
      onLost: () => {
        throw new Error("Unexpected relay loss");
      },
    });
    try {
      exit();
      await expect(relay.ready).rejects.toThrow();
      await relay.close();
    } finally {
      await relay.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
