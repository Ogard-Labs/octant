// Pairing from an app pairing code against an in-process host: the real
// remote gateway, its pairing service, and a certificate the host made
// itself, served over real TLS. The client side is the shared client-runtime
// code reader and the Node transport held to the code's pin, as the desktop
// app's main process uses them. Only the network seams differ from a real
// pairing: the listener's Tailscale address is dialled on loopback.

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createExchangeListenerFetch,
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  openAppPairingCode,
  type PinnedListenerExchangeOpening,
  type PinnedListenerExchangePort,
  type PinnedListenerExchangeRead,
  type PinnedListenerExchangeRequest,
  type PinnedListenerTransportPort,
} from "@octant/client-runtime";
import { testOnlyListenerTls } from "@octant/client-runtime/remote-listener-tls-node";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { buildPairingCode } from "@octant/domain";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { RequestTransportFacts, Serve } from "../server";
import { createRemoteGateway } from "./remoteGateway";
import { createSelfMadeListenerCertificateStore } from "./selfMadeListenerCertificate";

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const ADDRESS = "100.101.102.103";
const ORIGIN = `https://${ADDRESS}:8443`;
const tailscaleFacts: RequestTransportFacts = {
  listenerTrust: "remote",
  sourceClass: "tailscale",
  sourceKey: "opaque-tailscale-source-key",
};
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host: a real gateway behind a real TLS listener serving its self-made certificate. */
async function startHost(options: { readonly now: () => number }) {
  const directory = mkdtempSync(join(tmpdir(), "octant-pairing-code-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const connection = openSqlite(join(directory, "store.sqlite3"));
  const isoNow = () => new Date(options.now()).toISOString();
  applyMigrations(connection, MIGRATIONS, isoNow);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: isoNow,
  });
  const hostKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const hostPublicDer = hostKeys.publicKey.export({ format: "der", type: "spki" });
  const hostKeyFingerprint = createHash("sha256").update(hostPublicDer).digest("hex");
  journal.append({
    aggregate: { aggregateType: "remote-host", aggregateId: hostId },
    expectedVersion: 0,
    events: [
      {
        eventId: "55555555-5555-4555-8555-555555555555",
        eventName: "remote.host-identity-initialized@1",
        eventVersion: 1,
        correlationId: "44444444-4444-4444-8444-444444444444",
        actor: { kind: "system", actorId: "33333333-3333-4333-8333-333333333333" },
        occurredAt: isoNow(),
        payload: {
          hostId,
          displayName: "Studio Mac",
          hostKeyFingerprint,
          keyGeneration: 1,
          createdAt: isoNow(),
        },
      },
    ],
  });
  const certificate = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(
    ADDRESS,
  );
  if (certificate.status !== "ready") throw new Error(certificate.code);

  let gatewayFetch:
    | ((request: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
  const serve: Serve = (serveOptions) => {
    gatewayFetch = serveOptions.fetch as typeof gatewayFetch;
    return { url: new URL(ORIGIN), stop: vi.fn(async () => {}) };
  };
  const gateway = createRemoteGateway({
    connection,
    journal,
    hostId,
    displayName: "Studio Mac",
    serverBuildVersion: "0.1.0",
    signing: {
      hostKeyFingerprint,
      hostPublicKey: hostPublicDer.toString("base64url"),
      signHostPayload: (payload: string) =>
        sign("sha256", Buffer.from(payload, "utf8"), {
          key: hostKeys.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
    },
    webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
    serve,
    now: options.now,
    clock: isoNow,
    config: {
      listener: { hostname: ADDRESS, port: 8443, origin: ORIGIN, tls: certificate.tls },
    },
  });
  await gateway.start();
  cleanups.push(() => gateway.stop());

  const requests: string[] = [];
  const listener: Server = createHttpsServer(certificate.tls, (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push(`${incoming.method} ${incoming.url?.split("?")[0]}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(`${ORIGIN}${incoming.url}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      });
      void (async () => {
        if (gatewayFetch === undefined) throw new Error("The gateway is not serving.");
        const response = await gatewayFetch(request, tailscaleFacts);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })();
    });
  });
  listener.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        listener.closeAllConnections();
        listener.close(() => resolve());
      }),
  );
  const administration = gateway.localDeviceAdministration();
  if (administration === undefined) throw new Error("No local administration.");
  return { port: address.port, pin: certificate.tlsPin, administration, requests };
}

