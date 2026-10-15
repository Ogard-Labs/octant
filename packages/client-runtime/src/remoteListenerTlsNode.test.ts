import { createHash, X509Certificate } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { connect as connectTcp, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { createServer as createTlsServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectListener,
  secureListenerSocket,
  type ListenerConnection,
} from "./remoteListenerTlsNode";
import {
  EXPIRED_SELF_MADE_CERT,
  PLATFORM_TRUSTED_CERT,
  PLATFORM_TRUSTED_KEY,
  SELF_MADE_CERT,
  SELF_MADE_KEY,
  TEST_PLATFORM_ROOT,
} from "./remoteListenerTlsNode.test-certs";
import { listenerPinFromSha256, type ListenerOriginTrust } from "./remoteListenerTrust";

const HOSTNAME = "listener.octant.test";
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function pinOf(certificatePem: string): string {
  const spki = new X509Certificate(certificatePem).publicKey.export({
    type: "spki",
    format: "der",
  });
  return listenerPinFromSha256(createHash("sha256").update(spki).digest());
}

const SELF_MADE_PIN = pinOf(SELF_MADE_CERT);
const PLATFORM_TRUSTED_PIN = pinOf(PLATFORM_TRUSTED_CERT);
const pinned = (pin: string): ListenerOriginTrust => ({ current: { kind: "pinned", pin } });
const platform: ListenerOriginTrust = { current: { kind: "platform" } };

/** A TLS listener on loopback that records every byte that reaches it, before and after TLS. */
async function startListener(certificate: { readonly cert: string; readonly key: string }) {
  const rawBytes: number[] = [];
  const requestBytes: Buffer[] = [];
  const closedConnections: Array<Promise<void>> = [];
  const openSockets = new Set<Socket>();
  const server = createTlsServer({ cert: certificate.cert, key: certificate.key }, (socket) => {
    socket.on("data", (chunk: Buffer) => requestBytes.push(chunk));
    socket.on("error", () => undefined);
  });
  server.on("connection", (raw: Socket) => {
    openSockets.add(raw);
    closedConnections.push(
      new Promise((resolve) =>
        raw.once("close", () => {
          openSockets.delete(raw);
          resolve();
        }),
      ),
    );
    raw.on("data", (chunk: Buffer) => rawBytes.push(chunk.byteLength));
  });
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const socket of openSockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    port: address.port,
    rawByteCount: () => rawBytes.reduce((sum, count) => sum + count, 0),
    requestText: () => Buffer.concat(requestBytes).toString("utf8"),
    allClosed: () => Promise.all(closedConnections),
  };
}

function dialLoopback(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    socket.once("error", reject);
    socket.once("connect", () => resolve(socket));
  });
}

async function secureOverLoopback(
  port: number,
  trust: ListenerOriginTrust,
): Promise<ListenerConnection> {
  return secureListenerSocket({
    socket: await dialLoopback(port),
    hostname: HOSTNAME,
    trust,
    now: () => NOW,
    platformRoots: [TEST_PLATFORM_ROOT],
  });
}

async function send(connection: ListenerConnection, text: string): Promise<void> {
  if (connection.status !== "connected") throw new Error("Not connected.");
  await new Promise<void>((resolve) => connection.socket.end(text, resolve));
}

