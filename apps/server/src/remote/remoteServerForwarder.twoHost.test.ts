// Two computers in one process: the host is the real private-listener gateway
// with its grant service and relay, serving a real dev server on this
// machine's loopback; the client is a paired device's own pieces, the
// connection that mints its proxy session, the proxy client that holds its
// grants and signs, and the desktop's loopback forwarder that a page reaches.
// The host's listener is called in memory with synthetic transport facts, as
// the gateway's own suites do; the page and the dev server speak real HTTP. A
// WebSocket the host accepts is finished over a loopback socket pair the way
// the listener's transport finishes one, so the page's frames cross the
// forwarder, the host's relay, and the dev server as real bytes.

import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import {
  connect as connectTcp,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeEventActor,
  decodeWindowId,
  decodeCodeThreadId,
  decodeLocalServerPort,
  decodeRemoteServerGrantId,
  type CodeThread,
  type RemoteServerGrantSource,
} from "@octant/contracts";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { createRemoteConnection } from "@octant/client-runtime";
import { createRemoteServerProxyClient } from "@octant/client-runtime/remote-server-proxy-client";
import {
  createRemoteServerForwarder,
  type RemoteServerForwarder,
} from "@octant/client-runtime/remote-server-forwarder";
import type { LocalListenerHolding } from "../localServers/localListenerPort";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { readOpenRemoteServerGrants } from "../persistence/remoteServerGrantProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "../privateListener.test-certs";
import type { RequestTransportFacts, Serve } from "../server";
import {
  WEBSOCKET_RELAY_MAX_MESSAGE_BYTES,
  WebSocketEndpoint,
  newWebSocketKey,
  takeWebSocketUpgrade,
  webSocketAcceptFor,
  type WebSocketMessage,
} from "../webSocketRelay";
import { createRemoteGateway, type RemoteGateway } from "./remoteGateway";
import { RemoteServerGrantService } from "./remoteServerGrantService";

const capturedLifecycles: import("./pairingDeviceLifecycleService").PairingDeviceLifecycleService[] =
  [];
vi.mock("./pairingDeviceLifecycleService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pairingDeviceLifecycleService")>();
  const Real = actual.PairingDeviceLifecycleService;
  return {
    ...actual,
    PairingDeviceLifecycleService: class extends Real {
      constructor(options: ConstructorParameters<typeof Real>[0]) {
        super(options);
        capturedLifecycles.push(this);
      }
    },
  };
});

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const nowMs = Date.parse("2026-10-15T09:00:00.000Z");
const nowIso = new Date(nowMs).toISOString();
const HOSTNAME = "192.168.1.20";
const PORT = 9443;
const ORIGIN = `https://${HOSTNAME}:${PORT}`;
const threadId = decodeCodeThreadId("77777777-7777-4777-8777-777777777777");
const OWNED = `lsn_${"0".repeat(31)}1`;
const NOT_OWNED = `lsn_${"0".repeat(31)}2`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  capturedLifecycles.length = 0;
});

interface DevRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

/** Connections that switched to WebSocket, which closing a server does not reach. */
const switchedSockets: Socket[] = [];
afterEach(() => {
  for (const socket of switchedSockets.splice(0)) socket.destroy();
});

