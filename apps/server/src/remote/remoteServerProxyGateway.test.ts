// The proxy session, the grant route, and the relay to a dev server, driven
// through the real gateway composition in memory: a capturing `serve` records
// the production boundary fetch (admission, route policy, authentication) and
// each case calls it with synthetic transport facts, as the hostile security
// matrix does. Dev servers are real HTTP and HTTPS servers on this machine's
// loopback.

import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_SERVER_GRANT_CLOSED,
  decodeCodeThreadId,
  decodeEventActor,
  decodeRemoteServerGrantResult,
  decodeWindowId,
  type CodeThread,
  type RemoteServerGrantResult,
} from "@octant/contracts";
import {
  REMOTE_SERVER_PROXY_RELAYED,
  REMOTE_SERVER_PROXY_RELAYED_HEADER,
  decodeRemoteServerProxyRefusal,
} from "@octant/contracts";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { decodeRemoteSessionResponseV1 } from "@octant/contracts/remote-request-proof";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  buildRemoteServerProxySessionProofPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
import type { LocalListenerHolding } from "../localServers/localListenerPort";
import type { RemoteServerGrantTarget } from "../localServers/localServerService";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { readOpenRemoteServerGrants } from "../persistence/remoteServerGrantProjection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  PRIVATE_LISTENER_TEST_CERT,
  PRIVATE_LISTENER_TEST_KEY,
} from "../privateListener.test-certs";
import type { RequestTransportFacts, Serve } from "../server";
import { createRemoteGateway, type RemoteGateway } from "./remoteGateway";
import { RemoteServerGrantService } from "./remoteServerGrantService";
import { createSelfMadeListenerCertificateStore } from "./selfMadeListenerCertificate";

// The pairing lifecycle the gateway builds, captured so the harness can create
// and approve tickets the way the host's local device panel does.
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
import type { PairingDeviceLifecycleService } from "./pairingDeviceLifecycleService";

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const nowMs = Date.parse("2026-10-15T09:00:00.000Z");
const nowIso = new Date(nowMs).toISOString();
const HOSTNAME = "192.168.1.20";
const PORT = 9443;
const ORIGIN = `https://${HOSTNAME}:${PORT}`;
const HOST_HEADER = `${HOSTNAME}:${PORT}`;
const threadId = decodeCodeThreadId("77777777-7777-4777-8777-777777777777");
const projectId = "88888888-8888-4888-8888-888888888888";
const PROXY_COOKIE = "__Secure-octant-server-proxy-session";
const PRODUCT_COOKIE = "__Secure-octant-remote-session";
const directories: string[] = [];
const devServers: Server[] = [];

afterEach(async () => {
  for (const server of devServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  capturedLifecycles.length = 0;
});

function facts(sourceKey = "opaque-lan-source-key"): RequestTransportFacts {
  return { listenerTrust: "remote", sourceClass: "lan-private", sourceKey };
}

interface Harness {
  readonly gateway: RemoteGateway;
  readonly connection: SqliteConnection;
  readonly lifecycle: PairingDeviceLifecycleService;
  readonly fetch: (req: Request, facts?: RequestTransportFacts) => Promise<Response>;
  readonly grants: RemoteServerGrantService;
  readonly targets: Map<string, RemoteServerGrantTarget | (() => Promise<RemoteServerGrantTarget>)>;
  readonly readable: Set<string>;
  readonly dispatched: string[];
  /** What re-observing a grant's port answers, and how often the host asked. */
  readonly holding: {
    value: LocalListenerHolding | (() => Promise<LocalListenerHolding>);
    asked: number;
  };
  readonly code: { enabled: boolean };
  /** Holds product requests open while set, to fill the product budget. */
  hold: Promise<void> | undefined;
}

async function setup(options: { readonly idleTimeoutMs?: number } = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), "octant-server-proxy-"));
  directories.push(directory);
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
          displayName: "This Mac",
          hostKeyFingerprint: "a".repeat(64),
          keyGeneration: 1,
          createdAt: nowIso,
        },
      },
    ],
  });

  const targets: Harness["targets"] = new Map();
  const readable = new Set<string>([String(threadId)]);
  const holding: Harness["holding"] = { value: "held", asked: 0 };
  const code = { enabled: true };
  const threads = new Map<string, Pick<CodeThread, "lifecycle" | "executionPolicy">>([
    [String(threadId), { lifecycle: "active", executionPolicy: "approval-gated" }],
  ]);
  const grants = new RemoteServerGrantService({
    observeTarget: async (_scope, source) => {
      const target = targets.get(String(source.listenerId));
      if (target === undefined) return { status: "not-listed" };
      return typeof target === "function" ? await target() : target;
    },
    canOpenThread: async (_scope, id) => readable.has(String(id)),
    readThread: (id) => threads.get(String(id)),
    readOpenGrants: () => readOpenRemoteServerGrants(connection),
    confirmEndpoint: async () => {
      holding.asked += 1;
      return typeof holding.value === "function" ? await holding.value() : holding.value;
    },
    isCodeEnabled: () => code.enabled,
    journal,
    hostActor: decodeEventActor({
      kind: "system",
      actorId: "33333333-3333-4333-8333-333333333333",
    }),
    uuid: randomUUID,
    clock: () => nowIso,
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { relayLimits: { idleTimeoutMs: options.idleTimeoutMs } }),
  });

  const { serve, getFetch } = createCapturingServe();
  let uuidCounter = 0;
  const before = capturedLifecycles.length;
  const dispatched: string[] = [];
  const harness = {} as { hold: Promise<void> | undefined };
  harness.hold = undefined;
  const gateway = createRemoteGateway({
    connection,
    journal,
    hostId,
    displayName: "This Mac",
    serverBuildVersion: "0.1.0",
    signing: makeSigning(),
    webAssets: () => Promise.resolve(new Response("<title>Octant</title>", { status: 200 })),
    productDispatch: async (handoff) => {
      dispatched.push(new URL(handoff.request.url).pathname);
      if (harness.hold !== undefined) await harness.hold;
      return Response.json({ ok: true });
    },
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
    uuid: () => `22222222-2222-4222-8222-${String(++uuidCounter).padStart(12, "0")}`,
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
    throw new Error("Gateway did not construct a PairingDeviceLifecycleService.");
  }
  await gateway.start();
  const fetch = getFetch();
  if (fetch === undefined) throw new Error("Gateway did not capture a boundary fetch.");
  return Object.assign(harness, {
    gateway,
    connection,
    lifecycle,
    fetch,
    grants,
    targets,
    readable,
    dispatched,
    holding,
    code,
  });
}

