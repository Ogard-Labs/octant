import { mkdtempSync, realpathSync, rmSync, statSync, existsSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkServerIdentity,
  connect as tlsConnect,
  createServer as createTlsServer,
} from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { decideProviderRuntimeEgress } from "@octant/domain/safe-network-policy";
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
      routes: new Map([["93.184.216.10", origin.port]]),
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
    expect(harness.dialed).toEqual([{ address: "93.184.216.10", port: 443 }]);
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

  it("decides a provider runtime's requests by its decider, and refuses a private answer the decider does not trust", async () => {
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      decision: {
        kind: "provider-runtime",
        decide: (destination) =>
          decideProviderRuntimeEgress({
            destination,
            providerDomains: ["provider.example"],
            launchLoopbackPorts: [],
            places: [],
            projectRules: [],
            reviewerAllowed: [],
            now: new Date().toISOString(),
          }),
        privateAddressAllowed: () => false,
      },
      resolve: async (host) =>
        host === "metadata.provider.example" ? ["169.254.169.254"] : ["93.184.216.10"],
      routes: new Map([["93.184.216.10", origin.port]]),
    });
    const allowed = await openTunnel(
      harness.proxy,
      "api.provider.example:443",
      harness.authorization,
    );
    expect(allowed.status).toBe(200);
    expect(await roundTrip(allowed.socket, "ping", 4)).toBe("ping");
    allowed.socket.end();
    for (const [target, reason] of [
      ["metadata.provider.example:443", "private-destination"],
      ["registry.npmjs.org:443", "no-rule registry.npmjs.org:443"],
      ["169.254.169.254:80", "ip-literal"],
      ["metadata:80", "invalid-name"],
    ] as const) {
      const refused = await openTunnel(harness.proxy, target, harness.authorization);
      expect(refused.status).toBe(403);
      expect(refused.answer).toContain(`octant-egress-refused: ${reason}`);
    }
    await waitFor(() => origin.connections() === 1);
    const closed = await harness.proxy.close();
    expect(closed.status).toBe("summarized");
    expect(harness.dialed).toEqual([{ address: "93.184.216.10", port: 443 }]);
  });

  it("asks a provider runtime's reviewer hook about an unlisted host and decides again afterwards", async () => {
    const origin = await tcpFixture();
    const allowed: Array<{ readonly host: string; readonly port: number }> = [];
    const asked: string[] = [];
    const harness = await startEgressHarness({
      decision: {
        kind: "provider-runtime",
        decide: (destination) =>
          decideProviderRuntimeEgress({
            destination,
            providerDomains: [],
            launchLoopbackPorts: [],
            places: [],
            projectRules: [],
            reviewerAllowed: allowed,
            now: new Date().toISOString(),
          }),
        privateAddressAllowed: () => false,
        escalate: async (destination) => {
          asked.push(destination.host);
          if (destination.host === "pypi.org") allowed.push(destination);
        },
      },
      routes: new Map([["93.184.216.10", origin.port]]),
    });
    const passed = await openTunnel(harness.proxy, "pypi.org:443", harness.authorization);
    expect(passed.status).toBe(200);
    passed.socket.end();
    const refused = await openTunnel(harness.proxy, "evil.example:443", harness.authorization);
    expect(refused.status).toBe(403);
    expect(refused.answer).toContain("octant-egress-refused: no-rule evil.example:443");
    expect(asked).toEqual(["pypi.org", "evil.example"]);
  });

  it("lets a harness command reach a trusted place its rules do not name, until its thread is tainted", async () => {
    const origin = await tcpFixture();
    let tainted = false;
    const harness = await startEgressHarness({
      places: () => [
        { kind: "domain", domain: "corp.example" },
        { kind: "private-network", tag: "local-network" },
      ],
      taint: () => ({ threadTainted: tainted, parentTainted: false }),
      resolve: async (host) =>
        host === "git.corp.example"
          ? ["10.0.0.7"]
          : host === "rule.example"
            ? ["192.168.1.9"]
            : ["93.184.216.10"],
      rules: [threadRule("rule.example", 443)],
      routes: new Map([
        ["10.0.0.7", origin.port],
        ["192.168.1.9", origin.port],
      ]),
    });
    const placed = await openTunnel(harness.proxy, "git.corp.example:443", harness.authorization);
    expect(placed.status).toBe(200);
    expect(await roundTrip(placed.socket, "ping", 4)).toBe("ping");
    // A thread rule never reaches a private answer; the trusted range does.
    const ruled = await openTunnel(harness.proxy, "rule.example:443", harness.authorization);
    expect(ruled.status).toBe(200);
    ruled.socket.end();
    const unlisted = await openTunnel(harness.proxy, "evil.example:443", harness.authorization);
    expect(unlisted.answer).toContain("octant-egress-refused: no-rule evil.example:443");

    tainted = true;
    harness.proxy.recheck();
    await waitFor(() => placed.socket.destroyed || placed.socket.readableEnded);
    const afterTaint = await openTunnel(
      harness.proxy,
      "git.corp.example:443",
      harness.authorization,
    );
    expect(afterTaint.status).toBe(403);
    expect(afterTaint.answer).toContain("octant-egress-refused: no-rule git.corp.example:443");
  });

  it("keeps a trusted name's private answer when a thread rule names the same host", async () => {
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      places: () => [{ kind: "host", host: "nas.example", port: 443 }],
      resolve: async () => ["10.0.0.7"],
      rules: [threadRule("nas.example", 443)],
      routes: new Map([["10.0.0.7", origin.port]]),
    });
    const tunnel = await openTunnel(harness.proxy, "nas.example:443", harness.authorization);
    expect(tunnel.status).toBe(200);
    tunnel.socket.end();
  });

  it("refuses a private answer for a host a thread rule names when no place holds it", async () => {
    const harness = await startEgressHarness({
      places: () => [{ kind: "host", host: "other.example" }],
      resolve: async () => ["10.0.0.7"],
      rules: [threadRule("rule.example", 443)],
    });
    const refused = await openTunnel(harness.proxy, "rule.example:443", harness.authorization);
    expect(refused.status).toBe(403);
    expect(refused.answer).toContain("octant-egress-refused: private-destination");
    expect(harness.dialed).toEqual([]);
  });

  it("asks the reviewer hook about a harness command's unlisted host and passes only what a rule then allows", async () => {
    const origin = await tcpFixture();
    const asked: string[] = [];
    const rules: ReturnType<typeof threadRule>[] = [];
    const harness = await startEgressHarness({
      rulesRead: () => rules,
      escalate: async (destination) => {
        asked.push(destination.host);
        if (destination.host === "pypi.org") rules.push(threadRule("pypi.org", 443));
      },
      routes: new Map([["93.184.216.10", origin.port]]),
    });
    const passed = await openTunnel(harness.proxy, "pypi.org:443", harness.authorization);
    expect(passed.status).toBe(200);
    passed.socket.end();
    const refused = await openTunnel(harness.proxy, "evil.example:443", harness.authorization);
    expect(refused.status).toBe(403);
    expect(refused.answer).toContain("octant-egress-refused: no-rule evil.example:443");
    expect(asked).toEqual(["pypi.org", "evil.example"]);
  });

  it("serves a client that cannot send the launch token only when the launch asked for no token", async () => {
    const origin = await tcpFixture();
    const decision = {
      kind: "provider-runtime" as const,
      decide: (destination: { readonly host: string; readonly port: number }) =>
        decideProviderRuntimeEgress({
          destination,
          providerDomains: ["provider.example"],
          launchLoopbackPorts: [],
          places: [],
          projectRules: [],
          reviewerAllowed: [],
          now: new Date().toISOString(),
        }),
      privateAddressAllowed: () => false,
    };
    const tokenless = await startEgressHarness({
      decision,
      authentication: "none",
      routes: new Map([["93.184.216.10", origin.port]]),
    });
    const passed = await openTunnel(tokenless.proxy, "api.provider.example:443", undefined);
    expect(passed.status).toBe(200);
    passed.socket.end();
    const tokened = await startEgressHarness({
      decision,
      routes: new Map([["93.184.216.10", origin.port]]),
    });
    const refused = await openTunnel(tokened.proxy, "api.provider.example:443", undefined);
    expect(refused.status).toBe(407);
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
        routes: new Map([["93.184.216.10", port]]),
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
          ca: PRIVATE_LISTENER_TEST_CERT,
          // The chain is verified against the fixture; its certificate names
          // the address it was issued for, so the identity is checked there.
          checkServerIdentity: (_host, certificate) =>
            checkServerIdentity("192.168.1.20", certificate),
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
      routes: new Map([["93.184.216.10", origin.port]]),
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
      routes: new Map([["93.184.216.10", origin.port]]),
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

  it("summarizes every refusal past the named ones under one entry and still counts every byte received", async () => {
    const origin = await tcpFixture();
    const harness = await startEgressHarness({
      rules: [threadRule("registry.example.com", 443)],
      routes: new Map([["93.184.216.10", origin.port]]),
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
    expect(summary?.truncated).toBe(false);
    expect(summary?.entries).toHaveLength(30);
    expect(summary?.entries).toContainEqual({
      host: "overflow.invalid",
      port: 0,
      decision: "refused",
      reason: "no-rule",
      requests: 42,
    });
    expect(summary?.entries.at(-1)).toMatchObject({
      host: "registry.example.com",
      decision: "allowed",
      bytesReceived: 6,
    });
    expect(summary?.bytesReceived).toBe(6);
  });
});
