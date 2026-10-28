// A whole Octant host for the hub tests: its journal, its real remote gateway
// behind a real TLS listener serving a certificate it made itself, and the hub
// role and spoke link wired as the server wires them. The network seams are
// the only difference from a real pair of hosts: each host's Tailscale address
// is dialled on loopback.

import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import type { HubMembershipChangedPayload } from "@octant/contracts";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite } from "../persistence/sqlitePort";
import type { RequestTransportFacts, Serve } from "../server";
import type { LocalDeviceAdministrationPort } from "../remote/localDeviceAdministrationRoutes";
import type { PrivateListenerHostStatus } from "../remote/privateListenerLifecycleController";
import { createRemoteGateway, type RemoteGateway } from "../remote/remoteGateway";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import { createHubLinkRouteHandler } from "./hubLinkRoutes";
import { createHubStateStore, type HubStatePort } from "./hubStateStore";
import { HubService, type HubHostIdentity } from "./hubService";
import { createPinnedHubTransport, type HubNetwork } from "./pinnedHubTransport";
import { createRosterSigningKeyStore } from "./rosterSigningKey";
import { SpokeLinkService } from "./spokeLinkService";

const tailscaleFacts: RequestTransportFacts = {
  listenerTrust: "remote",
  sourceClass: "tailscale",
  sourceKey: "opaque-tailscale-source-key",
};

/** Maps each host's private address to the loopback port its listener really serves on. */
export class HubTestNetwork {
  readonly #ports = new Map<string, number>();
  readonly dialled: string[] = [];

  register(address: string, port: number): void {
    this.#ports.set(address, port);
  }

  readonly network: HubNetwork = {
    resolve: async (hostname) => [hostname],
    dial: (address) =>
      new Promise<Socket>((resolve, reject) => {
        const port = this.#ports.get(address);
        if (port === undefined) {
          reject(new Error(`No test host at ${address}.`));
          return;
        }
        this.dialled.push(address);
        const socket = connectTcp({ host: "127.0.0.1", port });
        socket.once("error", reject);
        socket.once("connect", () => {
          Object.defineProperty(socket, "remoteAddress", { value: address });
          resolve(socket);
        });
      }),
  };
}

export interface HubTestHost {
  readonly hostId: string;
  readonly origin: string;
  readonly address: string;
  readonly name: string;
  readonly directory: string;
  readonly administration: LocalDeviceAdministrationPort;
  readonly gateway: RemoteGateway;
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly state: HubStatePort;
  readonly records: HubMembershipChangedPayload[];
  readonly listener: PrivateListenerHostStatus;
  /** Every request this host's listener answered, as `METHOD path`. */
  readonly requests: string[];
  /** The listener, called as a signed member would call it. */
  readonly hubLink: (request: Request) => Promise<Response | undefined>;
  readonly signHostPayload: (payload: string) => string;
  readonly hostPublicKey: string;
  readonly privateKey: KeyObject;
}

