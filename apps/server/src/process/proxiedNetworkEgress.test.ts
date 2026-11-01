import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decideProviderRuntimeEgress } from "@octant/domain/safe-network-policy";
import { startEgressHarness } from "../harness/nativeHarnessEgressProxy.test-support";
import { LINUX_EGRESS_FORWARDER_SOURCE, proxiedLaunchEnvironment } from "./proxiedNetworkEgress";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The forwarder runs inside the Linux capsule, but it is plain Node, so its
// relay and exit behaviour are checked here on any host with a free port
// standing in for the capsule's fixed one.
describe("Linux egress forwarder", () => {
  async function forwarderFixture() {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-forwarder-")));
    directories.push(directory);
    const script = join(directory, "forwarder.cjs");
    writeFileSync(script, LINUX_EGRESS_FORWARDER_SOURCE);
    const socket = join(directory, "proxy.sock");
    const received: string[] = [];
    // The host proxy's side: answers each connection with what it read.
    const proxy = createServer({ allowHalfOpen: true }, (connection) => {
      let text = "";
      connection.on("data", (chunk: Buffer) => {
        text += chunk.toString("latin1");
      });
      connection.on("end", () => {
        received.push(text);
        connection.end(`proxy saw ${text}`);
      });
    });
    servers.push(proxy);
    await new Promise<void>((done) => proxy.listen(socket, () => done()));
    const port = await freePort();
    const run = (command: ReadonlyArray<string>) =>
      new Promise<{
        readonly code: number | null;
        readonly stdout: string;
        readonly stderr: string;
      }>((done) => {
        const child = spawn(process.execPath, [script, socket, String(port), ...command]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => done({ code, stdout, stderr }));
      });
    return { run, port, received };
  }

  it("relays the command's loopback connection to the host socket byte for byte", async () => {
    const forwarder = await forwarderFixture();
    const client = [
      "const net = require('node:net');",
      `const socket = net.connect({ host: '127.0.0.1', port: ${forwarder.port}, allowHalfOpen: true });`,
      "let answer = '';",
      "socket.on('data', (chunk) => (answer += chunk));",
      "socket.on('end', () => process.stdout.write(answer));",
      "socket.end('CONNECT registry.example.com:443 HTTP/1.1\\r\\n\\r\\n');",
    ].join("\n");

    const result = await forwarder.run([process.execPath, "-e", client]);

    expect(result).toMatchObject({
      code: 0,
      stdout: "proxy saw CONNECT registry.example.com:443 HTTP/1.1\r\n\r\n",
    });
    expect(forwarder.received).toEqual(["CONNECT registry.example.com:443 HTTP/1.1\r\n\r\n"]);
  });

  it("exits with the command's status", async () => {
    const forwarder = await forwarderFixture();
    expect((await forwarder.run(["/bin/sh", "-c", "exit 7"])).code).toBe(7);
  });

  it("never runs the command when it cannot listen", async () => {
    const forwarder = await forwarderFixture();
    const taken = createServer();
    servers.push(taken);
    await new Promise<void>((done) => taken.listen(forwarder.port, "127.0.0.1", () => done()));
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-forwarder-marker-")));
    directories.push(directory);
    const marker = join(directory, "ran");

    const result = await forwarder.run(["/usr/bin/touch", marker]);

    expect(result.code).toBe(125);
    expect(result.stderr).toContain("octant-egress-forwarder: cannot listen");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("Linux egress forwarder loopback relay", () => {
  it("carries a tool bridge connection through the launch's proxy, and only to the launch's own port", async () => {
    // A Unix socket path has a short limit, and macOS's own temporary folder is long.
    const directory = realpathSync(mkdtempSync("/tmp/octant-relay-"));
    directories.push(directory);
    const script = join(directory, "forwarder.cjs");
    writeFileSync(script, LINUX_EGRESS_FORWARDER_SOURCE);
    // The host's tool bridge, which the proxy dials for the launch's own port.
    const bridge = createServer((connection) => {
      connection.on("data", (chunk: Buffer) => connection.end(`bridge saw ${chunk.toString()}`));
    });
    servers.push(bridge);
    await new Promise<void>((done) => bridge.listen(0, "127.0.0.1", () => done()));
    const address = bridge.address();
    const bridgePort = typeof address === "object" && address !== null ? address.port : 0;
    const relayPort = await freePort();
    const otherPort = await freePort();
    const forwarderPort = await freePort();
    const harness = await startEgressHarness({
      endpoint: { kind: "unix-socket", parentDirectory: directory },
      decision: {
        kind: "provider-runtime",
        decide: (destination) =>
          decideProviderRuntimeEgress({
            destination,
            providerDomains: [],
            launchLoopbackPorts: [relayPort],
            places: [],
            projectRules: [],
            reviewerAllowed: [],
            now: new Date().toISOString(),
          }),
        privateAddressAllowed: ({ address: dialed, port, by }) =>
          by === "launch" && dialed === "127.0.0.1" && port === relayPort,
      },
      resolve: async (host) => [host],
      // Outside a capsule the relay and the bridge cannot share a port, so the dialer maps one to the other.
      routes: new Map([["127.0.0.1", bridgePort]]),
    });
    const endpoint = harness.proxy.endpoint;
    if (endpoint.kind !== "unix-socket") throw new Error("Expected a socket endpoint.");
    const client = (port: number) =>
      [
        "const net = require('node:net');",
        `const socket = net.connect({ host: '127.0.0.1', port: ${port} });`,
        "let answer = '';",
        "socket.on('data', (chunk) => (answer += chunk));",
        "socket.on('error', () => undefined);",
        "socket.on('close', () => process.stdout.write(answer === '' ? 'closed' : answer));",
        "socket.write('ping');",
      ].join("\n");
    const run = (port: number) =>
      new Promise<string>((done) => {
        const child = spawn(
          process.execPath,
          [
            script,
            endpoint.path,
            String(forwarderPort),
            "--loopback",
            String(relayPort),
            "--loopback",
            String(otherPort),
            process.execPath,
            "-e",
            client(port),
          ],
          {
            env: {
              ...process.env,
              ...proxiedLaunchEnvironment(endpoint, harness.proxy.token),
            },
          },
        );
        let stdout = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.on("close", () => done(stdout));
      });

    expect(await run(relayPort)).toBe("bridge saw ping");
    // A relay port the launch does not serve is refused at the proxy.
    expect(await run(otherPort)).toBe("closed");
    const closed = await harness.proxy.close();
    expect(closed.status === "summarized" ? closed.summary.entries : []).toEqual([
      expect.objectContaining({ host: "127.0.0.1", port: relayPort, decision: "allowed" }),
      expect.objectContaining({ host: "127.0.0.1", port: otherPort, decision: "refused" }),
    ]);
  });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
