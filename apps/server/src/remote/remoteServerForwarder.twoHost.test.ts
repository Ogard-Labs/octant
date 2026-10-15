// Two computers in one process: the host is the real private-listener gateway
// with its grant service and relay, serving a real dev server on this
// machine's loopback; the client is a paired device's own pieces, the
// connection that mints its proxy session, the proxy client that holds its
// grants and signs, and the desktop's loopback forwarder that a page reaches.
// The host's listener is called in memory with synthetic transport facts, as
// the gateway's own suites do; the page and the dev server speak real HTTP.

import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
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

async function startDevServer(): Promise<{ readonly port: number; readonly seen: DevRequest[] }> {
  const seen: DevRequest[] = [];
  const server: Server = createHttpServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "sid=1; Domain=localhost; Path=/",
    });
    response.end("<h1>the dev server's page</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { port: (server.address() as AddressInfo).port, seen };
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
