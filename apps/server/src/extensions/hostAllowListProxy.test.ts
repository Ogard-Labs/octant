import { createServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostIsAllowed,
  isLocalNetworkAddress,
  startHostAllowListProxy,
  type HostAllowListProxy,
} from "./hostAllowListProxy";

let proxy: HostAllowListProxy | undefined;
afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
});

function connectVia(port: number, authority: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
    req.on("connect", (response, socket) => {
      socket.write("ping");
      socket.once("data", (data) => {
        socket.destroy();
        resolve({ status: response.statusCode ?? 0, body: data.toString() });
      });
      socket.once("close", () => resolve({ status: response.statusCode ?? 0, body: "" }));
    });
    req.on("response", (response) => resolve({ status: response.statusCode ?? 0, body: "" }));
    req.on("error", reject);
    req.end();
  });
}

describe("the host allow-list proxy", () => {
  it("matches a wildcard only below the named domain", () => {
    const allowed = ["*.jottacloud.com"];
    expect(hostIsAllowed("id.jottacloud.com", allowed)).toBe(true);
    expect(hostIsAllowed("jottacloud.com", allowed)).toBe(false);
    expect(hostIsAllowed("eviljottacloud.com", allowed)).toBe(false);
    expect(hostIsAllowed("jottacloud.com.evil.example", allowed)).toBe(false);
    expect(hostIsAllowed("127.0.0.1", ["*.0.0.1"])).toBe(false);
  });

  it("treats loopback, private and link-local addresses as the local network", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.0.5",
      "169.254.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
    ])
      expect(isLocalNetworkAddress(address)).toBe(true);
    expect(isLocalNetworkAddress("93.184.216.34")).toBe(false);
  });

  it("refuses a host that is not listed, a port other than 443, and a plain request", async () => {
    proxy = await startHostAllowListProxy({
      allowedHosts: ["*.jottacloud.com"],
      resolve: async () => "93.184.216.34",
    });
    expect((await connectVia(proxy.port, "example.com:443")).status).toBe(403);
    expect((await connectVia(proxy.port, "id.jottacloud.com:80")).status).toBe(403);
    const plain = await new Promise<number>((resolve) => {
      httpRequest(
        { host: "127.0.0.1", port: proxy?.port ?? 0, path: "http://id.jottacloud.com/" },
        (response) => resolve(response.statusCode ?? 0),
      ).end();
    });
    expect(plain).toBe(405);
  });

  it("refuses a listed name that resolves to this computer or a local network", async () => {
    proxy = await startHostAllowListProxy({
      allowedHosts: ["*.jottacloud.com"],
      resolve: async () => "127.0.0.1",
    });
    expect((await connectVia(proxy.port, "id.jottacloud.com:443")).status).toBe(403);
  });

  it("opens no upstream connection for a client that left or a proxy that stopped while resolving", async () => {
    let connections = 0;
    const upstream = createTcpServer(() => {
      connections += 1;
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    const upstreamPort = typeof address === "object" && address !== null ? address.port : 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = await startHostAllowListProxy({
      allowedHosts: ["*.jottacloud.com"],
      resolve: async () => {
        await gate;
        return "127.0.0.1";
      },
      refuseLocalNetwork: false,
      upstreamPort,
    });
    const pending = connectVia(running.port, "id.jottacloud.com:443").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await running.stop();
    release();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connections).toBe(0);
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it("tunnels a listed host and nothing else", async () => {
    const echo = createTcpServer((socket) =>
      socket.on("data", (data) => socket.write(`echo:${data.toString()}`)),
    );
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", () => resolve()));
    const address = echo.address();
    const upstreamPort = typeof address === "object" && address !== null ? address.port : 0;
    proxy = await startHostAllowListProxy({
      allowedHosts: ["*.jottacloud.com"],
      resolve: async () => "127.0.0.1",
      refuseLocalNetwork: false,
      upstreamPort,
    });
    expect(await connectVia(proxy.port, "id.jottacloud.com:443")).toEqual({
      status: 200,
      body: "echo:ping",
    });
    expect((await connectVia(proxy.port, "other.example.com:443")).status).toBe(403);
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    createServer().close();
  });
});