export async function startHubTestHost(input: {
  readonly name: string;
  readonly address: string;
  readonly network: HubTestNetwork;
  readonly cleanups: Array<() => Promise<void> | void>;
  readonly listenerStatus?: Partial<PrivateListenerHostStatus>;
}): Promise<HubTestHost> {
  const directory = mkdtempSync(join(tmpdir(), "octant-hub-"));
  input.cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const hostId = decodeStableHostId(randomUUID());
  const origin = `https://${input.address}:8443`;
  const connection = openSqlite(join(directory, "store.sqlite3"));
  const isoNow = () => new Date().toISOString();
  applyMigrations(connection, MIGRATIONS, isoNow);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: isoNow,
  });
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  const hostKeyFingerprint = createHash("sha256").update(publicDer).digest("hex");
  const signHostPayload = (payload: string) =>
    cryptoSign("sha256", Buffer.from(payload, "utf8"), {
      key: keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  journal.append({
    aggregate: { aggregateType: "remote-host", aggregateId: hostId },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: "remote.host-identity-initialized@1",
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "system", actorId: randomUUID() },
        occurredAt: isoNow(),
        payload: {
          hostId,
          displayName: input.name,
          hostKeyFingerprint,
          keyGeneration: 1,
          createdAt: isoNow(),
        },
      },
    ],
  });
  const certificate = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(
    input.address,
  );
  if (certificate.status !== "ready") throw new Error(certificate.code);
  const identity: HubHostIdentity = {
    hostId,
    displayName: input.name,
    signing: {
      hostKeyFingerprint,
      hostPublicKey: publicDer.toString("base64url"),
      signHostPayload,
    },
  };
  const listener: PrivateListenerHostStatus = {
    enabled: true,
    state: "ready",
    hostname: input.address,
    port: 8443,
    origin,
    exposureClass: "tailscale",
    certificateFingerprint: hostKeyFingerprint,
    certificateReady: true,
    certificateSource: "self-made",
    tlsPin: certificate.tlsPin,
    ...input.listenerStatus,
  };

  const state = createHubStateStore(directory);
  const records: HubMembershipChangedPayload[] = [];
  const transport = createPinnedHubTransport(input.network.network);
  let gateway: RemoteGateway | undefined;
  const hub = new HubService({
    state,
    rosterKey: createRosterSigningKeyStore(directory),
    identity: () => identity,
    listener: () => listener,
    pairing: () => {
      const administration = gateway?.localDeviceAdministration();
      if (gateway === undefined || administration === undefined) return undefined;
      const current = gateway;
      return {
        createTicket: (sourceClass) => {
          const ticket = administration.createPairingTicket({ sourceClass });
          return {
            ticketId: String(ticket.ticketId),
            ticketProof: ticket.ticketProof,
            expiresAt: ticket.expiresAt,
          };
        },
        approvedDeviceFor: (ticket) => current.approvedPairingDevice(ticket),
        revokeDevice: (deviceId) => {
          administration.revokeDevice({ deviceId });
        },
      };
    },
    transport,
    record: (change) => records.push(change),
    now: Date.now,
  });
  const spoke = new SpokeLinkService({
    state,
    identity: () => identity,
    listener: () => listener,
    transport,
    record: (change) => records.push(change),
    serverBuildVersion: "0.1.0",
    now: Date.now,
  });
  const hubLink = createHubLinkRouteHandler({ hub, spoke });

  let gatewayFetch:
    | ((request: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
  const serve: Serve = (serveOptions) => {
    gatewayFetch = serveOptions.fetch as typeof gatewayFetch;
    return { url: new URL(origin), stop: vi.fn(async () => {}) };
  };
  gateway = createRemoteGateway({
    connection,
    journal,
    hostId,
    displayName: input.name,
    serverBuildVersion: "0.1.0",
    signing: identity.signing,
    webAssets: () => Promise.resolve(new Response("web", { status: 200 })),
    hubLink,
    serve,
    clock: isoNow,
    config: { listener: { hostname: input.address, port: 8443, origin, tls: certificate.tls } },
  });
  await gateway.start();
  input.cleanups.push(() => gateway?.stop());
  const administration = gateway.localDeviceAdministration();
  if (administration === undefined) throw new Error("No local administration.");

  const requests: string[] = [];
  const server: Server = createHttpsServer(certificate.tls, (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      requests.push(`${incoming.method} ${incoming.url?.split("?")[0]}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const request = new Request(`${origin}${incoming.url}`, {
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
  server.on("tlsClientError", () => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No listener port.");
  input.network.register(input.address, address.port);
  input.cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  return {
    hostId: String(hostId),
    origin,
    address: input.address,
    name: input.name,
    directory,
    administration,
    gateway,
    hub,
    spoke,
    state,
    records,
    listener,
    requests,
    hubLink,
    signHostPayload,
    hostPublicKey: publicDer.toString("base64url"),
    privateKey: keys.privateKey,
  };
}