function createCapturingServe(): {
  readonly serve: Serve;
  readonly getFetch: () =>
    | ((req: Request, facts?: RequestTransportFacts) => Promise<Response>)
    | undefined;
} {
  let captured: ((req: Request, facts?: RequestTransportFacts) => Promise<Response>) | undefined;
  const serve: Serve = (opts) => {
    captured = opts.fetch as (req: Request, facts?: RequestTransportFacts) => Promise<Response>;
    return { url: new URL(`https://${opts.hostname}:${opts.port}`), stop: async () => {} };
  };
  return { serve, getFetch: () => captured };
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

function deviceKeypair(label: string) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicDer = keys.publicKey.export({ format: "der", type: "spki" });
  return {
    label,
    publicPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString().trim(),
    fingerprint: createHash("sha256").update(publicDer).digest("hex"),
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function clientSign(privateKeyPem: string, payload: string): string {
  return cryptoSign("sha256", Buffer.from(payload), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  json(): unknown;
}

async function call(
  harness: Harness,
  init: {
    readonly method: string;
    readonly path: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
    readonly sourceKey?: string;
  },
): Promise<Answer> {
  const request = new Request(`${ORIGIN}${init.path}`, {
    method: init.method,
    headers: new Headers({ host: HOST_HEADER, ...init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  const response = await harness.fetch(request, facts(init.sourceKey));
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: () => (text === "" ? undefined : JSON.parse(text)),
  };
}

const CLIENT_HELLO = {
  webBuildVersion: "0.1.0",
  supportedProtocolRange: { min: 1, max: 1 },
  browserCapabilities: ["webcrypto"],
} as const;

interface Paired {
  readonly deviceId: string;
  readonly device: ReturnType<typeof deviceKeypair>;
  readonly sourceKey: string;
}

interface Session {
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly cookie: string;
  readonly paired: Paired;
}

async function pair(harness: Harness, sourceKey = "opaque-lan-source-key"): Promise<Paired> {
  const device = deviceKeypair("Laptop");
  const hello = (
    await call(harness, { method: "GET", path: "/api/remote/hello", sourceKey })
  ).json() as {
    readonly nonce: string;
  };
  const ticket = harness.lifecycle.createTicket({ sourceClass: "lan-private" });
  const claim = await call(harness, {
    method: "POST",
    path: "/api/remote/pairing",
    sourceKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ticketId: ticket.ticketId,
      ticketProof: ticket.ticketProof,
      hostHelloNonce: hello.nonce,
      devicePublicKey: device.publicPem,
      deviceKeyFingerprint: device.fingerprint,
      deviceLabel: device.label,
      origin: ORIGIN,
      clientHello: CLIENT_HELLO,
    }),
  });
  expect(claim.status).toBe(200);
  const approved = harness.lifecycle.approveTicket({ ticketId: ticket.ticketId });
  return { deviceId: approved.device.deviceId, device, sourceKey };
}

/** Challenge, negotiate, and sign; `kind` picks which session the signature asks for. */
async function signIn(
  harness: Harness,
  paired: Paired,
  kind: "product" | "server-proxy",
  options: {
    readonly signAs?: "product" | "server-proxy";
    readonly path?: string;
    readonly replay?: boolean;
  } = {},
): Promise<{ readonly answer: Answer; readonly session?: Session }> {
  const { sourceKey } = paired;
  const challengeAnswer = await call(harness, {
    method: "POST",
    path: "/api/remote/auth/challenge",
    sourceKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hostId, deviceId: paired.deviceId, credentialGeneration: 1 }),
  });
  expect(challengeAnswer.status).toBe(200);
  const challenge = challengeAnswer.json() as Parameters<
    typeof buildRemoteChallengeProofPayload
  >[0]["challenge"];
  const hello = (
    await call(harness, { method: "GET", path: "/api/remote/hello", sourceKey })
  ).json() as {
    readonly nonce: string;
  };
  const negotiated = await call(harness, {
    method: "POST",
    path: "/api/remote/negotiate",
    sourceKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      hostHelloNonce: hello.nonce,
      challengeId: challenge.challengeId,
      deviceId: paired.deviceId,
      origin: ORIGIN,
      clientHello: CLIENT_HELLO,
    }),
  });
  expect(negotiated.status).toBe(200);
  const negotiation = negotiated.json() as {
    readonly protocolVersion: number;
    readonly authenticationVersion: number;
    readonly capabilityDigest: string;
  };
  const transcriptInput = {
    challenge,
    sessionFacts: {
      origin: ORIGIN,
      protocolVersion: negotiation.protocolVersion,
      authenticationVersion: negotiation.authenticationVersion,
      capabilityDigest: negotiation.capabilityDigest,
      ...sessionExpiry(Date.parse(challenge.issuedAt)),
    },
  };
  const signAs = options.signAs ?? kind;
  const signature = clientSign(
    paired.device.privateKeyPem,
    signAs === "product"
      ? buildRemoteChallengeProofPayload(transcriptInput)
      : buildRemoteServerProxySessionProofPayload(transcriptInput),
  );
  const send = () =>
    call(harness, {
      method: "POST",
      path:
        options.path ??
        (kind === "product" ? "/api/remote/auth/session" : "/api/remote/auth/server-proxy-session"),
      sourceKey,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...challenge, signature }),
    });
  const first = await send();
  const answer = options.replay === true ? await send() : first;
  if (answer.status !== 200) return { answer };
  const cookieName = kind === "product" ? PRODUCT_COOKIE : PROXY_COOKIE;
  const setCookie = answer.headers.get("set-cookie") ?? "";
  const sessionId = new RegExp(`${cookieName}=([0-9a-f-]{36})`).exec(setCookie)?.[1] ?? "";
  expect(sessionId).not.toBe("");
  const body = decodeRemoteSessionResponseV1(answer.json());
  return {
    answer,
    session: { sessionId, csrfToken: body.csrfToken, cookie: `${cookieName}=${sessionId}`, paired },
  };
}