/** The network seams of the Node transport, dialling the listener's address on loopback. */
function loopbackNetwork(port: number) {
  return {
    resolve: async () => [ADDRESS],
    dial: (address: string) =>
      new Promise<Socket>((resolve, reject) => {
        expect(address).toBe(ADDRESS);
        const socket = connectTcp({ host: "127.0.0.1", port });
        socket.once("error", reject);
        socket.once("connect", () => {
          Object.defineProperty(socket, "remoteAddress", { value: ADDRESS });
          resolve(socket);
        });
      }),
    handshakeTimeoutMs: 5_000,
  };
}

/** The Node transport held to the code's pin, dialling the listener's address on loopback. */
function pinnedTransport(port: number): PinnedListenerTransportPort {
  return ({ origin, trust }) => ({
    status: "available",
    fetch: testOnlyListenerTls.createListenerFetchOver({ origin, trust }, loopbackNetwork(port)),
  });
}

function pairingCode(input: {
  readonly ticketId: string;
  readonly ticketProof: string;
  readonly pin: string;
  readonly origin?: string;
}): string {
  const built = buildPairingCode({
    origin: input.origin ?? ORIGIN,
    ticketId: input.ticketId,
    ticketProof: input.ticketProof,
    pin: input.pin,
  });
  if (built.status !== "built") throw new Error(built.reason);
  return built.code;
}

describe("pairing from an app pairing code with a host that made its own certificate", () => {
  it("pairs from the code alone, pinned to the certificate, and opens a session", async () => {
    const host = await startHost({ now: () => Date.now() });
    const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
    const deviceKeyStore = createInMemoryDeviceKeyStore();
    const transport = pinnedTransport(host.port);

    const opened = await openAppPairingCode({
      code: pairingCode({ ...ticket, pin: host.pin }),
      transport,
      webBuildVersion: "0.1.0",
      deviceKeyStore,
    });
    if (opened.status !== "opened") throw new Error(opened.message);
    expect(opened.hostHello).toMatchObject({ hostId, displayName: "Studio Mac" });
    const claimed = await opened.claim("Ada's laptop");
    if (claimed.status !== "claimed") throw new Error(claimed.message);
    host.administration.approvePairing({ ticketId: ticket.ticketId });
    const status = await opened.client.pollPairingStatus({
      ticket: opened.ticket,
      claim: claimed.claim,
    });
    if (status.kind !== "approved") throw new Error(`pairing ${status.kind}`);

    expect(status.approval.listenerTrust).toEqual({
      current: { kind: "pinned", pin: host.pin },
    });
    await expect(deviceKeyStore.findByOrigin(ORIGIN)).resolves.toMatchObject({
      hostId,
      listenerTrust: { current: { kind: "pinned", pin: host.pin } },
    });

    const transportForSession = transport({
      origin: ORIGIN,
      trust: status.approval.listenerTrust,
    });
    if (transportForSession.status !== "available") throw new Error("No pinned transport.");
    const bridge = createRemoteSessionBridge({
      fetch: transportForSession.fetch,
      deviceKeyStore,
    });
    bridge.connect(status.approval);
    await vi.waitFor(() => expect(bridge.getState().kind).toBe("ready"), { timeout: 10_000 });
    bridge.disconnect();
  });

  it("refuses a code whose pin is not the listener's key before any request reaches the host", async () => {
    const host = await startHost({ now: () => Date.now() });
    const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
    const wrongPin = `sha256-${Buffer.alloc(32, 9).toString("base64url")}`;

    const opened = await openAppPairingCode({
      code: pairingCode({ ...ticket, pin: wrongPin }),
      transport: pinnedTransport(host.port),
      webBuildVersion: "0.1.0",
    });

    expect(opened).toMatchObject({ status: "refused", reason: "pin-mismatch" });
    expect(host.requests).toEqual([]);
    expect(host.administration.listPendingPairings()).toEqual([]);
  });

  it("refuses an expired ticket at the host and leaves no claim to approve", async () => {
    // Host and device share one clock, moved past the ticket's five minutes.
    let now = Date.now();
    const host = await startHost({ now: () => now });
    const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
    // The host's clock refuses a forward jump larger than two minutes, so
    // it is walked past the five minutes with an observation at each step.
    const transport = pinnedTransport(host.port)({
      origin: ORIGIN,
      trust: { current: { kind: "pinned", pin: host.pin } },
    });
    if (transport.status !== "available") throw new Error("No pinned transport.");
    for (let step = 0; step < 4; step += 1) {
      now += 90_000;
      await transport.fetch(`${ORIGIN}/api/remote/hello`);
    }

    const opened = await openAppPairingCode({
      code: pairingCode({ ...ticket, pin: host.pin }),
      transport: pinnedTransport(host.port),
      webBuildVersion: "0.1.0",
      now: () => now,
    });
    if (opened.status !== "opened") throw new Error(opened.message);
    const claimed = await opened.claim("Ada's laptop");

    expect(claimed.status).toBe("failed");
    expect(host.administration.listPendingPairings()).toEqual([]);
  });

  it("refuses a code whose address was changed to a public one without contacting anything", async () => {
    const host = await startHost({ now: () => Date.now() });
    const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
    const transport = vi.fn(pinnedTransport(host.port));
    const genuine = pairingCode({ ...ticket, pin: host.pin });
    // Rewrite the origin inside the code, as someone passing it along could.
    const payload = JSON.parse(
      Buffer.from(genuine.slice("octant-pair-1.".length), "base64url").toString("utf8"),
    ) as Record<string, string>;
    const tampered = `octant-pair-1.${Buffer.from(
      JSON.stringify({ ...payload, origin: "https://203.0.113.7:8443" }),
    ).toString("base64url")}`;

    const opened = await openAppPairingCode({
      code: tampered,
      transport,
      webBuildVersion: "0.1.0",
    });

    expect(opened).toMatchObject({ status: "refused", reason: "not-private" });
    expect(transport).not.toHaveBeenCalled();
    expect(host.requests).toEqual([]);
  });
});