describe("a listener connection under its stored trust", () => {
  it("connects to a pinned origin that serves the pinned key, and carries the request", async () => {
    const listener = await startListener({ cert: SELF_MADE_CERT, key: SELF_MADE_KEY });

    const connection = await secureOverLoopback(listener.port, pinned(SELF_MADE_PIN));

    expect(connection).toMatchObject({ status: "connected", trust: pinned(SELF_MADE_PIN) });
    await send(connection, "GET /api/remote/hello");
    await listener.allClosed();
    expect(listener.requestText()).toBe("GET /api/remote/hello");
  });

  it("refuses a pinned origin that serves another key before any request byte leaves", async () => {
    const listener = await startListener({ cert: SELF_MADE_CERT, key: SELF_MADE_KEY });

    const connection = await secureOverLoopback(listener.port, pinned(PLATFORM_TRUSTED_PIN));

    expect(connection).toEqual({ status: "refused", reason: "pin-mismatch" });
    await listener.allClosed();
    expect(listener.requestText()).toBe("");
  });

  it("never lets platform trust stand in for the pin, even for a certificate the platform trusts", async () => {
    const listener = await startListener({
      cert: PLATFORM_TRUSTED_CERT,
      key: PLATFORM_TRUSTED_KEY,
    });

    // The same listener passes for an origin with no pin, so the platform does trust it.
    const unpinned = await secureOverLoopback(listener.port, platform);
    expect(unpinned.status).toBe("connected");
    if (unpinned.status === "connected") unpinned.socket.destroy();

    const connection = await secureOverLoopback(listener.port, pinned(SELF_MADE_PIN));

    expect(connection).toEqual({ status: "refused", reason: "pin-mismatch" });
    await listener.allClosed();
    expect(listener.requestText()).toBe("");
  });

  it("refuses a self-made certificate for an origin with no pin", async () => {
    const listener = await startListener({ cert: SELF_MADE_CERT, key: SELF_MADE_KEY });

    const connection = await secureOverLoopback(listener.port, platform);

    expect(connection).toEqual({ status: "refused", reason: "platform-untrusted" });
    await listener.allClosed();
    expect(listener.requestText()).toBe("");
  });

  it("ignores the certificate's dates for a pinned origin", async () => {
    const listener = await startListener({ cert: EXPIRED_SELF_MADE_CERT, key: SELF_MADE_KEY });

    const connection = await secureOverLoopback(listener.port, pinned(SELF_MADE_PIN));

    expect(connection.status).toBe("connected");
    if (connection.status === "connected") connection.socket.destroy();
  });

  it("makes a staged pin current on the first connection that passes only that pin", async () => {
    const listener = await startListener({ cert: SELF_MADE_CERT, key: SELF_MADE_KEY });
    const trust: ListenerOriginTrust = {
      current: { kind: "pinned", pin: PLATFORM_TRUSTED_PIN },
      staged: { trust: { kind: "pinned", pin: SELF_MADE_PIN }, until: "2026-11-01T00:00:00.000Z" },
    };

    const connection = await secureOverLoopback(listener.port, trust);

    expect(connection).toMatchObject({ status: "connected", trust: pinned(SELF_MADE_PIN) });
    if (connection.status === "connected") connection.socket.destroy();
  });
});

describe("the address a listener connection reaches", () => {
  it("refuses a *.ts.net name that resolves to a public address without dialling it", async () => {
    const dial = vi.fn(dialLoopback.bind(undefined, 1));

    const connection = await connectListener({
      origin: "https://funnel-host.example-tailnet.ts.net",
      trust: pinned(SELF_MADE_PIN),
      resolve: async () => ["203.0.113.7"],
      dial,
    });

    expect(connection).toEqual({ status: "refused", reason: "not-private-address" });
    expect(dial).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to a private and a public address", async () => {
    const dial = vi.fn(dialLoopback.bind(undefined, 1));

    const connection = await connectListener({
      origin: "https://listener.example-tailnet.ts.net:8443",
      trust: pinned(SELF_MADE_PIN),
      resolve: async () => ["100.101.102.103", "203.0.113.7"],
      dial,
    });

    expect(connection).toEqual({ status: "refused", reason: "not-private-address" });
    expect(dial).not.toHaveBeenCalled();
  });

  it("refuses a peer outside the private network before the TLS handshake starts", async () => {
    const listener = await startListener({ cert: SELF_MADE_CERT, key: SELF_MADE_KEY });
    const dialled: Array<{ readonly address: string; readonly port: number }> = [];

    const connection = await connectListener({
      origin: "https://listener.example-tailnet.ts.net:8443",
      trust: pinned(SELF_MADE_PIN),
      resolve: async () => ["100.101.102.103"],
      // A route that lands somewhere other than the judged address, as when a
      // platform resolves and connects in separate steps.
      dial: async (address, port) => {
        dialled.push({ address, port });
        return dialLoopback(listener.port);
      },
    });

    expect(dialled).toEqual([{ address: "100.101.102.103", port: 8443 }]);
    expect(connection).toEqual({ status: "refused", reason: "not-private-address" });
    await listener.allClosed();
    expect(listener.rawByteCount()).toBe(0);
  });

  it("refuses an origin whose address is public before dialling it", async () => {
    const dial = vi.fn(dialLoopback.bind(undefined, 1));

    const connection = await connectListener({
      origin: "https://203.0.113.7:8443",
      trust: pinned(SELF_MADE_PIN),
      dial,
    });

    expect(connection).toEqual({ status: "refused", reason: "not-private-address" });
    expect(dial).not.toHaveBeenCalled();
  });
});

describe("turning platform validation off", () => {
  it("happens only where the pin judgement decides instead", () => {
    // A client that skips chain validation without checking the pin would
    // accept any certificate, so only the listener connection may do it.
    const sourceRoots = [
      dirname(fileURLToPath(import.meta.url)),
      join(dirname(fileURLToPath(import.meta.url)), "../../cli/src"),
    ];
    const offenders = sourceRoots.flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((path) => /\.tsx?$/.test(path) && !/\.test(-certs)?\.tsx?$/.test(path))
        .filter((path) =>
          /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/.test(
            readFileSync(join(root, path), "utf8"),
          ),
        )
        .map((path) => join(root, path)),
    );

    expect(offenders).toEqual([
      join(dirname(fileURLToPath(import.meta.url)), "remoteListenerTlsNode.ts"),
    ]);
  });
});
