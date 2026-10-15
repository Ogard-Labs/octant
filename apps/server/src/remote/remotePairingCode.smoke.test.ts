// Pairing from an app pairing code against an in-process host: the real
// remote gateway, its pairing service, and a certificate the host made
// itself, served over real TLS. The client side is the shared client-runtime
// code reader and the Node transport held to the code's pin, as the desktop
// app's main process uses them. Only the network seams differ from a real
// pairing: the listener's Tailscale address is dialled on loopback.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryDeviceKeyStore,
  createRemoteSessionBridge,
  openAppPairingCode,
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

/** The Node transport held to the code's pin, dialling the listener's address on loopback. */
function pinnedTransport(port: number): PinnedListenerTransportPort {
  return ({ origin, trust }) => ({
    status: "available",
    fetch: testOnlyListenerTls.createListenerFetchOver(
      { origin, trust },
      {
        resolve: async () => [ADDRESS],
        dial: (address) =>
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
      },
    ),
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