// The phone's transport: the shared exchange fetch over a native exchange
// that dials the judged address, refuses a key outside the pins during the
// handshake, writes the request only after that, and hands the reply back
// chunk by chunk. Three exchanges keep that contract here: one in Node; the
// phone's own iOS exchange source built for this Mac with swiftc, which runs
// only where swiftc exists; and the phone's own Android exchange source built
// for a desktop JVM with kotlinc, which runs only where kotlinc and java exist.

const PHONE_MODULE = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../mobile/modules/octant-pinned-tls",
);

type Exchange = PinnedListenerExchangePort["open"];

/** Reads arrive in order; a read waits until the next one exists. */
function readQueue() {
  const ready: PinnedListenerExchangeRead[] = [];
  const waiting: Array<(read: PinnedListenerExchangeRead) => void> = [];
  let finished = false;
  return {
    push(read: PinnedListenerExchangeRead): void {
      if (finished) return;
      if (read.status !== "data") finished = true;
      const next = waiting.shift();
      if (next === undefined) ready.push(read);
      else next(read);
    },
    read(): Promise<PinnedListenerExchangeRead> {
      const next = ready.shift();
      if (next !== undefined) return Promise.resolve(next);
      if (finished) return Promise.resolve({ status: "end" });
      return new Promise((resolveRead) => waiting.push(resolveRead));
    },
  };
}

/**
 * The native contract kept in Node, over the client runtime's own judged
 * connection: the pin decides inside the handshake, before any write.
 */
