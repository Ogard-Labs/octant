// The proxy session and the grant route, driven through the real gateway
// composition in memory: a capturing `serve` records the production boundary
// fetch (admission, route policy, authentication) and each case calls it with
// synthetic transport facts, as the hostile security matrix does.

import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { decodeRemoteSessionResponseV1 } from "@octant/contracts/remote-request-proof";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteRequestProofPayload,
  buildRemoteServerProxySessionProofPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
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

afterEach(() => {
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
  /** Holds product requests open while set, to fill the product budget. */
  hold: Promise<void> | undefined;
}

async function setup(): Promise<Harness> {
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
    journal,
    hostActor: decodeEventActor({
      kind: "system",
      actorId: "33333333-3333-4333-8333-333333333333",
    }),
    uuid: randomUUID,
    clock: () => nowIso,
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
  options: { readonly signAs?: "product" | "server-proxy"; readonly path?: string } = {},
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
  const answer = await call(harness, {
    method: "POST",
    path:
      options.path ??
      (kind === "product" ? "/api/remote/auth/session" : "/api/remote/auth/server-proxy-session"),
    sourceKey,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...challenge, signature }),
  });
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

    // Fill the proxy budget for this device with grant requests that do not finish.
    let releaseProxy = () => {};
    const waiting = new Promise<void>((resolve) => {
      releaseProxy = resolve;
    });
    let observing = 0;
    for (let index = 10; index < 42; index += 1) {
      harness.targets.set(listenerKey(index), async () => {
        observing += 1;
        await waiting;
        return listed(index);
      });
    }
    const pending = Array.from({ length: 32 }, (_, offset) =>
      openGrant(harness, proxy, 10 + offset),
    );
    await vi.waitFor(() => expect(observing).toBe(32));
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
    await Promise.all(pending);
  });
});