async function session(harness: Harness, paired: Paired, kind: "product" | "server-proxy") {
  const { session: established } = await signIn(harness, paired, kind);
  if (established === undefined) throw new Error(`no ${kind} session`);
  return established;
}

let nonceCounter = 0;

function signed(
  session: Session,
  init: {
    readonly path: string;
    readonly body?: string;
    readonly method?: string;
    readonly signedPath?: string;
    readonly cookie?: string;
    readonly signWith?: string;
  },
) {
  const method = init.method ?? "POST";
  const unsafe = method !== "GET" && method !== "HEAD";
  const body = init.body ?? (unsafe ? "{}" : undefined);
  const signedPath = init.signedPath ?? init.path;
  const proof = {
    method,
    canonicalPathQuery: canonicalizeRemotePathQuery(signedPath) ?? signedPath,
    bodyDigest: createHash("sha256")
      .update(body ?? "", "utf8")
      .digest("hex"),
    ...(unsafe
      ? { csrfDigest: createHash("sha256").update(session.csrfToken, "utf8").digest("hex") }
      : {}),
    timestamp: nowIso,
    nonce: `nonce_${String(++nonceCounter).padStart(20, "0")}`,
  };
  const signature = clientSign(
    init.signWith ?? session.paired.device.privateKeyPem,
    buildRemoteRequestProofPayload({ sessionId: session.sessionId, proof }),
  );
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    cookie: init.cookie ?? session.cookie,
    "x-octant-device-proof": Buffer.from(JSON.stringify({ ...proof, signature })).toString(
      "base64url",
    ),
  };
  if (unsafe) {
    headers["x-octant-csrf"] = session.csrfToken;
    headers["x-octant-command-id"] = randomUUID();
    headers["content-type"] = "application/json";
  }
  return {
    method,
    path: init.path,
    sourceKey: session.paired.sourceKey,
    headers,
    ...(body === undefined ? {} : { body }),
  };
}

function grantBody(
  listenerIndex: number,
  surface: "local-servers" | "running-services" = "local-servers",
) {
  const listenerId = `lsn_${listenerIndex.toString(16).padStart(32, "0")}`;
  return JSON.stringify({
    kind: "open-remote-server-grant",
    requestId: randomUUID(),
    source:
      surface === "local-servers"
        ? { surface, threadId, projectId, listenerId }
        : { surface, listenerId },
  });
}

function listed(
  index: number,
  overrides: Partial<Extract<RemoteServerGrantTarget, { readonly status: "listed" }>> = {},
): RemoteServerGrantTarget {
  return {
    status: "listed",
    ownership: "octant-owned",
    health: "listening",
    threadId,
    endpoint: {
      url: `http://127.0.0.1:${5170 + index}/`,
      port: 5170 + index,
      pid: 4000 + index,
      processName: "node",
    },
    ...overrides,
  };
}

function listenerKey(index: number): string {
  return `lsn_${index.toString(16).padStart(32, "0")}`;
}

async function openGrant(harness: Harness, proxy: Session, index: number): Promise<Answer> {
  return call(harness, signed(proxy, { path: "/api/server-proxy/grants", body: grantBody(index) }));
}

function result(answer: Answer): RemoteServerGrantResult {
  expect(answer.status).toBe(200);
  return decodeRemoteServerGrantResult(answer.json());
}

function closedReasons(connection: SqliteConnection): string[] {
  return (
    connection
      .prepare(
        `SELECT payload_json FROM event_journal WHERE event_name = ? ORDER BY global_sequence`,
      )
      .all(REMOTE_SERVER_GRANT_CLOSED) as ReadonlyArray<{ readonly payload_json: string }>
  ).map((row) => (JSON.parse(row.payload_json) as { readonly reason: string }).reason);
}