function nodeExchange(listenerPort: number): Exchange {
  return async (request) => {
    expect(request.address).toBe(ADDRESS);
    const [current, staged] = request.pins;
    if (current === undefined) return { status: "refused", servedPin: undefined };
    const connection = await testOnlyListenerTls.connectListenerOver(
      {
        origin: ORIGIN,
        trust: {
          current: { kind: "pinned", pin: current },
          ...(staged === undefined
            ? {}
            : {
                staged: {
                  trust: { kind: "pinned", pin: staged },
                  until: new Date(Date.now() + 60_000).toISOString(),
                },
              }),
        },
      },
      loopbackNetwork(listenerPort),
    );
    if (connection.status === "refused") return { status: "refused", servedPin: undefined };
    if (connection.status === "failed") return { status: "failed", reason: "connection-failed" };
    const socket = connection.socket;
    const servedPin =
      connection.trust.current.kind === "pinned" ? connection.trust.current.pin : "";
    const reads = readQueue();
    socket.on("data", (chunk: Buffer) =>
      reads.push({ status: "data", chunk: new Uint8Array(chunk) }),
    );
    socket.once("end", () => reads.push({ status: "end" }));
    socket.once("close", () => reads.push({ status: "end" }));
    socket.once("error", () => reads.push({ status: "failed" }));
    await new Promise<void>((written) => socket.write(request.request, () => written()));
    return { status: "opened", servedPin, read: reads.read, close: () => socket.destroy() };
  };
}

/**
 * A phone exchange run as a command built from the app's own native source:
 * it writes one JSON line for the opening, then one per read.
 */
function commandExchange(
  start: (input: {
    readonly port: number;
    readonly serverName: string | null;
    readonly pins: ReadonlyArray<string>;
    readonly request: string;
  }) => ChildProcessWithoutNullStreams,
  listenerPort: number,
): Exchange {
  return (request: PinnedListenerExchangeRequest) =>
    new Promise<PinnedListenerExchangeOpening>((resolveOpening, reject) => {
      expect(request.address).toBe(ADDRESS);
      const child = start({
        port: listenerPort,
        serverName: request.serverName ?? null,
        pins: request.pins,
        request: Buffer.from(request.request).toString("base64"),
      });
      const reads = readQueue();
      let opened = false;
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
          const line = JSON.parse(pending.slice(0, newline)) as Record<string, string | undefined>;
          pending = pending.slice(newline + 1);
          if (!opened) {
            opened = true;
            if (line.status === "opened" && line.servedPin !== undefined) {
              resolveOpening({
                status: "opened",
                servedPin: line.servedPin,
                read: reads.read,
                close: () => child.kill(),
              });
            } else if (line.status === "refused") {
              resolveOpening({ status: "refused", servedPin: line.servedPin });
            } else {
              resolveOpening({ status: "failed", reason: "connection-failed" });
            }
          } else if (line.status === "data") {
            reads.push({
              status: "data",
              chunk: new Uint8Array(Buffer.from(line.chunk ?? "", "base64")),
            });
          } else {
            reads.push(line.status === "end" ? { status: "end" } : { status: "failed" });
          }
        }
      });
      child.once("error", reject);
      child.once("close", () => reads.push({ status: "end" }));
    });
}

// Both commands dial the listener's Tailscale address on loopback, as above.

/** The phone's iOS exchange, which reads its request as JSON on stdin. */
function swiftExchange(binary: string, listenerPort: number): Exchange {
  return commandExchange((input) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "inherit"] });
    child.stdin.end(JSON.stringify({ address: "127.0.0.1", ...input }));
    return child;
  }, listenerPort);
}

