import { mkdtempSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect as tlsConnect, createServer as createTlsServer } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "../privateListener.test-certs";
import {
  closeEgressHarnesses,
  exchange,
  openTunnel,
  roundTrip,
  startEgressHarness,
  tcpFixture,
  threadRule,
  waitFor,
} from "./nativeHarnessEgressProxy.test-support";

const directories: string[] = [];

afterEach(async () => {
  await closeEgressHarnesses();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("native harness tool egress proxy", () => {
  it("tunnels to an allowed host and summarizes what each side sent", async () => {
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      rules: [threadRule("registry.example.com", 443)],
      routes: new Map([["203.0.113.10", origin.port]]),
    });
    expect(harness.records.started).toEqual([
      expect.objectContaining({ launch: harness.launch, threadTainted: false }),
    ]);

    const tunnel = await openTunnel(
      harness.proxy,
      "registry.example.com:443",
      harness.authorization,
    );
    expect(tunnel.status).toBe(200);
    expect(await roundTrip(tunnel.socket, "ping", 4)).toBe("ping");
    tunnel.socket.end();
    await waitFor(() => origin.connections() === 1);

    const closed = await harness.proxy.close();
    expect(closed.status).toBe("summarized");
    expect(harness.dialed).toEqual([{ address: "203.0.113.10", port: 443 }]);
    expect(harness.records.summaries).toEqual([
      expect.objectContaining({
        bytesSent: 4,
        bytesReceived: 4,
        truncated: false,
        entries: [
          {
            host: "registry.example.com",
            port: 443,
            decision: "allowed",
            requests: 1,
            bytesSent: 4,
            bytesReceived: 4,
          },
        ],
      }),
    ]);
  });

  it("passes a TLS session whose server name is the CONNECT host", async () => {
    const accepted: Socket[] = [];
    const tlsOrigin = createTlsServer(
      { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
      (socket) => socket.end("hello over tls"),
    );
    tlsOrigin.on("connection", (socket: Socket) => accepted.push(socket));
    await new Promise<void>((resolve) => tlsOrigin.listen(0, "127.0.0.1", () => resolve()));
    const address = tlsOrigin.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const harness = await startEgressHarness({
        rules: [threadRule("registry.example.com", 443)],
        routes: new Map([["203.0.113.10", port]]),
      });
      const tunnel = await openTunnel(
        harness.proxy,
        "registry.example.com:443",
        harness.authorization,
      );
      const received = await new Promise<string>((resolve, reject) => {
        let text = "";
        const secure = tlsConnect({
          socket: tunnel.socket,
          servername: "Registry.Example.com",
          // The fixture certificate names another host; this test is about the tunnel.
          rejectUnauthorized: false,
        });
        secure.on("data", (chunk: Buffer) => {
          text += chunk.toString();
        });
        secure.on("end", () => resolve(text));
        secure.on("error", reject);
      });
      expect(received).toBe("hello over tls");
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => tlsOrigin.close(() => resolve()));
    }
  });

  it("forwards a plain request in origin form without the proxy credential or hop-by-hop fields", async () => {
    const origin = await tcpFixture((socket) => {
      socket.once("data", () =>
        socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"),
      );
    });
    const harness = await startEgressHarness({
      rules: [threadRule("files.example.com", 8080)],
      routes: new Map([["203.0.113.10", origin.port]]),
    });
    const answer = await exchange(
      harness.proxy,
      [
        "GET http://files.example.com:8080/pkg/a.tgz?v=1 HTTP/1.1",
        "Host: files.example.com:8080",
        `Proxy-Authorization: ${harness.authorization}`,
        "Proxy-Connection: keep-alive",
        "Connection: keep-alive, X-Hop",
        "Keep-Alive: timeout=5",
        "X-Hop: drop me",
        "User-Agent: fixture-client",
        "",
        "",
      ].join("\r\n"),
    );
    expect(answer).toBe("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
    expect(origin.seen()).toBe(
      [
        "GET /pkg/a.tgz?v=1 HTTP/1.1",
        "Host: files.example.com:8080",
        "User-Agent: fixture-client",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
  });

  it("listens on a socket in a private directory and removes it when the launch ends", async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), "octant-egress-")));
    directories.push(parent);
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      endpoint: { kind: "unix-socket", parentDirectory: parent },
      rules: [threadRule("registry.example.com", 443)],
      routes: new Map([["203.0.113.10", origin.port]]),
    });
    const endpoint = harness.proxy.endpoint;
    if (endpoint.kind !== "unix-socket") throw new Error("expected a socket endpoint");
    expect(statSync(dirname(endpoint.path)).mode & 0o777).toBe(0o700);
    const tunnel = await openTunnel(
      harness.proxy,
      "registry.example.com:443",
      harness.authorization,
    );
    expect(await roundTrip(tunnel.socket, "ping", 4)).toBe("ping");
    await harness.proxy.close();
    expect(existsSync(dirname(endpoint.path))).toBe(false);
  });

  it("records changed decisions sixteen at a time, and the rest on the interval", async () => {
    const harness = await startEgressHarness({ limits: { flushIntervalMs: 100 } });
    for (let index = 0; index < 17; index += 1) {
      await openTunnel(
        harness.proxy,
        `host${String(index)}.example.com:443`,
        harness.authorization,
      );
    }
    await waitFor(() => harness.records.batches.length === 2);
    expect(harness.records.batches.map((batch) => batch.entries.length)).toEqual([16, 1]);
    expect(harness.records.batches[0]?.entries[0]).toEqual({
      host: "host0.example.com",
      port: 443,
      decision: "refused",
      reason: "no-rule",
      requests: 1,
    });
  });

  it("caps the summary at 64 entries and still counts every byte received", async () => {
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      rules: [threadRule("registry.example.com", 443)],
      routes: new Map([["203.0.113.10", origin.port]]),
    });
    for (let index = 0; index < 70; index += 1) {
      await openTunnel(
        harness.proxy,
        `host${String(index)}.example.com:443`,
        harness.authorization,
      );
    }
    const tunnel = await openTunnel(
      harness.proxy,
      "registry.example.com:443",
      harness.authorization,
    );
    expect(await roundTrip(tunnel.socket, "abcdef", 6)).toBe("abcdef");
    await harness.proxy.close();
    const summary = harness.records.summaries[0];
    expect(summary?.truncated).toBe(true);
    expect(summary?.entries).toHaveLength(64);
    expect(summary?.entries.some((entry) => entry.decision === "allowed")).toBe(false);
    expect(summary?.bytesReceived).toBe(6);
  });
});