describe("proxy session and grant route on the private listener", () => {
  it("mints a proxy session from a challenge signed over the proxy transcript and opens a grant", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const opened = result(await openGrant(harness, proxy, 1));
    expect(opened.kind).toBe("remote-server-grant-opened");
    expect(harness.grants.openCount(paired.deviceId)).toBe(1);
    expect(harness.dispatched).toEqual([]);
  });

  it("refuses a product-transcript signature as a proxy session, and the reverse", async () => {
    const harness = await setup();
    const paired = await pair(harness);
    const asProxy = await signIn(harness, paired, "server-proxy", { signAs: "product" });
    expect(asProxy.answer.status).toBe(401);
    const asProduct = await signIn(harness, paired, "product", { signAs: "server-proxy" });
    expect(asProduct.answer.status).toBe(401);
  });

  it("clears only the proxy cookie when a proxy session is refused", async () => {
    const harness = await setup();
    const paired = await pair(harness);
    const { answer } = await signIn(harness, paired, "server-proxy", { replay: true });
    expect(answer.status).toBe(401);
    const cleared = answer.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${PROXY_COOKIE}=;`);
    expect(cleared).not.toContain(PRODUCT_COOKIE);
  });

  it("never lets a product session reach the proxy route", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const product = await session(harness, paired, "product");
    // The product cookie on the proxy route names no proxy session.
    const productCookie = await call(
      harness,
      signed(product, { path: "/api/server-proxy/grants", body: grantBody(1) }),
    );
    expect(productCookie.status).toBe(401);
    // Nor does a product session id carried in the proxy cookie.
    const smuggled = await call(
      harness,
      signed(product, {
        path: "/api/server-proxy/grants",
        body: grantBody(1),
        cookie: `${PROXY_COOKIE}=${product.sessionId}`,
      }),
    );
    expect(smuggled.status).toBe(401);
    expect(harness.grants.openCount()).toBe(0);
  });

  it("never lets a proxy session reach a product route", async () => {
    const harness = await setup();
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const proxyCookie = await call(
      harness,
      signed(proxy, { path: "/api/chat/threads", body: "{}" }),
    );
    expect(proxyCookie.status).toBe(401);
    const smuggled = await call(
      harness,
      signed(proxy, {
        path: "/api/chat/threads",
        body: "{}",
        cookie: `${PRODUCT_COOKIE}=${proxy.sessionId}`,
      }),
    );
    expect(smuggled.status).toBe(401);
    expect(harness.dispatched).toEqual([]);
  });

  it("refuses a caller with no session, an invented session, and an unpaired device", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const withoutCookie = signed(proxy, { path: "/api/server-proxy/grants", body: grantBody(1) });
    const noCookie = await call(harness, {
      ...withoutCookie,
      headers: Object.fromEntries(
        Object.entries(withoutCookie.headers).filter(([name]) => name !== "cookie"),
      ),
    });
    expect(noCookie.status).toBe(401);
    const invented = await call(
      harness,
      signed(proxy, {
        path: "/api/server-proxy/grants",
        body: grantBody(1),
        cookie: `${PROXY_COOKIE}=${randomUUID()}`,
      }),
    );
    expect(invented.status).toBe(401);
    const stranger = await call(harness, {
      method: "POST",
      path: "/api/remote/auth/challenge",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId, deviceId: randomUUID(), credentialGeneration: 1 }),
    });
    expect(stranger.status).toBe(401);
    expect(harness.grants.openCount()).toBe(0);
  });

  it("refuses a proof made for another path or by another key, and any other proxy path", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const otherPath = await call(
      harness,
      signed(proxy, {
        path: "/api/server-proxy/grants",
        signedPath: "/api/code/local-servers/commands",
        body: grantBody(1),
      }),
    );
    expect(otherPath.status).toBe(400);
    const otherKey = await call(
      harness,
      signed(proxy, {
        path: "/api/server-proxy/grants",
        body: grantBody(1),
        signWith: deviceKeypair("Other").privateKeyPem,
      }),
    );
    expect(otherKey.status).toBe(401);
    const elsewhere = await call(
      harness,
      signed(proxy, { path: "/api/server-proxy/anything", body: grantBody(1) }),
    );
    expect(elsewhere.status).toBe(404);
    const namesItsThread = await call(
      harness,
      signed(proxy, {
        path: "/api/server-proxy/grants",
        body: JSON.stringify({
          kind: "open-remote-server-grant",
          requestId: randomUUID(),
          source: { surface: "running-services", listenerId: listenerKey(1), threadId },
        }),
      }),
    );
    expect(namesItsThread.status).toBe(400);
    expect(harness.grants.openCount()).toBe(0);
  });

  it("states every policy refusal through the route", async () => {
    const harness = await setup();
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const { threadId: _thread, ...noThread } = listed(4) as Extract<
      RemoteServerGrantTarget,
      { readonly status: "listed" }
    >;
    harness.targets.set(listenerKey(2), listed(2, { ownership: "leftover" }));
    harness.targets.set(listenerKey(3), listed(3, { health: "unresponsive" }));
    harness.targets.set(listenerKey(4), noThread);
    const reasons: string[] = [];
    for (const index of [1, 2, 3]) {
      const answer = result(await openGrant(harness, proxy, index));
      if (answer.kind === "remote-server-grant-refused") reasons.push(answer.refusal.reason);
    }
    const running = result(
      await call(
        harness,
        signed(proxy, { path: "/api/server-proxy/grants", body: grantBody(4, "running-services") }),
      ),
    );
    if (running.kind === "remote-server-grant-refused") reasons.push(running.refusal.reason);
    harness.targets.set(listenerKey(5), listed(5));
    harness.readable.delete(String(threadId));
    const unreadable = result(await openGrant(harness, proxy, 5));
    if (unreadable.kind === "remote-server-grant-refused") reasons.push(unreadable.refusal.reason);
    expect(reasons).toEqual([
      "not-found",
      "not-octant-owned",
      "not-listening",
      "not-in-thread",
      "thread-unreadable",
    ]);
  });

  it("refuses a device's ninth grant", async () => {
    const harness = await setup();
    for (let index = 1; index <= 9; index += 1)
      harness.targets.set(listenerKey(index), listed(index));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    for (let index = 1; index <= 8; index += 1) {
      expect(result(await openGrant(harness, proxy, index)).kind).toBe(
        "remote-server-grant-opened",
      );
    }
    const ninth = result(await openGrant(harness, proxy, 9));
    expect(ninth.kind === "remote-server-grant-refused" && ninth.refusal.reason).toBe(
      "grant-limit",
    );
  });

  it("closes a revoked device's grants before the revoke returns, and refuses its next request", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    harness.targets.set(listenerKey(2), listed(2));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    result(await openGrant(harness, proxy, 1));
    harness.gateway.localDeviceAdministration()?.revokeDevice({ deviceId: paired.deviceId });
    expect(harness.grants.openCount()).toBe(0);
    expect(closedReasons(harness.connection)).toEqual(["device-revoked"]);
    expect((await openGrant(harness, proxy, 2)).status).toBe(401);
  });

  it("closes a device's grants when it signs itself out", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const product = await session(harness, paired, "product");
    const proxy = await session(harness, paired, "server-proxy");
    result(await openGrant(harness, proxy, 1));
    const signOut = await call(
      harness,
      signed(product, { path: "/api/remote/auth/sign-out", body: "{}" }),
    );
    expect(signOut.status).toBe(200);
    expect(harness.grants.openCount()).toBe(0);
    expect(closedReasons(harness.connection)).toEqual(["device-signed-out"]);
  });

  it("closes every grant when the listener is disabled", async () => {
    const harness = await setup();
    harness.targets.set(listenerKey(1), listed(1));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    result(await openGrant(harness, proxy, 1));
    await harness.gateway.stop();
    expect(harness.grants.openCount()).toBe(0);
    expect(closedReasons(harness.connection)).toEqual(["listener-disabled"]);
  });

  it("keeps a page's proxy requests and the interface's product requests on separate budgets", async () => {
    const harness = await setup();
    const paired = await pair(harness);
    const product = await session(harness, paired, "product");
    const proxy = await session(harness, paired, "server-proxy");

    // Fill the product budget with requests that do not finish.
    let releaseProduct = () => {};
    harness.hold = new Promise<void>((resolve) => {
      releaseProduct = resolve;
    });
    const held = Array.from({ length: 32 }, () =>
      call(harness, signed(product, { path: "/api/chat/threads", body: "{}" })),
    );
    await vi.waitFor(() => expect(harness.dispatched).toHaveLength(32));
    const productOver = await call(
      harness,
      signed(product, { path: "/api/chat/threads", body: "{}" }),
    );
    expect(productOver.status).toBe(429);
    harness.targets.set(listenerKey(1), listed(1));
    expect(result(await openGrant(harness, proxy, 1)).kind).toBe("remote-server-grant-opened");
    releaseProduct();
    harness.hold = undefined;
    await Promise.all(held);

    // Hold a grant request open; the device's next one waits its turn while
    // the interface's product requests still go through.
    let releaseProxy = () => {};
    const waiting = new Promise<void>((resolve) => {
      releaseProxy = resolve;
    });
    let observing = 0;
    harness.targets.set(listenerKey(10), async () => {
      observing += 1;
      await waiting;
      return listed(10);
    });
    const pending = openGrant(harness, proxy, 10);
    await vi.waitFor(() => expect(observing).toBe(1));
    harness.targets.set(listenerKey(50), listed(50));
    const proxyOver = await openGrant(harness, proxy, 50);
    expect(proxyOver.status).toBe(503);
    expect(proxyOver.headers.get("retry-after")).toBe("1");
    const productStill = await call(
      harness,
      signed(product, { path: "/api/chat/threads", body: "{}" }),
    );
    expect(productStill.status).toBe(200);
    releaseProxy();
    expect(result(await pending).kind).toBe("remote-server-grant-opened");
    expect(result(await openGrant(harness, proxy, 50)).kind).toBe("remote-server-grant-opened");
  });
});

interface DevServer {
  readonly port: number;
  readonly requests: Array<{
    readonly method: string;
    readonly url: string;
    readonly headers: IncomingHttpHeaders;
    readonly body: string;
  }>;
  /** Sockets the dev server accepted, so a case can see the host close one. */
  readonly sockets: Socket[];
  /** Upgrade requests the dev server received, and answered like a hot-reload socket. */
  readonly upgrades: string[];
}

type DevHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function devServer(
  handle: DevHandler,
  tls?: { readonly cert: string | Buffer; readonly key: string | Buffer },
  port = 0,
): Promise<DevServer> {
  const requests: DevServer["requests"] = [];
  const sockets: Socket[] = [];
  const listener = (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handle(request, response);
    });
  };
  const upgrades: string[] = [];
  const server = tls === undefined ? createHttpServer(listener) : createHttpsServer(tls, listener);
  server.on("upgrade", (request: IncomingMessage, socket: Socket) => {
    upgrades.push(request.url ?? "");
    const accept = createHash("sha1")
      .update(`${String(request.headers["sec-websocket-key"])}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  server.on(tls === undefined ? "connection" : "secureConnection", (socket: Socket) =>
    sockets.push(socket),
  );
  devServers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return { port: (server.address() as AddressInfo).port, requests, sockets, upgrades };
}

function listedAt(index: number, server: { readonly port: number }, scheme = "http") {
  return listed(index, {
    endpoint: {
      url: `${scheme}://127.0.0.1:${server.port}/`,
      port: server.port,
      pid: 4000 + index,
      processName: "node",
    },
  });
}

async function grantTo(harness: Harness, proxy: Session, index: number): Promise<string> {
  const opened = result(await openGrant(harness, proxy, index));
  if (opened.kind !== "remote-server-grant-opened") throw new Error("grant refused");
  return String(opened.grant.grantId);
}

function relayRequest(
  proxy: Session,
  grantId: string,
  init: {
    readonly path?: string;
    readonly method?: string;
    readonly body?: string;
    readonly headers?: Record<string, string>;
  } = {},
) {
  const request = signed(proxy, {
    path: `/api/server-proxy/${grantId}${init.path ?? "/"}`,
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return { ...request, headers: { ...request.headers, ...init.headers } };
}

async function send(
  harness: Harness,
  init: ReturnType<typeof relayRequest>,
  url = `${ORIGIN}${init.path}`,
): Promise<Response> {
  const request = new Request(url, {
    method: init.method,
    headers: new Headers({ host: HOST_HEADER, ...init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return harness.fetch(request, facts(init.sourceKey));
}

function refusalReason(answer: Answer): string {
  return decodeRemoteServerProxyRefusal(answer.json()).reason;
}

/** A dev server that sends one chunk and then holds the response open. */
function streaming(): DevHandler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("first\n");
  };
}

describe("relay from a paired device to its granted dev server", () => {
  it("forwards to the loopback endpoint as localhost and never lets Octant's credentials cross either way", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => {
      response.writeHead(201, {
        "content-type": "text/html",
        "content-security-policy": "script-src 'self'",
        connection: "keep-alive, x-hop",
        "x-hop": "1",
        "x-octant-server-proxy": "forged",
        "x-octant-device-proof": "forged",
        "set-cookie": [
          "__Secure-octant-server-proxy-session=forged; Path=/",
          "app_session=next; Path=/; HttpOnly",
        ],
      });
      response.end("<p>dev page</p>");
    });
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);

    const answer = await call(
      harness,
      relayRequest(proxy, grantId, {
        method: "POST",
        path: "/api/items?b=2&a=1&flag",
        body: "name=one",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: `${proxy.cookie}; app_session=abc; __Host-octant-claim=secret`,
          referer: `${ORIGIN}/api/server-proxy/${grantId}/form?x=1`,
          authorization: "Bearer dev-token",
          "x-dev": "kept",
        },
      }),
    );

    expect(answer.status).toBe(201);
    expect(server.requests).toHaveLength(1);
    const seen = server.requests[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/items?b=2&a=1&flag");
    expect(seen.body).toBe("name=one");
    expect(seen.headers.host).toBe(`localhost:${server.port}`);
    expect(seen.headers.origin).toBe(`http://localhost:${server.port}`);
    expect(seen.headers.referer).toBe(`http://localhost:${server.port}/form?x=1`);
    expect(seen.headers.cookie).toBe("app_session=abc");
    expect(seen.headers.authorization).toBe("Bearer dev-token");
    expect(seen.headers["x-dev"]).toBe("kept");
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    for (const name of Object.keys(seen.headers)) {
      expect(name.startsWith("x-octant-")).toBe(false);
      expect(name.startsWith("sec-fetch-")).toBe(false);
      expect(name.startsWith("x-forwarded-")).toBe(false);
    }
    expect(seen.headers.forwarded).toBeUndefined();

    expect(answer.headers.get(REMOTE_SERVER_PROXY_RELAYED_HEADER)).toBe(
      REMOTE_SERVER_PROXY_RELAYED,
    );
    expect(answer.headers.get("content-security-policy")).toBe("script-src 'self'");
    expect(answer.headers.get("x-hop")).toBeNull();
    expect(answer.headers.get("x-octant-device-proof")).toBeNull();
    expect(answer.headers.getSetCookie()).toEqual(["app_session=next; Path=/; HttpOnly"]);
    expect(harness.dispatched).toEqual([]);
  });

  it("refuses every request without its own session's proof before connecting", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("ok"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const product = await session(harness, paired, "product");
    const grantId = await grantTo(harness, proxy, 1);
    const good = relayRequest(proxy, grantId);

    const noCookie = await call(harness, {
      ...good,
      headers: Object.fromEntries(
        Object.entries(good.headers).filter(([name]) => name !== "cookie"),
      ),
    });
    expect(noCookie.status).toBe(401);
    const noProof = await call(harness, {
      ...good,
      headers: Object.fromEntries(
        Object.entries(good.headers).filter(([name]) => name !== "x-octant-device-proof"),
      ),
    });
    expect(noProof.status).toBe(401);
    const invented = await call(
      harness,
      relayRequest(proxy, grantId, { headers: { cookie: `${PROXY_COOKIE}=${randomUUID()}` } }),
    );
    expect(invented.status).toBe(401);
    const productSession = await call(
      harness,
      signed(product, { method: "GET", path: `/api/server-proxy/${grantId}/` }),
    );
    expect(productSession.status).toBe(401);
    const otherPath = await call(
      harness,
      signed(proxy, {
        method: "GET",
        path: `/api/server-proxy/${grantId}/private`,
        signedPath: `/api/server-proxy/${grantId}/public`,
      }),
    );
    expect(otherPath.status).toBe(400);
    const otherKey = await call(
      harness,
      signed(proxy, {
        method: "GET",
        path: `/api/server-proxy/${grantId}/`,
        signWith: deviceKeypair("Other").privateKeyPem,
      }),
    );
    expect(otherKey.status).toBe(401);
    const crossSite = await call(
      harness,
      relayRequest(proxy, grantId, { headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(crossSite.status).toBe(403);
    const foreignOrigin = await call(
      harness,
      relayRequest(proxy, grantId, { headers: { origin: "https://evil.example" } }),
    );
    expect(foreignOrigin.status).toBe(403);
    expect(server.requests).toHaveLength(0);
    expect((await call(harness, good)).status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a replayed request", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("ok"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const once = relayRequest(proxy, grantId, { method: "POST", body: "{}" });
    expect((await call(harness, once)).status).toBe(200);
    const replayed = await call(harness, once);
    expect(replayed.status).not.toBe(200);
    expect(replayed.headers.get(REMOTE_SERVER_PROXY_RELAYED_HEADER)).toBeNull();
    expect(server.requests).toHaveLength(1);
  });

  it("refuses a grant held by another device exactly as one that never existed", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("ok"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const owner = await session(harness, await pair(harness, "source-owner"), "server-proxy");
    const other = await session(harness, await pair(harness, "source-other"), "server-proxy");
    const grantId = await grantTo(harness, owner, 1);
    const borrowed = await call(harness, relayRequest(other, grantId));
    const invented = await call(harness, relayRequest(other, `rsg_${"0".repeat(64)}`));
    expect(borrowed.status).toBe(404);
    expect(invented.status).toBe(404);
    expect(borrowed.json()).toEqual(invented.json());
    expect(refusalReason(borrowed)).toBe("grant-closed");
    // A second session of the owning device is not the session the grant was minted under.
    const secondSession = await session(harness, owner.paired, "server-proxy");
    expect((await call(harness, relayRequest(secondSession, grantId))).status).toBe(404);
    expect(server.requests).toHaveLength(0);
    expect(harness.grants.openCount()).toBe(1);
  });

  it("closes the grant and refuses when a check before the request fails", async () => {
    const cases: ReadonlyArray<
      readonly [title: string, lose: (harness: Harness) => void, reason: string]
    > = [
      ["the server exited", (harness) => (harness.holding.value = "stopped"), "server-stopped"],
      [
        "another process holds the port",
        (harness) => (harness.holding.value = "changed-hands"),
        "server-changed-hands",
      ],
      ["Code is off", (harness) => (harness.code.enabled = false), "code-disabled"],
      [
        "the device can no longer read the thread",
        (harness) => harness.readable.delete(String(threadId)),
        "thread-unreadable",
      ],
    ];
    for (const [title, lose, reason] of cases) {
      const harness = await setup();
      const server = await devServer((_request, response) => response.end("ok"));
      harness.targets.set(listenerKey(1), listedAt(1, server));
      const proxy = await session(harness, await pair(harness), "server-proxy");
      const grantId = await grantTo(harness, proxy, 1);
      expect((await call(harness, relayRequest(proxy, grantId))).status, title).toBe(200);
      lose(harness);
      const refused = await call(harness, relayRequest(proxy, grantId));
      expect(refused.status, title).toBe(404);
      expect(refusalReason(refused), title).toBe("grant-closed");
      expect(closedReasons(harness.connection), title).toEqual([reason]);
      expect(harness.grants.openCount(), title).toBe(0);
      expect(server.requests, title).toHaveLength(1);
    }
  });

  it("refuses without closing the grant when the host cannot check the server", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("ok"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    harness.holding.value = "unavailable";
    expect((await call(harness, relayRequest(proxy, grantId))).status).toBe(503);
    expect(harness.grants.openCount()).toBe(1);
    harness.holding.value = "held";
    expect((await call(harness, relayRequest(proxy, grantId))).status).toBe(200);
    expect(server.requests).toHaveLength(1);
  });

  it("checks the server again for every request, never on a check that began before it", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("ok"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    harness.holding.value = async () => {
      await gate;
      return "held";
    };
    const first = call(harness, relayRequest(proxy, grantId));
    await vi.waitFor(() => expect(harness.holding.asked).toBe(1));
    const burst = Array.from({ length: 6 }, () => call(harness, relayRequest(proxy, grantId)));
    open();
    const answers = await Promise.all([first, ...burst]);
    expect(answers.map((answer) => answer.status)).toEqual(Array(7).fill(200));
    // The first request's check, then one more that began after the burst arrived.
    expect(harness.holding.asked).toBe(2);
  });

  it("cuts a streaming response before a revoke returns, and refuses the device's next request", async () => {
    const harness = await setup();
    const server = await devServer(streaming());
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const paired = await pair(harness);
    const proxy = await session(harness, paired, "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const response = await send(harness, relayRequest(proxy, grantId));
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first\n");
    const upstream = server.sockets[0]!;

    harness.gateway.localDeviceAdministration()?.revokeDevice({ deviceId: paired.deviceId });
    // The host closed its end of the dev server connection inside the revoke.
    expect(harness.grants.openCount()).toBe(0);
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(upstream.destroyed || upstream.readableEnded).toBe(true));
    expect(closedReasons(harness.connection)).toEqual(["device-revoked"]);
    expect((await call(harness, relayRequest(proxy, grantId))).status).toBe(401);
    expect(server.requests).toHaveLength(1);
  });

  it("cuts a streaming response when its thread is archived mid-stream", async () => {
    const harness = await setup();
    const server = await devServer(streaming());
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const response = await send(harness, relayRequest(proxy, grantId));
    const reader = response.body!.getReader();
    await reader.read();
    harness.grants.closeThread(String(threadId), "thread-archived");
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(server.sockets[0]!.destroyed).toBe(true));
    expect(closedReasons(harness.connection)).toEqual(["thread-archived"]);
  });

  it("connects only to the grant's loopback endpoint, whatever the request names", async () => {
    const harness = await setup();
    const elsewhere = await devServer((_request, response) => response.end("elsewhere"));
    const server = await devServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/steal` });
        response.end();
        return;
      }
      response.end("dev");
    });
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);

    // A redirect is relayed as it is and never followed.
    const redirected = await call(harness, relayRequest(proxy, grantId, { path: "/redirect" }));
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get("location")).toBe(`http://127.0.0.1:${elsewhere.port}/steal`);

    // A target that looks like another host stays a path on the dev server.
    const pathTrick = await call(
      harness,
      relayRequest(proxy, grantId, { path: `//127.0.0.1:${elsewhere.port}/steal` }),
    );
    expect(pathTrick.status).toBe(200);
    expect(server.requests.at(-1)?.url).toBe(`//127.0.0.1:${elsewhere.port}/steal`);
    expect(server.requests.at(-1)?.headers.host).toBe(`localhost:${server.port}`);

    // The listener refuses another Host, a forwarded host, and an absolute
    // target naming another origin before anything is checked.
    const otherHost = await send(
      harness,
      relayRequest(proxy, grantId, { headers: { host: `127.0.0.1:${elsewhere.port}` } }),
    );
    expect(otherHost.status).toBe(400);
    const forwardedHost = await send(
      harness,
      relayRequest(proxy, grantId, { headers: { "x-forwarded-host": "127.0.0.1" } }),
    );
    expect(forwardedHost.status).toBe(400);
    const absolute = relayRequest(proxy, grantId);
    expect(
      (await send(harness, absolute, `http://127.0.0.1:${elsewhere.port}${absolute.path}`)).status,
    ).toBe(400);
    expect(elsewhere.requests).toHaveLength(0);
  });

  it("refuses an endpoint that is not a loopback address literal", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("dev"));
    harness.targets.set(
      listenerKey(1),
      listed(1, {
        endpoint: {
          url: `http://localhost:${server.port}/`,
          port: server.port,
          pid: 4001,
          processName: "node",
        },
      }),
    );
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const refused = await call(harness, relayRequest(proxy, grantId));
    expect(refused.status).toBe(502);
    expect(refusalReason(refused)).toBe("server-unreachable");
    expect(server.requests).toHaveLength(0);
  });

  it("answers unreachable when nothing accepts the connection", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("dev"));
    const port = server.port;
    const closing = devServers.splice(devServers.length - 1, 1)[0]!;
    await new Promise<void>((resolve) => closing.close(() => resolve()));
    harness.targets.set(listenerKey(1), listedAt(1, { port }));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const refused = await call(harness, relayRequest(proxy, grantId));
    expect(refused.status).toBe(502);
    expect(refusalReason(refused)).toBe("server-unreachable");
    expect(harness.grants.openCount()).toBe(1);
  });

  it("does not carry a hot-reload WebSocket: a dev server that would accept the upgrade never sees it", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("dev"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const upgrade = await call(
      harness,
      relayRequest(proxy, grantId, {
        path: "/hmr",
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
          "sec-websocket-version": "13",
          "sec-websocket-protocol": "vite-hmr",
        },
      }),
    );
    expect(upgrade.status).toBe(501);
    expect(refusalReason(upgrade)).toBe("upgrade-refused");
    expect(server.requests).toHaveLength(0);
    expect(server.upgrades).toEqual([]);
    expect(harness.grants.openCount()).toBe(1);
  });

  it("reads at most 4 KiB of a proxy request without a live session, and few at once per source", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("stored"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const path = `/api/server-proxy/${grantId}/upload`;
    const unauthenticated = (
      body: ReadableStream<Uint8Array>,
      headers: Record<string, string> = {},
    ) =>
      harness.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: new Headers({
            host: HOST_HEADER,
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
            "content-type": "application/octet-stream",
            cookie: `${PROXY_COOKIE}=${randomUUID()}`,
            ...headers,
          }),
          body,
          duplex: "half",
        } as RequestInit),
        facts("unauthenticated-source"),
      );
    // An endless upload with no declared length: the listener stops reading
    // just past 4 KiB and answers.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1_024;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    expect((await unauthenticated(endless)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(8 * 1_024);
    // A declared 8 MiB is refused before a byte is read.
    let declaredPulled = 0;
    const declared = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredPulled += 1_024;
        controller.enqueue(new Uint8Array(1_024));
      },
    });
    const refused = await unauthenticated(declared, {
      "content-length": String(8 * 1_024 * 1_024),
    });
    expect(refused.status).toBe(413);
    expect(declaredPulled).toBeLessThanOrEqual(1_024);

    // Uploads that stall below the cap hold only four places per source.
    const stalled = Array.from({ length: 4 }, () => {
      let stop = () => {};
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16));
          stop = () => controller.close();
        },
      });
      return { answer: unauthenticated(body), stop: () => stop() };
    });
    await vi.waitFor(async () => {
      const fifth = await unauthenticated(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
      );
      expect(fifth.status).toBe(429);
    });
    for (const upload of stalled) upload.stop();
    for (const upload of stalled) expect((await upload.answer).status).toBe(401);
    expect(server.requests).toHaveLength(0);
  });

  it("relays an upload up to 8 MiB and refuses a larger one with 413", async () => {
    const harness = await setup();
    const server = await devServer((_request, response) => response.end("stored"));
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const large = "x".repeat(8 * 1_024 * 1_024);
    const accepted = await call(
      harness,
      relayRequest(proxy, grantId, {
        method: "PUT",
        body: large,
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(accepted.status).toBe(200);
    expect(server.requests[0]?.body.length).toBe(large.length);
    const tooLarge = await call(
      harness,
      relayRequest(proxy, grantId, {
        method: "PUT",
        body: "x".repeat(8 * 1_024 * 1_024 + 1),
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(tooLarge.status).toBe(413);
    expect(server.requests).toHaveLength(1);
  });

  it("streams a response larger than the listener's own budget", async () => {
    const harness = await setup();
    const size = 9 * 1_024 * 1_024;
    const server = await devServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(size, 1));
    });
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const response = await send(harness, relayRequest(proxy, grantId));
    expect((await response.arrayBuffer()).byteLength).toBe(size);
  });

  it("closes a response the dev server leaves silent past the idle bound", async () => {
    const harness = await setup({ idleTimeoutMs: 200 });
    const server = await devServer(streaming());
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const response = await send(harness, relayRequest(proxy, grantId));
    const reader = response.body!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow();
    await vi.waitFor(() => expect(server.sockets[0]!.destroyed).toBe(true));
    // An idle dev server is not a lost grant.
    expect(harness.grants.openCount()).toBe(1);
  });

  it("answers past the device's proxy budget with 503 and a one-second Retry-After", async () => {
    const harness = await setup();
    const server = await devServer(streaming());
    harness.targets.set(listenerKey(1), listedAt(1, server));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    const held = await Promise.all(
      Array.from({ length: 32 }, () => send(harness, relayRequest(proxy, grantId))),
    );
    expect(held.every((response) => response.status === 200)).toBe(true);
    const over = await call(harness, relayRequest(proxy, grantId));
    expect(over.status).toBe(503);
    expect(over.headers.get("retry-after")).toBe("1");
    // A finished response gives its place back.
    await held[0]!.body!.cancel();
    expect((await send(harness, relayRequest(proxy, grantId))).status).toBe(200);
  });

  it("pins an HTTPS dev server's certificate for the grant's life", async () => {
    const harness = await setup();
    const first = await devServer((_request, response) => response.end("secure"), {
      cert: PRIVATE_LISTENER_TEST_CERT,
      key: PRIVATE_LISTENER_TEST_KEY,
    });
    harness.targets.set(listenerKey(1), listedAt(1, first, "https"));
    const proxy = await session(harness, await pair(harness), "server-proxy");
    const grantId = await grantTo(harness, proxy, 1);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const answer = await call(harness, relayRequest(proxy, grantId));
      expect(answer.status).toBe(200);
      expect(first.requests.at(-1)?.headers.origin).toBe(`https://localhost:${first.port}`);
    }

    // Another server takes the same port with another certificate.
    const closing = devServers.splice(devServers.length - 1, 1)[0]!;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
    const directory = mkdtempSync(join(tmpdir(), "octant-dev-cert-"));
    directories.push(directory);
    const made = createSelfMadeListenerCertificateStore({ dataDirectory: directory }).ensure(
      "127.0.0.1",
    );
    if (made.status !== "ready") throw new Error("no certificate");
    const second = await devServer(
      (_request, response) => response.end("other"),
      made.tls,
      first.port,
    );
    const refused = await call(harness, relayRequest(proxy, grantId));
    expect(refused.status).toBe(404);
    expect(refusalReason(refused)).toBe("grant-closed");
    expect(second.requests).toHaveLength(0);
    expect(closedReasons(harness.connection)).toEqual(["server-changed-hands"]);
  });
});