/** The phone's Android exchange on a desktop JVM, which reads its request as arguments. */
function kotlinExchange(jar: string, listenerPort: number): Exchange {
  return commandExchange((input) => {
    const child = spawn(
      "java",
      [
        "-jar",
        jar,
        "127.0.0.1",
        String(input.port),
        input.serverName ?? "",
        input.pins.join(","),
        input.request,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    child.stdin.end();
    return child;
  }, listenerPort);
}

function phoneTransport(exchange: Exchange): PinnedListenerTransportPort {
  return ({ origin, trust }) => ({
    status: "available",
    fetch: createExchangeListenerFetch({
      origin,
      trust,
      port: { resolve: async () => [ADDRESS], open: exchange },
    }),
  });
}

/**
 * A listener serving the host-made certificate that streams an event reply:
 * one line, then a second only after the test says the first arrived.
 */
async function startStreamingListener() {
  const directory = mkdtempSync(join(tmpdir(), "octant-pinned-stream-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const certificate = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(
    ADDRESS,
  );
  if (certificate.status !== "ready") throw new Error(certificate.code);
  let sendSecond: () => void = () => undefined;
  const secondAllowed = new Promise<void>((resolveSecond) => (sendSecond = resolveSecond));
  const listener = createHttpsServer(certificate.tls, (_incoming, outgoing) => {
    outgoing.writeHead(200, { "content-type": "application/x-ndjson" });
    outgoing.write('{"sequence":1}\n');
    void secondAllowed.then(() => outgoing.end('{"sequence":2}\n'));
  });
  await new Promise<void>((resolveListen) => listener.listen(0, "127.0.0.1", resolveListen));
  const address = listener.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => {
        sendSecond();
        listener.closeAllConnections();
        listener.close(() => resolveClose());
      }),
  );
  return { port: address.port, pin: certificate.tlsPin, sendSecond };
}

function hasSwiftc(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** `kotlinc` and `java` on the path, as on a Linux CI runner or a Mac with both installed. */
function hasKotlinc(): boolean {
  try {
    execFileSync("kotlinc", ["-version"], { stdio: "ignore", timeout: 60_000 });
    execFileSync("java", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const swiftcFound = hasSwiftc();
const kotlincFound = hasKotlinc();
/**
 * Set where the Android exchange must run, as the CI server job sets it. The
 * Ubuntu runner image ships `kotlinc` and `java`, but nothing else would
 * notice an image without them: the Android exchange would skip and the run
 * would still pass, leaving the phone's Kotlin source untested.
 */
const kotlincRequired = process.env.OCTANT_REQUIRE_KOTLINC === "1";
let swiftBinary: string | undefined;
let kotlinJar: string | undefined;
const nativeBuild = mkdtempSync(join(tmpdir(), "octant-pinned-tls-"));

beforeAll(() => {
  if (swiftcFound) {
    const binary = join(nativeBuild, "pinned-tls-exchange");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-o",
        binary,
        join(PHONE_MODULE, "ios/PinnedTlsExchange.swift"),
        join(PHONE_MODULE, "test/main.swift"),
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(binary)) swiftBinary = binary;
  }
  if (kotlincFound) {
    const jar = join(nativeBuild, "pinned-tls-exchange.jar");
    execFileSync(
      "kotlinc",
      [
        join(PHONE_MODULE, "android/src/main/java/sh/octant/pinnedtls/PinnedTlsExchange.kt"),
        join(PHONE_MODULE, "test/android/Main.kt"),
        join(PHONE_MODULE, "test/android/Base64.kt"),
        "-include-runtime",
        "-d",
        jar,
      ],
      { stdio: "inherit", timeout: 240_000 },
    );
    if (existsSync(jar)) kotlinJar = jar;
  }
}, 480_000);

afterAll(() => {
  rmSync(nativeBuild, { recursive: true, force: true });
});

const phoneExchanges: ReadonlyArray<{
  readonly name: string;
  readonly exchange: (listenerPort: number) => Exchange;
  readonly runs: () => boolean;
}> = [
  { name: "the native contract in Node", exchange: nodeExchange, runs: () => true },
  {
    name: "the phone's iOS exchange",
    exchange: (listenerPort) => {
      if (swiftBinary === undefined) throw new Error("The iOS exchange was not built.");
      return swiftExchange(swiftBinary, listenerPort);
    },
    runs: () => swiftcFound,
  },
  {
    name: "the phone's Android exchange",
    exchange: (listenerPort) => {
      if (!kotlincFound) {
        throw new Error(
          "OCTANT_REQUIRE_KOTLINC is set, but kotlinc or java did not answer, so the Android exchange cannot run.",
        );
      }
      if (kotlinJar === undefined) throw new Error("The Android exchange was not built.");
      return kotlinExchange(kotlinJar, listenerPort);
    },
    runs: () => kotlincFound || kotlincRequired,
  },
];

describe.each(phoneExchanges)("pairing a phone from a code over $name", ({ exchange, runs }) => {
  it.runIf(runs())(
    "pairs from the code alone, pinned to the host-made certificate, and opens a session",
    async () => {
      const host = await startHost({ now: () => Date.now() });
      const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
      const deviceKeyStore = createInMemoryDeviceKeyStore();
      const transport = phoneTransport(exchange(host.port));

      const opened = await openAppPairingCode({
        code: pairingCode({ ...ticket, pin: host.pin }),
        transport,
        webBuildVersion: "0.1.0",
        deviceKeyStore,
      });
      if (opened.status !== "opened") throw new Error(opened.message);
      const claimed = await opened.claim("Ada's phone");
      if (claimed.status !== "claimed") throw new Error(claimed.message);
      host.administration.approvePairing({ ticketId: ticket.ticketId });
      const status = await opened.client.pollPairingStatus({
        ticket: opened.ticket,
        claim: claimed.claim,
      });
      if (status.kind !== "approved") throw new Error(`pairing ${status.kind}`);
      expect(status.approval.listenerTrust).toEqual({
        current: { kind: "pinned", pin: host.pin },
      });

      const sessionTransport = transport({ origin: ORIGIN, trust: status.approval.listenerTrust });
      if (sessionTransport.status !== "available") throw new Error("No pinned transport.");
      const bridge = createRemoteSessionBridge({ fetch: sessionTransport.fetch, deviceKeyStore });
      bridge.connect(status.approval);
      await vi.waitFor(() => expect(bridge.getState().kind).toBe("ready"), { timeout: 15_000 });
      bridge.disconnect();
    },
    30_000,
  );

  it.runIf(runs())(
    "streams an event reply's lines as the listener sends them, before it ends the reply",
    async () => {
      const listener = await startStreamingListener();
      const transport = phoneTransport(exchange(listener.port))({
        origin: ORIGIN,
        trust: { current: { kind: "pinned", pin: listener.pin } },
      });
      if (transport.status !== "available") throw new Error("No pinned transport.");

      const response = await transport.fetch(`${ORIGIN}/api/chat/threads/thread/events`);
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("No body.");
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error("The reply ended before its first line.");
        text += decoder.decode(next.value, { stream: true });
      }

      expect(text).toBe('{"sequence":1}\n');
      listener.sendSecond();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += decoder.decode(next.value, { stream: true });
      }
      expect(text).toBe('{"sequence":1}\n{"sequence":2}\n');
    },
    30_000,
  );

  it.runIf(runs())(
    "refuses a code whose pin is not the listener's key before any request reaches the host",
    async () => {
      const host = await startHost({ now: () => Date.now() });
      const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
      const wrongPin = `sha256-${Buffer.alloc(32, 9).toString("base64url")}`;

      const opened = await openAppPairingCode({
        code: pairingCode({ ...ticket, pin: wrongPin }),
        transport: phoneTransport(exchange(host.port)),
        webBuildVersion: "0.1.0",
      });

      expect(opened).toMatchObject({ status: "refused", reason: "pin-mismatch" });
      expect(host.requests).toEqual([]);
      expect(host.administration.listPendingPairings()).toEqual([]);
    },
    30_000,
  );

  it.runIf(runs())(
    "refuses an expired ticket at the host and leaves no claim to approve",
    async () => {
      let now = Date.now();
      const host = await startHost({ now: () => now });
      const ticket = host.administration.createPairingTicket({ sourceClass: "tailscale" });
      const transport = phoneTransport(exchange(host.port));
      const hello = transport({
        origin: ORIGIN,
        trust: { current: { kind: "pinned", pin: host.pin } },
      });
      if (hello.status !== "available") throw new Error("No pinned transport.");
      // The host's clock refuses a forward jump larger than two minutes.
      for (let step = 0; step < 4; step += 1) {
        now += 90_000;
        await hello.fetch(`${ORIGIN}/api/remote/hello`);
      }

      const opened = await openAppPairingCode({
        code: pairingCode({ ...ticket, pin: host.pin }),
        transport,
        webBuildVersion: "0.1.0",
        now: () => now,
      });
      if (opened.status !== "opened") throw new Error(opened.message);
      const claimed = await opened.claim("Ada's phone");

      expect(claimed.status).toBe("failed");
      expect(host.administration.listPendingPairings()).toEqual([]);
    },
    30_000,
  );
});