async function startDevServer(): Promise<{
  readonly port: number;
  readonly seen: DevRequest[];
  readonly upgrades: DevRequest[];
}> {
  const seen: DevRequest[] = [];
  const upgrades: DevRequest[] = [];
  const server: Server = createHttpServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "sid=1; Domain=localhost; Path=/",
    });
    response.end("<h1>the dev server's page</h1>");
  });
  // A hot-reload endpoint that echoes every message back.
  server.on("upgrade", (request, socket: Socket, head: Buffer) => {
    upgrades.push({ url: request.url ?? "", headers: request.headers });
    switchedSockets.push(socket);
    const key = request.headers["sec-websocket-key"];
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${webSocketAcceptFor(typeof key === "string" ? key : "")}`,
      ].join("\r\n") + "\r\n\r\n",
    );
    const endpoint = new WebSocketEndpoint(socket, "server", WEBSOCKET_RELAY_MAX_MESSAGE_BYTES);
    endpoint.start({ message: (message) => endpoint.send(message), closed: () => undefined }, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen, upgrades };
}

/** Two ends of one loopback TCP connection. */
async function socketPair(): Promise<readonly [Socket, Socket]> {
  const server = createTcpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const accepted = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const near = connectTcp((server.address() as AddressInfo).port, "127.0.0.1");
  await new Promise<void>((resolve) => near.once("connect", () => resolve()));
  const far = await accepted;
  server.close();
  switchedSockets.push(near, far);
  return [near, far];
}

function makeSigning() {
  const hostKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const hostPublicDer = hostKeys.publicKey.export({ format: "der", type: "spki" });
  return {
    hostKeyFingerprint: createHash("sha256").update(hostPublicDer).digest("hex"),
    hostPublicKey: hostPublicDer.toString("base64url"),
    signHostPayload: (payload: string) =>
      cryptoSign("sha256", Buffer.from(payload, "utf8"), {
        key: hostKeys.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
  };
}

/** The host computer: its gateway, the listing it re-observes, and whether the port is still held. */
async function startHost(devPort: number) {
  const directory = mkdtempSync(join(tmpdir(), "octant-two-host-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => nowIso);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => nowIso,
  });
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
        occurredAt: nowIso,
        payload: {
          hostId,
          displayName: "Studio Mac",
          hostKeyFingerprint: "a".repeat(64),
          keyGeneration: 1,
          createdAt: nowIso,
        },
      },
    ],
  });
  const endpoint = {
    url: `http://127.0.0.1:${String(devPort)}/`,
    port: devPort,
    pid: 4001,
    processName: "node",
  };
  const targets = new Map<string, RemoteServerGrantTarget>([
    [
      OWNED,
      { status: "listed", ownership: "octant-owned", health: "listening", threadId, endpoint },
    ],
    [
      NOT_OWNED,
      { status: "listed", ownership: "leftover", health: "listening", threadId, endpoint },
    ],
  ]);
  const holding: { value: LocalListenerHolding } = { value: "held" };
  const threads = new Map<string, Pick<CodeThread, "lifecycle" | "executionPolicy">>([
    [String(threadId), { lifecycle: "active", executionPolicy: "approval-gated" }],
  ]);
  const grants = new RemoteServerGrantService({
    observeTarget: async (_scope, source) =>
      targets.get(String(source.listenerId)) ?? { status: "not-listed" },
    canOpenThread: async () => true,
    readThread: (id) => threads.get(String(id)),
    readOpenGrants: () => readOpenRemoteServerGrants(connection),
    confirmEndpoint: async () => holding.value,
    isCodeEnabled: () => true,
    journal,
    hostActor: decodeEventActor({
      kind: "system",
      actorId: "33333333-3333-4333-8333-333333333333",
    }),
    uuid: randomUUID,
    clock: () => nowIso,
  });
  let captured:
    | ((request: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
  const serve: Serve = (options) => {
    captured = options.fetch as typeof captured;
    return { url: new URL(`https://${options.hostname}:${options.port}`), stop: async () => {} };
  };
  const signing = makeSigning();
  let counter = 0;
  const before = capturedLifecycles.length;
  const gateway: RemoteGateway = createRemoteGateway({
    connection,
    journal,
    hostId,
    displayName: "Studio Mac",
    serverBuildVersion: "0.1.0",
    signing,
    webAssets: () => Promise.resolve(new Response("<title>Octant</title>")),
    productDispatch: async () => Response.json({ ok: true }),
    remoteServerGrants: {
      open: (input) =>
        grants.open({
          principal: {
            kind: "remote-device",
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
          },
          scopeId: decodeWindowId(String(input.principal.deviceId)),
          request: input.grantRequest,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      relay: (input) =>
        grants.relay({
          principal: {
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
            origin: input.principal.origin,
          },
          scopeId: decodeWindowId(String(input.principal.deviceId)),
          grantId: input.grantId,
          method: input.method,
          pathQuery: input.pathQuery,
          headers: input.headers,
          body: input.body,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      relayUpgrade: (input) =>
        grants.relayUpgrade({
          principal: {
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
            origin: input.principal.origin,
          },
          scopeId: decodeWindowId(String(input.principal.deviceId)),
          grantId: input.grantId,
          pathQuery: input.pathQuery,
          headers: input.headers,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      holdsOpenSockets: (digest) => grants.holdsOpenSockets(digest),
      closeSession: (digest, reason) => grants.closeSession(digest, reason),
    },
    serve,
    now: () => nowMs,
    uuid: () => `22222222-2222-4222-8222-${String(++counter).padStart(12, "0")}`,
    clock: () => nowIso,
    config: {
      listener: {
        hostname: HOSTNAME,
        port: PORT,
        origin: ORIGIN,
        tls: { cert: PRIVATE_LISTENER_TEST_CERT, key: PRIVATE_LISTENER_TEST_KEY },
      },
    },
  });
  const lifecycle = capturedLifecycles[capturedLifecycles.length - 1];
  if (lifecycle === undefined || capturedLifecycles.length === before) {
    throw new Error("Gateway did not construct a pairing lifecycle.");
  }
  await gateway.start();
  const listener = captured;
  if (listener === undefined) throw new Error("Gateway did not capture its listener.");
  const facts: RequestTransportFacts = {
    listenerTrust: "remote",
    sourceClass: "lan-private",
    sourceKey: "client-computer",
  };
  /** The host's private listener as the client's network reaches it. */
  const fetch: typeof globalThis.fetch = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("host", `${HOSTNAME}:${PORT}`);
      return listener(new Request(request, { headers }), facts);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return { gateway, lifecycle, signing, fetch, holding };
}

/** The client computer: a paired device key, its connection and proxy client, and the forwarder. */
async function startClient(host: Awaited<ReturnType<typeof startHost>>) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const publicPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  const fingerprint = createHash("sha256").update(publicDer).digest("hex");
  const sign = async (payload: string) =>
    cryptoSign("sha256", Buffer.from(payload), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");

  const hello = (await (await host.fetch(`${ORIGIN}/api/remote/hello`)).json()) as {
    readonly nonce: string;
  };
  const ticket = host.lifecycle.createTicket({ sourceClass: "lan-private" });
  const claim = await host.fetch(`${ORIGIN}/api/remote/pairing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
      hostHelloNonce: hello.nonce,
      devicePublicKey: publicPem,
      deviceKeyFingerprint: fingerprint,
      deviceLabel: "Laptop",
      origin: ORIGIN,
      clientHello: {
        webBuildVersion: "0.1.0",
        supportedProtocolRange: { min: 1, max: 1 },
        browserCapabilities: ["webcrypto"],
      },
    }),
  });
  expect(claim.status).toBe(200);
  const approved = host.lifecycle.approveTicket({ ticketId: ticket.ticketId });
  const deviceId = approved.device.deviceId;

  const connection = createRemoteConnection({
    origin: ORIGIN,
    webBuildVersion: "0.1.0",
    fetch: host.fetch,
    deviceKey: {
      loadOrCreate: async () => ({ publicKeyPem: publicPem, fingerprint }),
      current: async () => ({ publicKeyPem: publicPem, fingerprint }),
      sign,
      clear: async () => undefined,
    },
    knownDevice: {
      hostId,
      deviceId,
      credentialGeneration: 1,
      hostKeyFingerprint: host.signing.hostKeyFingerprint,
    },
    now: () => nowMs,
  });
  const proxy = createRemoteServerProxyClient({
    origin: ORIGIN,
    hostName: "Studio Mac",
    fetch: host.fetch,
    issueSession: () => connection.issueServerProxySession(),
    sign,
    now: () => nowMs,
  });
  const forwarder: RemoteServerForwarder = createRemoteServerForwarder({
    ports: { first: 40_000 + Math.floor(Math.random() * 20_000), count: 10 },
    addresses: ["127.0.0.1"],
    sign: async (request) => {
      const signing = await proxy.signRelayRequest(request);
      return signing.status === "signed" ? signing : { status: "refused", reason: "refused" };
    },
    sendToHost: (_target, request) =>
      host.fetch(`${ORIGIN}${request.pathQuery}`, {
        method: request.method,
        headers: request.headers.map(([name, value]): [string, string] => [name, value]),
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: request.signal,
      }),
    // What the listener's transport does with an accepted upgrade: answer 101
    // for the request's key and frame the connection as the server end.
    upgradeToHost: async (_target, request) => {
      const response = await host.fetch(`${ORIGIN}${request.pathQuery}`, {
        method: "GET",
        headers: request.headers.map(([name, value]): [string, string] => [name, value]),
      });
      const acceptance = takeWebSocketUpgrade(response);
      if (acceptance === undefined) return { status: "answered", response };
      const key = new Map(request.headers).get("sec-websocket-key") ?? "";
      const [near, far] = await socketPair();
      const endpoint = new WebSocketEndpoint(far, "server", WEBSOCKET_RELAY_MAX_MESSAGE_BYTES);
      endpoint.start(acceptance.open(endpoint), new Uint8Array());
      return {
        status: "switched",
        headers: [
          ["upgrade", "websocket"],
          ["connection", "Upgrade"],
          ["sec-websocket-accept", webSocketAcceptFor(key)],
          ...(acceptance.protocol === undefined
            ? []
            : [["sec-websocket-protocol", acceptance.protocol] as const]),
        ],
        socket: near,
        head: new Uint8Array(),
      };
    },
  });
  const started = await forwarder.start();
  if (started.status !== "listening") throw new Error("Forwarder did not start.");
  cleanups.push(() => forwarder.stop());
  return { deviceId, proxy, forwarder, port: started.port };
}

function pageGet(
  port: number,
  host: string,
  access: string,
  path = "/",
): Promise<{
  readonly status: number;
  readonly body: string;
  readonly headers: IncomingHttpHeaders;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host, "x-octant-page-access": access, "sec-fetch-site": "none" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

type PageSocket =
  | {
      readonly status: 101;
      readonly send: (text: string) => void;
      readonly next: () => Promise<string>;
      /** Resolves with the close code once the connection ends. */
      readonly closed: Promise<number>;
    }
  | { readonly status: number };

/** A page's WebSocket to the forwarder, as a browser opens one on the page's own name. */
function pageSocket(
  port: number,
  host: string,
  access: string | undefined,
  path = "/hmr",
): Promise<PageSocket> {
  const key = newWebSocketKey();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        host,
        origin: `http://${host}`,
        "sec-fetch-site": "same-origin",
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": key,
        "sec-websocket-version": "13",
        ...(access === undefined ? {} : { "x-octant-page-access": access }),
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    request.on("upgrade", (response, socket: Socket, head: Buffer) => {
      switchedSockets.push(socket);
      expect(response.headers["sec-websocket-accept"]).toBe(webSocketAcceptFor(key));
      const received: string[] = [];
      const waiting: Array<(text: string) => void> = [];
      let close: (code: number) => void = () => undefined;
      const closed = new Promise<number>((done) => {
        close = done;
      });
      const endpoint = new WebSocketEndpoint(socket, "client", WEBSOCKET_RELAY_MAX_MESSAGE_BYTES);
      endpoint.start(
        {
          message: (message: WebSocketMessage) => {
            const text = new TextDecoder().decode(message.data);
            const reader = waiting.shift();
            if (reader === undefined) received.push(text);
            else reader(text);
          },
          closed: (code) => close(code),
        },
        head,
      );
      resolve({
        status: 101,
        send: (text) => endpoint.send({ text: true, data: new TextEncoder().encode(text) }),
        next: () => {
          const ready = received.shift();
          return ready === undefined
            ? new Promise<string>((done) => waiting.push(done))
            : Promise.resolve(ready);
        },
        closed,
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function opened(socket: PageSocket): Extract<PageSocket, { readonly status: 101 }> {
  if (!("send" in socket)) throw new Error(`upgrade answered ${String(socket.status)}`);
  return socket;
}

const runningService = (listenerId: string) =>
  ({ surface: "running-services", listenerId }) as RemoteServerGrantSource;

async function openPage(client: Awaited<ReturnType<typeof startClient>>, listenerId = OWNED) {
  const opening = await client.proxy.openGrant(runningService(listenerId));
  if (opening.status !== "opened") throw new Error(`refused: ${opening.reason}`);
  const page = client.forwarder.open({
    hostId: String(hostId),
    hostName: "Studio Mac",
    listenerOrigin: ORIGIN,
    grant: opening.grant,
  });
  return {
    host: new URL(page.pageOrigin).host,
    access: client.forwarder.accessFor(page.pageOrigin) ?? "",
  };
}

describe("opening a dev server on another paired computer", () => {
  it("shows the host's Octant-owned dev server on this computer through its grant", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);

    const page = await pageGet(client.port, pageHost, access, "/about?tab=1");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<h1>the dev server's page</h1>");
    expect(page.headers["set-cookie"]).toEqual(["sid=1; Path=/"]);
    expect(dev.seen).toHaveLength(1);
    expect(dev.seen[0]?.url).toBe("/about?tab=1");
    expect(dev.seen[0]?.headers.host).toBe(`localhost:${String(dev.port)}`);
    expect(dev.seen[0]?.headers.cookie).toBeUndefined();
    expect(
      Object.keys(dev.seen[0]?.headers ?? {}).some((name) => name.startsWith("x-octant-")),
    ).toBe(false);
  });

  it("refuses a server Octant does not own with the host's reason", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    expect(await client.proxy.openGrant(runningService(NOT_OWNED))).toMatchObject({
      status: "refused",
      reason: "not-octant-owned",
    });
    expect(dev.seen).toEqual([]);
  });

  it("carries no authority without a grant: a page for a grant it never got is refused before the host", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const page = client.forwarder.open({
      hostId: String(hostId),
      hostName: "Studio Mac",
      listenerOrigin: ORIGIN,
      grant: {
        grantId: decodeRemoteServerGrantId(`rsg_${"ef".repeat(32)}`),
        threadId,
        port: decodeLocalServerPort(dev.port),
      },
    });
    const answer = await pageGet(
      client.port,
      new URL(page.pageOrigin).host,
      client.forwarder.accessFor(page.pageOrigin) ?? "",
    );
    expect(answer.status).toBe(503);
    expect(dev.seen).toEqual([]);
  });

  it("says the server stopped once the host closes the grant", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);
    host.holding.value = "stopped";
    const answer = await pageGet(client.port, pageHost, access);
    expect(answer.status).toBe(410);
    expect(answer.body).toContain(`The server on port ${String(dev.port)} stopped or changed.`);
    expect(dev.seen).toEqual([]);
  });

  it("refuses with a reason after the host revokes this computer", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);
    host.gateway.localDeviceAdministration()?.revokeDevice({ deviceId: client.deviceId });
    const answer = await pageGet(client.port, pageHost, access);
    expect(answer.status).toBe(403);
    expect(dev.seen).toEqual([]);
    expect(await client.proxy.openGrant(runningService(OWNED))).toMatchObject({
      status: "refused",
      reason: "device-revoked",
    });
  });
});

describe("live reload from a dev server on another paired computer", () => {
  it("echoes a page's WebSocket through the forwarder, the host's relay, and the dev server", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);

    const socket = opened(await pageSocket(client.port, pageHost, access, "/hmr?token=1"));
    socket.send("reload?");
    expect(await socket.next()).toBe("reload?");
    socket.send("again");
    expect(await socket.next()).toBe("again");
    expect(dev.upgrades).toHaveLength(1);
    expect(dev.upgrades[0]?.url).toBe("/hmr?token=1");
    expect(dev.upgrades[0]?.headers.host).toBe(`localhost:${String(dev.port)}`);
    expect(
      Object.keys(dev.upgrades[0]?.headers ?? {}).some((name) => name.startsWith("x-octant-")),
    ).toBe(false);
  });

  it("refuses an upgrade without the page's secret before it reaches the host", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost } = await openPage(client);
    expect((await pageSocket(client.port, pageHost, undefined)).status).toBe(403);
    expect((await pageSocket(client.port, pageHost, "not-the-secret")).status).toBe(403);
    expect(dev.upgrades).toEqual([]);
  });

  it("refuses an upgrade for a grant this computer never got", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const page = client.forwarder.open({
      hostId: String(hostId),
      hostName: "Studio Mac",
      listenerOrigin: ORIGIN,
      grant: {
        grantId: decodeRemoteServerGrantId(`rsg_${"ef".repeat(32)}`),
        threadId,
        port: decodeLocalServerPort(dev.port),
      },
    });
    const answer = await pageSocket(
      client.port,
      new URL(page.pageOrigin).host,
      client.forwarder.accessFor(page.pageOrigin),
    );
    expect(answer.status).toBe(503);
    expect(dev.upgrades).toEqual([]);
  });

  it("refuses an upgrade once the host closes the grant", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);
    host.holding.value = "stopped";
    expect((await pageSocket(client.port, pageHost, access)).status).toBe(410);
    expect(dev.upgrades).toEqual([]);
  });

  it("refuses an upgrade after the host revokes this computer, and closes the one already open", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);
    const socket = opened(await pageSocket(client.port, pageHost, access));
    socket.send("before");
    expect(await socket.next()).toBe("before");

    host.gateway.localDeviceAdministration()?.revokeDevice({ deviceId: client.deviceId });
    expect(await socket.closed).toBe(1008);
    expect((await pageSocket(client.port, pageHost, access)).status).toBe(403);
    expect(dev.upgrades).toHaveLength(1);
  });

  it("closes a page's open WebSocket when Octant stops serving the page", async () => {
    const dev = await startDevServer();
    const host = await startHost(dev.port);
    const client = await startClient(host);
    const { host: pageHost, access } = await openPage(client);
    const socket = opened(await pageSocket(client.port, pageHost, access));
    socket.send("before");
    expect(await socket.next()).toBe("before");

    client.forwarder.closeHost(String(hostId));
    expect(await socket.closed).toBe(1006);
  });
});
