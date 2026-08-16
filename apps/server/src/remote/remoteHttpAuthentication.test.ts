import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  decodeRemoteSelfServiceReceiptV1,
  decodeRemoteSessionResponseV1,
} from "@octant/contracts/remote-request-proof";
import {
  buildRemoteChallengeProofPayload,
  buildRemoteKeyRotationProofPayload,
  buildRemoteRequestProofPayload,
  buildRemoteSessionMetadataPayload,
  canonicalizeRemotePathQuery,
  sessionExpiry,
} from "@octant/domain";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { Journal } from "../persistence/journal";
import { openSqlite } from "../persistence/sqlitePort";
import { RemoteRequestProofService } from "../remoteRequestProofService";
import { RemoteCredentialLifecycleService } from "../remoteCredentialLifecycleService";
import {
  createRemoteRouteHandler,
  createRemoteRoutePolicy,
  type RemoteRouteDefinition,
} from "../remoteRoutePolicy";
import { canonicalDeviceKeyFacts } from "./deviceKeyFacts";
import { createRemoteRequestRegistry, type RemoteRequestRegistry } from "./remoteRequestRegistry";
import {
  createRemoteHttpAuthentication,
  REMOTE_SESSION_COOKIE,
  type RemoteHttpAuthentication,
  type RemoteClientPrincipalHandoff,
  type RemoteCredentialSelfServicePort,
} from "./remoteHttpAuthentication";

function asCredentialSelfService(
  lifecycle: RemoteCredentialLifecycleService,
): RemoteCredentialSelfServicePort {
  return {
    readOwnDevice: (input) =>
      lifecycle.readOwnDeviceMetadata(input) as ReturnType<
        NonNullable<RemoteCredentialSelfServicePort["readOwnDevice"]>
      >,
    signOut: (input) => lifecycle.signOut(input),
    selfRotateDevice: (input) => lifecycle.selfRotateDevice(input),
    selfRevokeDevice: (input) => lifecycle.selfRevokeDevice(input),
  };
}

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const deviceId = "22222222-2222-4222-8222-222222222222";
const commandId = "66666666-6666-4666-8666-666666666666";
const now = Date.parse("2026-07-29T09:00:00.000Z");
const origin = "https://mac.example.test";
const capabilityDigest = "c".repeat(64);
const negotiation = { origin, protocolVersion: 1, authenticationVersion: 1, capabilityDigest };
const transport = {
  listenerTrust: "remote",
  sourceClass: "lan-private",
  sourceKey: "opaque-test-source-key",
} as const;
const directories: string[] = [];

const challengeRoute: RemoteRouteDefinition = {
  id: "remote-auth-challenge",
  match: { kind: "exact", path: "/api/remote/auth/challenge" },
  surface: "pre-auth",
  methods: ["POST"],
  allowQuery: false,
};
const sessionRoute: RemoteRouteDefinition = {
  id: "remote-auth-session",
  match: { kind: "exact", path: "/api/remote/auth/session" },
  surface: "pre-auth",
  methods: ["POST"],
  allowQuery: false,
};
const signOutRoute: RemoteRouteDefinition = {
  id: "remote-auth-sign-out",
  match: { kind: "exact", path: "/api/remote/auth/sign-out" },
  surface: "authenticated-product",
  methods: ["POST"],
  allowQuery: false,
};
const rotateKeyRoute: RemoteRouteDefinition = {
  id: "remote-auth-rotate-key",
  match: { kind: "exact", path: "/api/remote/auth/rotate-key" },
  surface: "authenticated-product",
  methods: ["POST"],
  allowQuery: false,
};
const revokeSelfRoute: RemoteRouteDefinition = {
  id: "remote-auth-revoke-self",
  match: { kind: "exact", path: "/api/remote/auth/revoke-self" },
  surface: "authenticated-product",
  methods: ["POST"],
  allowQuery: false,
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface SetupOptions {
  readonly withDispatch?: boolean;
  readonly withSelfService?: boolean;
  readonly withRegistry?: boolean;
  readonly withRevalidation?: boolean;
  readonly admission?: (bucket: string) => (() => void) | undefined;
  readonly productDispatch?: (
    handoff: RemoteClientPrincipalHandoff,
  ) => Promise<Response | undefined>;
  /**
   * When true, skips construction-time validation that productDispatch requires
   * registry + revalidation. Used only by tests that explicitly test the
   * fail-closed behavior.
   */
  readonly skipRequiredSecureBundle?: boolean;
}

function setup(options: SetupOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "octant-http-auth-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "store.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => new Date(now).toISOString());
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  if (options.withSelfService === true) {
    connection
      .prepare(
        `INSERT INTO host_identity_projection
          (identity_key, host_id, display_name, key_fingerprint, key_generation, created_at, rotated_at)
         VALUES ('host', ?, ?, ?, ?, ?, NULL)`,
      )
      .run(hostId, "This Mac", "a".repeat(64), 1, new Date(now).toISOString());
  }
  connection
    .prepare(
      `INSERT INTO remote_device_projection (
        device_id, host_id, device_key_fingerprint, device_public_key, device_label,
        origin, protocol_floor, credential_generation, created_at, expires_at, last_seen_at, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      deviceId,
      hostId,
      "b".repeat(64),
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "Browser",
      origin,
      1,
      1,
      new Date(now).toISOString(),
      new Date(now + 30 * 24 * 60 * 60 * 1_000).toISOString(),
      new Date(now).toISOString(),
    );
  let clock = now;
  const service = new RemoteRequestProofService(connection, {
    now: () => clock,
    resolveNegotiation: () => negotiation,
  });
  let lifecycleService: RemoteCredentialLifecycleService | undefined;
  let registry: ReturnType<typeof createRemoteRequestRegistry> | undefined;
  const canceled: string[] = [];
  // Auto-wire registry + revalidation when productDispatch is used, since
  // createRemoteHttpAuthentication requires them in a production-capable config.
  const needsRegistry =
    options.withSelfService === true ||
    options.withRegistry === true ||
    (options.skipRequiredSecureBundle !== true &&
      (options.withDispatch === true || options.productDispatch !== undefined));
  const needsRevalidation =
    options.withRevalidation === true ||
    (options.skipRequiredSecureBundle !== true &&
      (options.withDispatch === true || options.productDispatch !== undefined));
  if (needsRegistry) {
    registry = createRemoteRequestRegistry();
  }
  if (options.withSelfService === true) {
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => new Date(clock).toISOString(),
    });
    let lifecycleUuidCounter = 0;
    lifecycleService = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId: "44444444-4444-4444-8444-444444444444",
      uuid: () =>
        `44444444-4444-4444-8444-${(lifecycleUuidCounter++).toString(16).padStart(12, "0")}`,
      clock: () => new Date(clock).toISOString(),
      onSessionsInvalidated: (input) => {
        let canceledCount = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = registry!.cancelByDevice({ hostId: input.hostId, deviceId: id });
          canceledCount += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        canceled.push(...input.sessionIdDigests);
        return { canceled: canceledCount, cancelHookFailures };
      },
    });
  }
  const dispatched: {
    readonly principal: RemoteClientPrincipalHandoff["principal"];
    readonly freshness: RemoteClientPrincipalHandoff["freshness"];
    readonly requestFacts: RemoteClientPrincipalHandoff["requestFacts"];
    readonly forwardedHeaders: Headers;
    readonly forwardedBody: ReadableStream<Uint8Array> | null;
    readonly bodyText: string;
  }[] = [];
  const admissionInputs: unknown[] = [];
  const released: string[] = [];
  const auth = createRemoteHttpAuthentication({
    proofService: service,
    signNegotiationMetadata: (payload) =>
      createHash("sha256").update(payload, "utf8").digest("hex"),
    ...(lifecycleService === undefined
      ? {}
      : { credentialSelfService: asCredentialSelfService(lifecycleService) }),
    ...(registry === undefined ? {} : { requestRegistry: registry }),
    ...(needsRevalidation === false
      ? {}
      : {
          sessionRevalidation: {
            isSessionActive: (sessionId: string) =>
              service.describeSession(sessionId) !== undefined,
          },
        }),
    ...(options.admission === undefined
      ? {}
      : {
          admission: {
            acquire: (input: { bucket: string }) => {
              admissionInputs.push(input);
              const release = options.admission?.(input.bucket);
              if (release === undefined) return undefined;
              return () => {
                released.push(input.bucket);
                release();
              };
            },
          },
        }),
    ...(options.withDispatch === true && options.productDispatch === undefined
      ? {
          productDispatch: async (handoff: RemoteClientPrincipalHandoff) => {
            dispatched.push({
              principal: handoff.principal,
              freshness: handoff.freshness,
              requestFacts: handoff.requestFacts,
              forwardedHeaders: handoff.request.headers,
              forwardedBody: handoff.request.body,
              bodyText: await handoff.request.text(),
            });
            return Response.json({ ok: true });
          },
        }
      : {}),
    ...(options.productDispatch !== undefined ? { productDispatch: options.productDispatch } : {}),
  });
  return {
    connection,
    service,
    auth,
    dispatched,
    admissionInputs,
    released,
    lifecycleService,
    registry,
    canceled,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    setClock: (value: number) => {
      clock = value;
    },
  };
}

function clientSign(privateKey: string, payload: string): string {
  return sign("sha256", Buffer.from(payload), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
}

function jsonPost(path: string, value: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: {
      host: "mac.example.test",
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

async function issueSessionOverHttp(auth: RemoteHttpAuthentication, privateKey: string) {
  const challengeResponse = await auth.handlePreAuthRoute(
    jsonPost("/api/remote/auth/challenge", { hostId, deviceId, credentialGeneration: 1 }),
    challengeRoute,
    transport,
  );
  expect(challengeResponse?.status).toBe(200);
  const challenge = (await challengeResponse?.json()) as Record<string, string | number>;
  const sessionFacts = {
    ...negotiation,
    ...sessionExpiry(Date.parse(challenge.issuedAt as string)),
  };
  const signature = clientSign(
    privateKey,
    buildRemoteChallengeProofPayload({
      challenge: challenge as never,
      sessionFacts,
    }),
  );
  const sessionResponse = await auth.handlePreAuthRoute(
    jsonPost("/api/remote/auth/session", { ...challenge, signature }),
    sessionRoute,
    transport,
  );
  expect(sessionResponse?.status).toBe(200);
  const body = (await sessionResponse?.json()) as Record<string, string | number>;
  const setCookie = sessionResponse?.headers.get("set-cookie") ?? "";
  const sessionId = new RegExp(`${REMOTE_SESSION_COOKIE}=([0-9a-f-]{36})`).exec(setCookie)?.[1];
  expect(sessionId).toBeDefined();
  return {
    challengeResponse,
    sessionResponse,
    session: { sessionId: sessionId as string, csrfToken: body.csrfToken as string },
    body,
    setCookie,
  };
}

interface ProductRequestOverrides {
  readonly method?: string;
  readonly target?: string;
  readonly body?: string | null;
  readonly signBody?: string | null;
  readonly signTarget?: string;
  readonly signMethod?: string;
  readonly csrf?: string | null;
  readonly signCsrf?: string | null;
  readonly nonce?: string;
  readonly timestamp?: string;
  readonly requestOrigin?: string | null;
  readonly fetchSite?: string | null;
  readonly requestCommandId?: string | null;
  readonly contentType?: string | null;
  readonly cookie?: string | null;
  readonly signed?: boolean;
  readonly envelopeMutation?: (envelope: Record<string, unknown>) => void;
  readonly proofHeader?: string;
  readonly legacyHeaders?: boolean;
  readonly extraHeaders?: Record<string, string>;
}

function productRequest(
  session: { sessionId: string; csrfToken: string },
  privateKey: string,
  overrides: ProductRequestOverrides = {},
): Request {
  const method = overrides.method ?? "POST";
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method);
  const target = overrides.target ?? "/api/chat/threads";
  const body =
    overrides.body === undefined
      ? unsafe
        ? JSON.stringify({ hello: "world" })
        : null
      : overrides.body;
  const csrf = overrides.csrf === undefined ? (unsafe ? session.csrfToken : null) : overrides.csrf;
  const signBody = overrides.signBody === undefined ? body : overrides.signBody;
  const signTarget = overrides.signTarget ?? target;
  const signCsrf = overrides.signCsrf === undefined ? csrf : overrides.signCsrf;
  const timestamp = overrides.timestamp ?? new Date(now).toISOString();
  const nonce = overrides.nonce ?? "nonce_default_1234567890";
  const proof = {
    method: overrides.signMethod ?? method,
    canonicalPathQuery: canonicalizeRemotePathQuery(signTarget) ?? signTarget,
    bodyDigest: createHash("sha256")
      .update(signBody ?? "", "utf8")
      .digest("hex"),
    ...(signCsrf === null
      ? {}
      : { csrfDigest: createHash("sha256").update(signCsrf, "utf8").digest("hex") }),
    timestamp,
    nonce,
  };
  const headers = new Headers({ host: "mac.example.test" });
  if (overrides.signed !== false) {
    const signature = clientSign(
      privateKey,
      buildRemoteRequestProofPayload({ sessionId: session.sessionId, proof }),
    );
    const envelope: Record<string, unknown> = { ...proof, signature };
    overrides.envelopeMutation?.(envelope);
    headers.set(
      "x-octant-device-proof",
      overrides.proofHeader ?? Buffer.from(JSON.stringify(envelope)).toString("base64url"),
    );
  } else if (overrides.proofHeader !== undefined) {
    headers.set("x-octant-device-proof", overrides.proofHeader);
  }
  const requestOrigin = overrides.requestOrigin === undefined ? origin : overrides.requestOrigin;
  if (requestOrigin !== null) headers.set("origin", requestOrigin);
  const fetchSite = overrides.fetchSite === undefined ? "same-origin" : overrides.fetchSite;
  if (fetchSite !== null) headers.set("sec-fetch-site", fetchSite);
  const cookie =
    overrides.cookie === undefined
      ? `${REMOTE_SESSION_COOKIE}=${session.sessionId}`
      : overrides.cookie;
  if (cookie !== null) headers.set("cookie", cookie);
  if (csrf !== null) headers.set("x-octant-csrf", csrf);
  const requestCommandId =
    overrides.requestCommandId === undefined
      ? unsafe
        ? commandId
        : null
      : overrides.requestCommandId;
  if (requestCommandId !== null) headers.set("x-octant-command-id", requestCommandId);
  const contentType =
    overrides.contentType === undefined
      ? unsafe
        ? "application/json"
        : null
      : overrides.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  if (overrides.legacyHeaders === true) {
    headers.set("x-octant-request-nonce", nonce);
    headers.set("x-octant-request-timestamp", timestamp);
  }
  for (const [name, value] of Object.entries(overrides.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  return new Request(`${origin}${target}`, {
    method,
    headers,
    ...(body === null ? {} : { body }),
  });
}

describe("remote HTTP authentication boundary", () => {
  it("issues challenges and sessions over exact routes with an HttpOnly cookie and a wire-safe body", async () => {
    const { auth, privateKey, connection } = setup();
    const { challengeResponse, sessionResponse, session, body, setCookie } =
      await issueSessionOverHttp(auth, privateKey);

    expect(challengeResponse?.headers.get("cache-control")).toBe("no-store");
    expect(challengeResponse?.headers.get("set-cookie")).toBeNull();
    expect(sessionResponse?.headers.get("cache-control")).toBe("no-store");
    expect(setCookie).toContain(`${REMOTE_SESSION_COOKIE}=${session.sessionId}`);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api/");
    expect(setCookie).not.toContain("Domain=");

    const decoded = decodeRemoteSessionResponseV1(body);
    expect(decoded.csrfToken).toBe(session.csrfToken);
    expect(decoded.authenticationVersion).toBe(1);
    // The wire body carries the session id by design: browsers forbid reading
    // `Set-Cookie` from the fetch API, so the client needs the id in the body
    // to build per-request device proofs. The HttpOnly cookie is still set.
    expect(decoded.sessionId).toBe(session.sessionId);
    expect(body.sessionId).toBe(session.sessionId);
    const metadata = buildRemoteSessionMetadataPayload({
      hostId,
      deviceId,
      credentialGeneration: 1,
      origin,
      protocolVersion: 1,
      authenticationVersion: 1,
      capabilityDigest,
      issuedAt: decoded.issuedAt,
      idleExpiresAt: decoded.idleExpiresAt,
      absoluteExpiresAt: decoded.absoluteExpiresAt,
    });
    expect(metadata).not.toContain(session.sessionId);
    expect(metadata).not.toContain(session.csrfToken);
    expect(decoded.negotiationSignature).toBe(
      createHash("sha256").update(metadata, "utf8").digest("hex"),
    );
    connection.close();
  });

  it("rejects malformed bodies, unknown devices, and bad proof signatures with generic failures", async () => {
    const { auth, service, connection } = setup();
    const malformed = await auth.handlePreAuthRoute(
      new Request(`${origin}/api/remote/auth/challenge`, {
        method: "POST",
        headers: { host: "mac.example.test", origin, "content-type": "application/json" },
        body: "{not-json",
      }),
      challengeRoute,
      transport,
    );
    expect(malformed?.status).toBe(400);

    const excess = await auth.handlePreAuthRoute(
      jsonPost("/api/remote/auth/challenge", {
        hostId,
        deviceId,
        credentialGeneration: 1,
        ticketProof: "secret",
      }),
      challengeRoute,
      transport,
    );
    expect(excess?.status).toBe(400);

    const unknownDevice = await auth.handlePreAuthRoute(
      jsonPost("/api/remote/auth/challenge", {
        hostId,
        deviceId: "99999999-9999-4999-8999-999999999999",
        credentialGeneration: 1,
      }),
      challengeRoute,
      transport,
    );
    expect(unknownDevice?.status).toBe(401);

    const challenge = service.issueChallenge({ hostId, deviceId, credentialGeneration: 1 });
    const badSignature = await auth.handlePreAuthRoute(
      jsonPost("/api/remote/auth/session", { ...challenge, signature: "forged_signature" }),
      sessionRoute,
      transport,
    );
    expect(badSignature?.status).toBe(401);
    expect(badSignature?.headers.get("set-cookie")).toBeNull();

    for (const response of [malformed, excess, unknownDevice, badSignature]) {
      expect(response?.headers.get("cache-control")).toBe("no-store");
      const payload = (await response?.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ product: "Octant", status: "rejected" });
      expect(JSON.stringify(payload)).not.toContain(deviceId);
      expect(JSON.stringify(payload)).not.toContain("forged_signature");
    }
    connection.close();
  });

  it.each(["expired", "revoked"] as const)(
    "keeps the %s lifecycle state generic before negotiation",
    async (state) => {
      const { auth, connection } = setup();
      connection
        .prepare("UPDATE remote_device_projection SET state = ? WHERE device_id = ?")
        .run(state, deviceId);

      const response = await auth.handlePreAuthRoute(
        jsonPost("/api/remote/auth/challenge", {
          hostId,
          deviceId,
          credentialGeneration: 1,
        }),
        challengeRoute,
        transport,
      );
      expect(response?.status).toBe(401);
      const payload = (await response?.json()) as Record<string, unknown>;
      expect(payload).toMatchObject({ category: "unauthorized" });
      expect(payload).not.toHaveProperty("reasonCode");
      connection.close();
    },
  );

  it("authenticates a signed read and hands a strict remote principal to dispatch", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const inbound = productRequest(session, privateKey, {
      method: "GET",
      extraHeaders: {
        authorization: "Bearer stolen-token",
        "proxy-authorization": "Basic c3RvbGVu",
        "x-client-cert": "forged-client-cert",
      },
    });
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.principal).toEqual({
      kind: "remote-device",
      hostId,
      deviceId,
      credentialGeneration: 1,
      origin,
      protocolVersion: 1,
      capabilityDigest,
      sessionId: session.sessionId,
    });
    expect(dispatched[0]?.freshness).toBe("current");

    const facts = dispatched[0]?.requestFacts;
    expect(facts).toEqual({
      method: "GET",
      canonicalPathQuery: "/api/chat/threads",
      bodyDigest: createHash("sha256").update("", "utf8").digest("hex"),
      transport,
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts?.transport)).toBe(true);
    expect(JSON.stringify(facts)).not.toContain("mac.example.test");

    const headers = dispatched[0]?.forwardedHeaders;
    for (const stripped of [
      "cookie",
      "x-octant-device-proof",
      "x-octant-csrf",
      "origin",
      "sec-fetch-site",
      "authorization",
      "proxy-authorization",
      "x-client-cert",
    ]) {
      expect(headers?.get(stripped), stripped).toBeNull();
    }
    expect(dispatched[0]?.forwardedBody).toBeNull();
    connection.close();
  });

  it("requires exact CSRF and command metadata on mutations and forwards body bytes unchanged", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const inbound = productRequest(session, privateKey);
    const ok = await auth.handleAuthenticated(inbound, transport);
    expect(ok.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.bodyText).toBe(JSON.stringify({ hello: "world" }));
    expect(inbound.bodyUsed).toBe(true);
    expect(dispatched[0]?.forwardedHeaders.get("content-type")).toBe("application/json");
    expect(dispatched[0]?.forwardedHeaders.get("x-octant-command-id")).toBe(commandId);
    expect(dispatched[0]?.forwardedHeaders.get("cookie")).toBeNull();
    expect(dispatched[0]?.requestFacts).toMatchObject({
      method: "POST",
      canonicalPathQuery: "/api/chat/threads",
      bodyDigest: createHash("sha256")
        .update(JSON.stringify({ hello: "world" }), "utf8")
        .digest("hex"),
      commandId,
    });

    for (const overrides of [
      { csrf: null, nonce: "nonce_no_csrf_1234567890" },
      { requestCommandId: null, nonce: "nonce_no_command_1234567" },
      { requestCommandId: "not-a-command-id", nonce: "nonce_bad_command_1234567" },
      { contentType: "text/plain", nonce: "nonce_bad_content_1234567" },
    ] as const) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, overrides),
        transport,
      );
      expect([400, 401]).toContain(response.status);
      expect(dispatched).toHaveLength(0);
    }
    connection.close();
  });

  it("requires exact fetch metadata and a declared content type on every unsafe method", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const emptyOk = await auth.handleAuthenticated(
      productRequest(session, privateKey, { body: "", nonce: "nonce_empty_ok_1234567" }),
      transport,
    );
    expect(emptyOk.status).toBe(200);
    expect(dispatched[0]?.bodyText).toBe("");
    expect(dispatched[0]?.forwardedBody).not.toBeNull();

    const failures: ProductRequestOverrides[] = [
      { body: "", contentType: null, nonce: "nonce_empty_noctype_123" },
      { fetchSite: null, nonce: "nonce_no_fetchsite_1234" },
      { fetchSite: "none", nonce: "nonce_fetchsite_none_12" },
      { fetchSite: "cross-site", nonce: "nonce_fetchsite_cross_1" },
      { requestOrigin: null, nonce: "nonce_no_origin_123456" },
    ];
    for (const overrides of failures) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, overrides),
        transport,
      );
      expect([400, 401]).toContain(response.status);
      expect(dispatched).toHaveLength(0);
    }

    dispatched.length = 0;
    const safeRead = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        fetchSite: "none",
        nonce: "nonce_safe_fetch_none_1",
      }),
      transport,
    );
    expect(safeRead.status).toBe(200);
    connection.close();
  });

  it("rejects malformed, noncanonical, duplicated, and oversized proof envelopes generically", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const validEnvelope = Buffer.from(
      JSON.stringify({
        method: "GET",
        canonicalPathQuery: "/api/chat/threads",
        bodyDigest: createHash("sha256").update("", "utf8").digest("hex"),
        timestamp: new Date(now).toISOString(),
        nonce: "nonce_envelope_base_1234",
        signature: "irrelevant",
      }),
    ).toString("base64url");
    const cases: (ProductRequestOverrides & { readonly label: string })[] = [
      { label: "not-json", proofHeader: Buffer.from("{not-json").toString("base64url") },
      { label: "padded-base64", proofHeader: `${validEnvelope}=` },
      {
        label: "noncanonical-base64",
        proofHeader: `${validEnvelope}A`,
      },
      { label: "duplicated", proofHeader: `${validEnvelope},${validEnvelope}` },
      { label: "oversized", proofHeader: "A".repeat(8_193) },
      {
        label: "excess-field",
        envelopeMutation: (envelope) => {
          envelope.sessionId = session.sessionId;
        },
      },
      {
        label: "missing-signature",
        envelopeMutation: (envelope) => {
          delete envelope.signature;
        },
      },
    ];
    for (const [index, overrides] of cases.entries()) {
      dispatched.length = 0;
      const { label, ...rest } = overrides;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, {
          method: "GET",
          nonce: `nonce_envelope_${index}_12345`,
          ...rest,
        }),
        transport,
      );
      expect([400, 401], label).toContain(response.status);
      expect(dispatched, label).toHaveLength(0);
    }
    connection.close();
  });

  it("rejects envelope facts that mismatch the actual derived request facts", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const mutations: Record<string, unknown>[] = [
      { canonicalPathQuery: "/api/other" },
      { method: "DELETE" },
      { bodyDigest: "e".repeat(64) },
      { csrfDigest: "f".repeat(64) },
    ];
    for (const [index, mutation] of mutations.entries()) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, {
          nonce: `nonce_env_mismatch_${index}`,
          envelopeMutation: (envelope) => {
            Object.assign(envelope, mutation);
          },
        }),
        transport,
      );
      expect([400, 401]).toContain(response.status);
      expect(dispatched).toHaveLength(0);
    }
    connection.close();
  });

  it("ignores removed legacy nonce/timestamp wire headers", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const withoutEnvelope = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        signed: false,
        legacyHeaders: true,
        nonce: "nonce_legacy_only_12345",
      }),
      transport,
    );
    expect(withoutEnvelope.status).toBe(401);
    expect(dispatched).toHaveLength(0);

    const withEnvelope = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        legacyHeaders: true,
        nonce: "nonce_legacy_plus_12345",
      }),
      transport,
    );
    expect(withEnvelope.status).toBe(200);
    connection.close();
  });

  it("derives facts from the actual request and rejects every signed-fact mismatch before dispatch", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const mismatches: ProductRequestOverrides[] = [
      { signTarget: "/api/other", nonce: "nonce_mismatch_target_1" },
      { signMethod: "GET", nonce: "nonce_mismatch_method_1" },
      { signBody: "tampered", nonce: "nonce_mismatch_body_01" },
      { signCsrf: "other-csrf", nonce: "nonce_mismatch_csrf_01" },
      { timestamp: "2026-07-29T08:50:00.000Z", nonce: "nonce_mismatch_time_01" },
      { requestOrigin: "https://evil.example.test", nonce: "nonce_mismatch_origin" },
      { fetchSite: "cross-site", nonce: "nonce_mismatch_fetch_01" },
      {
        cookie: `${REMOTE_SESSION_COOKIE}=55555555-5555-4555-8555-555555555555`,
        nonce: "nonce_mismatch_session",
      },
    ];
    for (const [index, overrides] of mismatches.entries()) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, {
          nonce: `nonce_case_${index}_1234567890`,
          ...overrides,
        }),
        transport,
      );
      expect([400, 401]).toContain(response.status);
      expect(dispatched).toHaveLength(0);
    }
    connection.close();
  });

  it("rejects duplicate cookies, oversized headers, noncanonical queries, stale sessions, replay, and cookie-only theft", async () => {
    const { auth, privateKey, dispatched, setClock, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const cases: ProductRequestOverrides[] = [
      {
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}; ${REMOTE_SESSION_COOKIE}=${session.sessionId}`,
        nonce: "nonce_dup_cookie_1234567",
      },
      {
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}${"x".repeat(4096)}`,
        nonce: "nonce_big_cookie_1234567",
      },
      { nonce: "n".repeat(256) },
      { target: "/api/chat/threads?b=2&a=1", method: "GET", nonce: "nonce_noncanonical_1" },
      { signed: false, nonce: "nonce_cookie_only_12345" },
    ];
    for (const overrides of cases) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, overrides),
        transport,
      );
      expect([400, 401]).toContain(response.status);
      expect(dispatched).toHaveLength(0);
    }

    const first = await auth.handleAuthenticated(
      productRequest(session, privateKey, { nonce: "nonce_replay_1234567890" }),
      transport,
    );
    expect(first.status).toBe(200);
    const second = await auth.handleAuthenticated(
      productRequest(session, privateKey, { nonce: "nonce_replay_1234567890" }),
      transport,
    );
    expect(second.status).toBe(401);

    setClock(now + 16 * 60 * 1_000);
    dispatched.length = 0;
    const stale = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        nonce: "nonce_stale_12345678901",
        timestamp: new Date(now + 16 * 60 * 1_000).toISOString(),
      }),
      transport,
    );
    expect(stale.status).toBe(401);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("clears invalid or stale session cookies with fixed attributes and keeps valid ones", async () => {
    const { auth, privateKey, setClock, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const expectClearingCookie = (response: Response) => {
      const clearing = response.headers.get("set-cookie");
      expect(clearing).not.toBeNull();
      expect(clearing).toContain(`${REMOTE_SESSION_COOKIE}=;`);
      expect(clearing).toContain("Secure");
      expect(clearing).toContain("HttpOnly");
      expect(clearing).toContain("SameSite=Strict");
      expect(clearing).toContain("Path=/api/");
      expect(clearing).toContain("Max-Age=0");
      expect(clearing).not.toContain("Domain=");
    };

    const unknown = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        cookie: `${REMOTE_SESSION_COOKIE}=55555555-5555-4555-8555-555555555555`,
        nonce: "nonce_clear_unknown_123",
      }),
      transport,
    );
    expect(unknown.status).toBe(401);
    expectClearingCookie(unknown);

    const duplicate = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}; ${REMOTE_SESSION_COOKIE}=${session.sessionId}`,
        nonce: "nonce_clear_duplicate_1",
      }),
      transport,
    );
    expect(duplicate.status).toBe(400);
    expectClearingCookie(duplicate);

    const badSignature = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        nonce: "nonce_clear_badsig_1234",
        envelopeMutation: (envelope) => {
          envelope.signature = `forged_${"A".repeat(80)}`;
        },
      }),
      transport,
    );
    expect(badSignature.status).toBe(401);
    expect(badSignature.headers.get("set-cookie")).toBeNull();

    const valid = await auth.handleAuthenticated(
      productRequest(session, privateKey, { method: "GET", nonce: "nonce_clear_valid_1234" }),
      transport,
    );
    expect(valid.status).toBe(200);
    expect(valid.headers.get("set-cookie")).toBeNull();

    setClock(now + 16 * 60 * 1_000);
    const stale = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        nonce: "nonce_clear_stale_12345",
        timestamp: new Date(now + 16 * 60 * 1_000).toISOString(),
      }),
      transport,
    );
    expect(stale.status).toBe(401);
    expectClearingCookie(stale);
    connection.close();
  });

  it("bounds authenticated bodies independently of the outer route policy", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const oversized = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        body: "x".repeat(1_048_577),
        contentType: "application/octet-stream",
        nonce: "nonce_oversized_body_1",
      }),
      transport,
    );
    expect(oversized.status).toBe(413);
    expect(dispatched).toHaveLength(0);

    const atBound = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        body: "x".repeat(1_048_576),
        contentType: "application/octet-stream",
        nonce: "nonce_at_bound_body_123",
      }),
      transport,
    );
    expect(atBound.status).toBe(200);
    expect(dispatched[0]?.bodyText).toHaveLength(1_048_576);
    connection.close();
  });

  it("cancels chunked over-limit streams early without a declared content length", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(256 * 1_024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const envelope = Buffer.from(
      JSON.stringify({
        method: "POST",
        canonicalPathQuery: "/api/chat/threads",
        bodyDigest: "a".repeat(64),
        csrfDigest: createHash("sha256").update(session.csrfToken, "utf8").digest("hex"),
        timestamp: new Date(now).toISOString(),
        nonce: "nonce_chunked_over_limit",
        signature: "unverified_after_bound",
      }),
    ).toString("base64url");
    const request = new Request(`${origin}/api/chat/threads`, {
      method: "POST",
      headers: {
        host: "mac.example.test",
        origin,
        "sec-fetch-site": "same-origin",
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}`,
        "x-octant-device-proof": envelope,
        "x-octant-csrf": session.csrfToken,
        "x-octant-command-id": commandId,
        "content-type": "application/octet-stream",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await auth.handleAuthenticated(request, transport);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("rejects over-limit streams even when upstream cancel() never settles", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const chunk = new Uint8Array(256 * 1_024).fill(120);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        // Never resolves: a hostile upstream that stalls cancellation.
        return new Promise<void>(() => undefined);
      },
    });
    const envelope = Buffer.from(
      JSON.stringify({
        method: "POST",
        canonicalPathQuery: "/api/chat/threads",
        bodyDigest: "a".repeat(64),
        csrfDigest: createHash("sha256").update(session.csrfToken, "utf8").digest("hex"),
        timestamp: new Date(now).toISOString(),
        nonce: "nonce_cancel_never_settles",
        signature: "unverified_after_bound",
      }),
    ).toString("base64url");
    const request = new Request(`${origin}/api/chat/threads`, {
      method: "POST",
      headers: {
        host: "mac.example.test",
        origin,
        "sec-fetch-site": "same-origin",
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}`,
        "x-octant-device-proof": envelope,
        "x-octant-csrf": session.csrfToken,
        "x-octant-command-id": commandId,
        "content-type": "application/octet-stream",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await auth.handleAuthenticated(request, transport);
    expect(response.status).toBe(413);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("fast-rejects declared over-limit Content-Length without reading the body", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const response = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        body: "x".repeat(64),
        contentType: "application/octet-stream",
        nonce: "nonce_declared_overlimit",
        extraHeaders: { "content-length": String(1_048_577) },
      }),
      transport,
    );
    expect(response.status).toBe(413);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("rejects non-digit and malformed Content-Length values as invalid", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    for (const declared of ["10abc", " 10", "0x10", "+10", "1.0", "-1"]) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, {
          method: "GET",
          nonce: `nonce_bad_cl_${declared.length}`,
          extraHeaders: { "content-length": declared },
        }),
        transport,
      );
      expect(response.status).toBe(400);
      expect(dispatched).toHaveLength(0);
    }
    connection.close();
  });

  it("rejects underdeclared streaming bodies that exceed the declared Content-Length", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64).fill(120));
        controller.enqueue(new Uint8Array(64).fill(121));
        controller.close();
      },
    });
    const envelope = Buffer.from(
      JSON.stringify({
        method: "POST",
        canonicalPathQuery: "/api/chat/threads",
        bodyDigest: "a".repeat(64),
        csrfDigest: createHash("sha256").update(session.csrfToken, "utf8").digest("hex"),
        timestamp: new Date(now).toISOString(),
        nonce: "nonce_underdeclared_stream",
        signature: "unverified_after_bound",
      }),
    ).toString("base64url");
    const request = new Request(`${origin}/api/chat/threads`, {
      method: "POST",
      headers: {
        host: "mac.example.test",
        origin,
        "sec-fetch-site": "same-origin",
        cookie: `${REMOTE_SESSION_COOKIE}=${session.sessionId}`,
        "x-octant-device-proof": envelope,
        "x-octant-csrf": session.csrfToken,
        "x-octant-command-id": commandId,
        "content-type": "application/octet-stream",
        "content-length": "32",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    const response = await auth.handleAuthenticated(request, transport);
    // Underdeclared body: 128 bytes sent but Content-Length says 32.
    // The bounded reader reads the actual stream; the proof digest won't match,
    // but the body is still within the 1MiB bound so it should not be 413.
    expect(response.status).not.toBe(413);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("fails closed with product authority unavailable by default", async () => {
    const { auth, privateKey, connection } = setup();
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const response = await auth.handleAuthenticated(
      productRequest(session, privateKey, { method: "GET" }),
      transport,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      product: "Octant",
      status: "rejected",
      category: "unavailable",
    });
    expect(JSON.stringify(payload)).not.toContain(session.sessionId);
    expect(JSON.stringify(payload)).not.toContain(session.csrfToken);
    connection.close();
  });

  it("applies the composed admission port before challenge, session, and product work", async () => {
    const denied = setup({ admission: () => undefined });
    const challengeDenied = await denied.auth.handlePreAuthRoute(
      jsonPost("/api/remote/auth/challenge", { hostId, deviceId, credentialGeneration: 1 }),
      challengeRoute,
      transport,
    );
    expect(challengeDenied?.status).toBe(429);
    expect(challengeDenied?.headers.get("retry-after")).toBe("60");
    expect(denied.admissionInputs[0]).toMatchObject({ bucket: "auth", deviceId, transport });
    denied.connection.close();

    const allowed = setup({ admission: () => () => undefined, withDispatch: true });
    const { session } = await issueSessionOverHttp(allowed.auth, allowed.privateKey);
    const ok = await allowed.auth.handleAuthenticated(
      productRequest(session, allowed.privateKey, { method: "GET" }),
      transport,
    );
    expect(ok.status).toBe(200);
    expect(allowed.released).toContain("product");
    expect(allowed.released).toContain("auth");
    expect(allowed.admissionInputs.at(-1)).toMatchObject({
      bucket: "product",
      deviceId,
      transport,
    });
    allowed.connection.close();
  });

  it("fails closed when transport facts are missing or unclassifiable", async () => {
    const { auth, privateKey, dispatched, connection } = setup({
      withDispatch: true,
      admission: () => () => undefined,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const invalidFacts: unknown[] = [
      undefined,
      null,
      {},
      { ...transport, listenerTrust: "loopback" },
      { ...transport, sourceClass: "unknown" },
      { ...transport, sourceClass: "dmz" },
      { ...transport, sourceKey: "" },
      { ...transport, sourceKey: "raw 10.0.0.4 address" },
    ];
    for (const [index, facts] of invalidFacts.entries()) {
      dispatched.length = 0;
      const response = await auth.handleAuthenticated(
        productRequest(session, privateKey, {
          method: "GET",
          nonce: `nonce_transport_${index}_12345`,
        }),
        facts as never,
      );
      expect(response.status).toBe(503);
      expect(dispatched).toHaveLength(0);
    }

    const preAuthDenied = await auth.handlePreAuthRoute(
      jsonPost("/api/remote/auth/challenge", { hostId, deviceId, credentialGeneration: 1 }),
      challengeRoute,
      undefined as never,
    );
    expect(preAuthDenied?.status).toBe(503);
    connection.close();
  });

  it("never upgrades a remote principal and passes freshness through unchanged", async () => {
    const { auth, privateKey, dispatched, setClock, connection } = setup({ withDispatch: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    setClock(now + 10 * 60 * 1_000);
    const keepalive = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        nonce: "nonce_keepalive_1234567",
        timestamp: new Date(now + 10 * 60 * 1_000).toISOString(),
      }),
      transport,
    );
    expect(keepalive.status).toBe(200);
    setClock(now + 16 * 60 * 1_000);
    const response = await auth.handleAuthenticated(
      productRequest(session, privateKey, {
        method: "GET",
        nonce: "nonce_rotation_due_1234",
        timestamp: new Date(now + 16 * 60 * 1_000).toISOString(),
      }),
      transport,
    );
    expect(response.status).toBe(200);
    expect(dispatched[1]?.principal.kind).toBe("remote-device");
    expect(dispatched[1]?.freshness).toBe("rotation-due");
    expect(JSON.stringify(dispatched[1]?.principal)).not.toContain("local-window");
    connection.close();
  });

  it("composes with the remote route policy for the full challenge-to-product flow", async () => {
    const { auth, privateKey, dispatched, connection } = setup({ withDispatch: true });
    const policy = createRemoteRoutePolicy({ origin });
    const route = createRemoteRouteHandler({
      policy,
      webAssets: () => undefined,
      preAuth: (request, matched) => auth.handlePreAuthRoute(request, matched, transport),
      authenticatedProduct: (request) => auth.handleAuthenticated(request, transport),
    });

    const challengeResponse = await route(
      jsonPost("/api/remote/auth/challenge", { hostId, deviceId, credentialGeneration: 1 }),
    );
    expect(challengeResponse.status).toBe(200);
    const challenge = (await challengeResponse.json()) as Record<string, string | number>;
    const sessionFacts = {
      ...negotiation,
      ...sessionExpiry(Date.parse(challenge.issuedAt as string)),
    };
    const signature = clientSign(
      privateKey,
      buildRemoteChallengeProofPayload({ challenge: challenge as never, sessionFacts }),
    );
    const sessionResponse = await route(
      jsonPost("/api/remote/auth/session", { ...challenge, signature }),
    );
    expect(sessionResponse.status).toBe(200);
    const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
    const sessionId = new RegExp(`${REMOTE_SESSION_COOKIE}=([0-9a-f-]{36})`).exec(setCookie)?.[1];
    const body = (await sessionResponse.json()) as Record<string, string>;
    const session = { sessionId: sessionId as string, csrfToken: body.csrfToken as string };

    const product = await route(productRequest(session, privateKey, { method: "GET" }));
    expect(product.status).toBe(200);
    expect(product.headers.get("strict-transport-security")).toContain("max-age=");
    expect(dispatched).toHaveLength(1);
    connection.close();
  });
});

describe("remote credential self-service routes", () => {
  it("signs out the cookie-backed session, clears the cookie, and cancels matching work", async () => {
    const { auth, privateKey, connection, registry, canceled, dispatched } = setup({
      withSelfService: true,
      withDispatch: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
    const cancel = vi.fn();
    registry?.register({ hostId, deviceId, sessionIdDigest, cancel });

    const inbound = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
    });
    const response = await auth.handleAuthenticated(inbound, transport, signOutRoute);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${REMOTE_SESSION_COOKIE}=;`);
    expect(setCookie).toContain("Max-Age=0");
    const receipt = decodeRemoteSelfServiceReceiptV1(await response.json());
    expect(receipt.result).toBe("applied");
    expect("sessionId" in receipt).toBe(false);
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(canceled).toContain(sessionIdDigest);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("self-revokes the authenticated device, clears the cookie, and cancels device work", async () => {
    const { auth, privateKey, connection, registry, canceled, dispatched } = setup({
      withSelfService: true,
      withDispatch: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
    const cancel = vi.fn();
    registry?.register({ hostId, deviceId, sessionIdDigest, cancel });

    const inbound = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
    });
    const response = await auth.handleAuthenticated(inbound, transport, revokeSelfRoute);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    const receipt = decodeRemoteSelfServiceReceiptV1(await response.json());
    expect(receipt.result).toBe("applied");
    expect(
      connection
        .prepare("SELECT state FROM remote_device_projection WHERE device_id = ?")
        .get(deviceId),
    ).toEqual({ state: "revoked" });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(canceled).toContain(sessionIdDigest);
    expect(dispatched).toHaveLength(0);
    connection.close();
  });

  it("self-rotates only after dual old/new key possession and cancels device work", async () => {
    const { auth, privateKey, connection, registry, canceled } = setup({
      withSelfService: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
    const cancel = vi.fn();
    registry?.register({ hostId, deviceId, sessionIdDigest, cancel });

    const newKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const newPublicPem = newKeys.publicKey
      .export({ format: "pem", type: "spki" })
      .toString()
      .trim();
    const newFingerprint = canonicalDeviceKeyFacts(newPublicPem)!.fingerprint;
    const newPrivatePem = newKeys.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const rotationPayload = buildRemoteKeyRotationProofPayload({
      hostId,
      deviceId,
      credentialGeneration: 1,
      newDeviceKeyFingerprint: newFingerprint,
      newDevicePublicKey: newPublicPem,
    });
    const newKeyProof = sign("sha256", Buffer.from(rotationPayload), {
      key: newPrivatePem,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");

    const forged = productRequest(session, privateKey, {
      target: "/api/remote/auth/rotate-key",
      body: JSON.stringify({
        newDeviceKeyFingerprint: newFingerprint,
        newDevicePublicKey: newPublicPem,
        newKeyProof: "forged_signature",
      }),
      nonce: "nonce_forged_1234567890",
    });
    const forgedResponse = await auth.handleAuthenticated(forged, transport, rotateKeyRoute);
    expect(forgedResponse.status).toBe(400);
    expect(cancel).not.toHaveBeenCalled();

    const inbound = productRequest(session, privateKey, {
      target: "/api/remote/auth/rotate-key",
      body: JSON.stringify({
        newDeviceKeyFingerprint: newFingerprint,
        newDevicePublicKey: newPublicPem,
        newKeyProof,
      }),
      nonce: "nonce_valid_1234567890",
    });
    const response = await auth.handleAuthenticated(inbound, transport, rotateKeyRoute);
    expect(response.status).toBe(200);
    const receipt = decodeRemoteSelfServiceReceiptV1(await response.json());
    expect(receipt.result).toBe("applied");
    expect(
      connection
        .prepare(
          "SELECT credential_generation, device_key_fingerprint FROM remote_device_projection WHERE device_id = ?",
        )
        .get(deviceId),
    ).toEqual({ credential_generation: 2, device_key_fingerprint: newFingerprint });
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(canceled).toContain(sessionIdDigest);
    connection.close();
  });

  it("rejects body-supplied device or session targets on self-service routes", async () => {
    const { auth, privateKey, connection } = setup({ withSelfService: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const targeted = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: JSON.stringify({ deviceId }),
    });
    const response = await auth.handleAuthenticated(targeted, transport, signOutRoute);
    expect(response.status).toBe(400);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(deviceId);
    connection.close();
  });

  it("requires authenticated proof for self-service routes and never reaches the credential service", async () => {
    const { auth, privateKey, connection } = setup({ withSelfService: true });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const unproven = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
      signed: false,
    });
    const response = await auth.handleAuthenticated(unproven, transport, revokeSelfRoute);
    expect(response.status).toBe(401);
    expect(
      connection
        .prepare("SELECT state FROM remote_device_projection WHERE device_id = ?")
        .get(deviceId),
    ).toEqual({ state: "active" });
    connection.close();
  });

  it("records a durable command receipt and stays idempotent across a retried command id", async () => {
    const { auth, privateKey, connection, lifecycleService, canceled } = setup({
      withSelfService: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    const inbound = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
    });
    const first = await auth.handleAuthenticated(inbound, transport, signOutRoute);
    expect(first.status).toBe(200);
    expect(decodeRemoteSelfServiceReceiptV1(await first.json()).result).toBe("applied");
    expect(canceled).toHaveLength(1);
    expect(
      connection
        .prepare("SELECT state FROM remote_session_store WHERE session_id_digest = ?")
        .get(sessionIdDigest),
    ).toEqual({ state: "revoked" });

    const retry = lifecycleService!.signOut({
      commandId,
      hostId,
      deviceId,
      sessionIdDigest,
    });
    expect(retry.result).toBe("already-applied");
    expect(canceled).toHaveLength(1);
    connection.close();
  });

  // F1: Real registry wiring — streaming response registration, cancellation,
  // and release on stream close/error/cancel.
  it("registers authenticated product requests in the registry and releases on ordinary completion", async () => {
    const { auth, privateKey, registry, connection } = setup({
      withDispatch: true,
      withRegistry: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    expect(registry!.size()).toBe(0);

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    // Consume the body to trigger stream completion.
    await response.text();
    expect(registry!.size()).toBe(0);
    connection.close();
  });

  it("releases the registry entry when the response body stream is canceled by the consumer", async () => {
    const { auth, privateKey, registry, connection } = setup({
      withRegistry: true,
      productDispatch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
            // Don't close — simulate a long-running stream.
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    expect(registry!.size()).toBe(0);

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
    expect(registry!.size()).toBe(1);

    // Consume a partial chunk.
    const reader = response.body!.getReader();
    const { value: firstChunk } = await reader.read();
    expect(firstChunk).not.toBeNull();
    expect(registry!.size()).toBe(1);

    // Cancel the stream — registry should release.
    await reader.cancel();
    // Give the microtask queue a chance to process the cancel.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry!.size()).toBe(0);
    connection.close();
  });

  it("synchronously aborts an active stream on sign-out via the registry", async () => {
    const { auth, privateKey, registry, connection, canceled } = setup({
      withSelfService: true,
      withRegistry: true,
      productDispatch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
            // Don't close — simulate a long-running stream.
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    // Dispatch a streaming product request.
    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(registry!.size()).toBe(1);

    // Read a partial chunk.
    const reader = response.body!.getReader();
    const { value: firstChunk } = await reader.read();
    expect(firstChunk).not.toBeNull();

    // Sign out — should cancel the registry entry synchronously.
    const signOutReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
      requestCommandId: "77777777-7777-4777-8777-777777777777",
      nonce: "nonce_signout_1234567890",
    });
    const signOutResponse = await auth.handleAuthenticated(signOutReq, transport, signOutRoute);
    expect(signOutResponse.status).toBe(200);
    expect(canceled).toContain(sessionIdDigest);
    expect(registry!.size()).toBe(0);

    // The original stream should be aborted (next read should error or return done).
    await expect(reader.read()).rejects.toThrow();
    connection.close();
  });

  it("synchronously aborts an active stream on self-revoke via the registry", async () => {
    const { auth, privateKey, registry, connection, canceled } = setup({
      withSelfService: true,
      withRegistry: true,
      productDispatch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data\n"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(registry!.size()).toBe(1);

    const reader = response.body!.getReader();
    await reader.read();

    const revokeReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
      requestCommandId: "88888888-8888-4888-8888-888888888888",
      nonce: "nonce_revoke_1234567890",
    });
    const revokeResponse = await auth.handleAuthenticated(revokeReq, transport, revokeSelfRoute);
    expect(revokeResponse.status).toBe(200);
    expect(registry!.size()).toBe(0);
    expect(canceled.length).toBeGreaterThanOrEqual(1);
    connection.close();
  });

  // F2: Verify-vs-revoke TOCTOU — revalidation before dispatch.
  it("rejects a request whose session was revoked between proof verification and dispatch (TOCTOU)", async () => {
    const { auth, privateKey, connection, service } = setup({
      withDispatch: true,
      withRegistry: true,
      withRevalidation: true,
      productDispatch: async () => {
        throw new Error("dispatch should not be reached");
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    // Revoke the session directly in the database after issue but before dispatch.
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
    connection
      .prepare("UPDATE remote_session_store SET state = 'revoked' WHERE session_id_digest = ?")
      .run(sessionIdDigest);

    // The proof is still valid (it was issued), but revalidation should catch
    // the revoked session before dispatch.
    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(401);
    connection.close();
  });

  it("rejects a request whose session was revoked between proof verification and self-service dispatch", async () => {
    const { auth, privateKey, connection } = setup({
      withSelfService: true,
      withRegistry: true,
      withRevalidation: true,
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    // Revoke the session directly after issue but before the self-service call.
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");
    connection
      .prepare("UPDATE remote_session_store SET state = 'revoked' WHERE session_id_digest = ?")
      .run(sessionIdDigest);

    const inbound = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
      requestCommandId: "99999999-9999-4999-9999-999999999999",
      nonce: "nonce_toctou_ss_1234567890",
    });
    const response = await auth.handleAuthenticated(inbound, transport, signOutRoute);
    expect(response.status).toBe(401);
    connection.close();
  });

  it("releases the registry entry on stream error", async () => {
    const { auth, privateKey, registry, connection } = setup({
      withRegistry: true,
      productDispatch: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("stream error"));
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(registry!.size()).toBe(1);

    // Reading the errored stream should throw.
    await expect(response.text()).rejects.toThrow();
    // Give the microtask queue a chance to process.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(registry!.size()).toBe(0);
    connection.close();
  });

  // S1: Combined abort signal reaches product dispatch — revoke during
  // in-flight dispatch before Response creation cancels the handler.
  it("aborts the product dispatch handler synchronously when revoke fires during dispatch (barrier-driven)", async () => {
    let dispatchAbortSignal: AbortSignal | undefined;
    let effectOccurred = false;
    const dispatchEntered = createBarrier();
    const dispatchBlocked = createBarrier();
    const { auth, privateKey, registry, connection, canceled } = setup({
      withSelfService: true,
      productDispatch: async (handoff) => {
        dispatchAbortSignal = handoff.abortSignal;
        dispatchEntered.open();
        // Block before any effect — simulate waiting for upstream work.
        await dispatchBlocked.wait();
        // If the signal aborted while blocked, we must not proceed to effect.
        if (handoff.abortSignal?.aborted) {
          throw new Error("dispatch aborted before effect");
        }
        effectOccurred = true;
        return new Response("ok", { status: 200 });
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    // Start the product dispatch — it will block before the effect.
    const dispatchPromise = auth.handleAuthenticated(
      productRequest(session, privateKey, { nonce: "nonce_s1_dispatch_001" }),
      transport,
    );
    await dispatchEntered.wait();
    expect(registry!.size()).toBe(1);

    // Revoke the session via self-revoke — this cancels the registry entry.
    const revokeReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
      requestCommandId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nonce: "nonce_s1_revoke_001",
    });
    const revokeResponse = await auth.handleAuthenticated(revokeReq, transport, revokeSelfRoute);
    expect(revokeResponse.status).toBe(200);
    expect(canceled.length).toBeGreaterThanOrEqual(1);
    expect(registry!.size()).toBe(0);

    // The dispatch abort signal must be aborted synchronously.
    expect(dispatchAbortSignal?.aborted).toBe(true);

    // Release the dispatch barrier — the handler should see the abort and
    // NOT proceed to the effect.
    dispatchBlocked.open();
    const response = await dispatchPromise;
    expect(effectOccurred).toBe(false);
    connection.close();
  });

  // S1: Revoke between registration and revalidation — the request must not
  // escape cancellation even if the revoke happens in the TOCTOU window.
  it("rejects a request whose session was revoked between registration and revalidation (barrier-driven)", async () => {
    const { auth, privateKey, connection, registry } = setup({
      withSelfService: true,
      withRevalidation: true,
      productDispatch: async () => {
        throw new Error("dispatch should not be reached");
      },
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    // Revoke the session directly in the database.
    connection
      .prepare("UPDATE remote_session_store SET state = 'revoked' WHERE session_id_digest = ?")
      .run(sessionIdDigest);

    // The proof is still valid, but revalidation should catch the revoked
    // session before dispatch. The registry entry (if registered) must be
    // released.
    const inbound = productRequest(session, privateKey, { nonce: "nonce_s1_toctou_001" });
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(401);
    expect(registry!.size()).toBe(0);
    connection.close();
  });

  // S1: Construction fails closed when productDispatch is configured without
  // the required registry or revalidation.
  it("fails construction when productDispatch is configured without a request registry", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-http-auth-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => new Date(now).toISOString());
    const service = new RemoteRequestProofService(connection, {
      now: () => now,
      resolveNegotiation: () => negotiation,
    });
    expect(() =>
      createRemoteHttpAuthentication({
        proofService: service,
        signNegotiationMetadata: () => "sig",
        productDispatch: async () => new Response("ok"),
        sessionRevalidation: { isSessionActive: () => true },
      }),
    ).toThrow(/request registry/);
    connection.close();
  });

  it("fails construction when productDispatch is configured without session revalidation", () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-http-auth-"));
    directories.push(directory);
    const connection = openSqlite(join(directory, "store.sqlite3"));
    applyMigrations(connection, MIGRATIONS, () => new Date(now).toISOString());
    const service = new RemoteRequestProofService(connection, {
      now: () => now,
      resolveNegotiation: () => negotiation,
    });
    expect(() =>
      createRemoteHttpAuthentication({
        proofService: service,
        signNegotiationMetadata: () => "sig",
        productDispatch: async () => new Response("ok"),
        requestRegistry: createRemoteRequestRegistry(),
      }),
    ).toThrow(/session revalidation/);
    connection.close();
  });

  // S3: HTTP discards truthful failure — when cancellation fails, the
  // response must not imply success.
  it("returns 503 when a cancellation hook fails during self-revoke (defense-in-depth)", async () => {
    const { auth, privateKey, connection, registry } = setup({
      withSelfService: true,
      productDispatch: async () => new Response("ok"),
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);

    // Register a product request with a THROWING cancel hook so the
    // defense-in-depth cancelByDevice will fail.
    const throwingCancel = vi.fn(() => {
      throw new Error("cancel boom");
    });
    registry!.register({
      hostId,
      deviceId,
      sessionIdDigest: createHash("sha256").update(session.sessionId, "utf8").digest("hex"),
      cancel: throwingCancel,
    });

    const revokeReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
      requestCommandId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      nonce: "nonce_s3_revoke_001",
    });
    const response = await auth.handleAuthenticated(revokeReq, transport, revokeSelfRoute);
    expect(response.status).toBe(503);
    // The cookie must be cleared because the durable action invalidated the session.
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    // Raw identity must be absent.
    const payload = (await response.json()) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain(session.sessionId);
    connection.close();
  });

  // S3: Retry succeeds and becomes the truthful already-applied response.
  // This tests the lifecycle service retry path directly since the HTTP layer
  // cannot re-authenticate after the session is revoked.
  it("returns 503 on first failed cancellation, then lifecycle retry succeeds with already-applied and zero failures", async () => {
    let cancelShouldFail = true;
    const { auth, privateKey, connection, registry, lifecycleService } = setup({
      withSelfService: true,
      productDispatch: async () => new Response("ok"),
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    // Register with a hook that fails the first time, succeeds the second.
    const flakyCancel = vi.fn(() => {
      if (cancelShouldFail) throw new Error("transient");
    });
    registry!.register({
      hostId,
      deviceId,
      sessionIdDigest,
      cancel: flakyCancel,
    });

    // First revoke — should get 503 because cancellation failed.
    const revokeReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/revoke-self",
      body: "{}",
      requestCommandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      nonce: "nonce_s3_retry_001",
    });
    const firstResponse = await auth.handleAuthenticated(revokeReq, transport, revokeSelfRoute);
    expect(firstResponse.status).toBe(503);
    // S2: The failed entry is retained for retry.
    expect(registry!.size()).toBe(1);

    // Now let the cancel hook succeed.
    cancelShouldFail = false;

    // Retry directly via the lifecycle service (the HTTP layer can't
    // re-authenticate after device revocation).
    const retry = lifecycleService!.selfRevokeDevice({
      commandId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      hostId,
      deviceId,
    });
    expect(retry.result).toBe("already-applied");
    expect(retry.cancellation).toEqual({ canceled: 1, cancelHookFailures: 0 });
    // S2: The retained entry is now drained.
    expect(registry!.size()).toBe(0);
    connection.close();
  });

  // S3: Rotate clears the cookie.
  it("clears the session cookie on successful rotate", async () => {
    const { auth, privateKey, connection } = setup({
      withSelfService: true,
      productDispatch: async () => new Response("ok"),
    });
    const { session } = await issueSessionOverHttp(auth, privateKey);
    const { newPrivateKeyPem, newPublicKeyPem, newFingerprint } = generateNewKey();
    const newKeyProof = sign(
      "sha256",
      Buffer.from(
        buildRemoteKeyRotationProofPayload({
          hostId,
          deviceId,
          credentialGeneration: 1,
          newDeviceKeyFingerprint: newFingerprint,
          newDevicePublicKey: newPublicKeyPem,
        }),
        "utf8",
      ),
      { key: newPrivateKeyPem, dsaEncoding: "ieee-p1363" },
    );
    const rotateReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/rotate-key",
      body: JSON.stringify({
        newDeviceKeyFingerprint: newFingerprint,
        newDevicePublicKey: newPublicKeyPem,
        newKeyProof: newKeyProof.toString("base64url"),
      }),
      requestCommandId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      nonce: "nonce_s3_rotate_001",
    });
    const response = await auth.handleAuthenticated(rotateReq, transport, rotateKeyRoute);
    expect(response.status).toBe(200);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Max-Age=0");
    connection.close();
  });

  // R3: B4 exact-once release — instrument the registry release callback to
  // assert release invocation count is exactly 1 under consumer-cancel
  // rejection. Uses microtask flushing, not timers.
  it("releases exactly once when consumer cancels and source.cancel() rejects", async () => {
    const { privateKey, connection, service } = setup({
      withRegistry: true,
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
          cancel() {
            throw new Error("upstream cancel rejected");
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    // R3: Create an instrumented registry that counts release calls.
    const baseRegistry = createRemoteRequestRegistry();
    let releaseCount = 0;
    const instrumentedRegistry: RemoteRequestRegistry = {
      register: (input) => {
        const release = baseRegistry.register(input);
        return () => {
          releaseCount++;
          release();
        };
      },
      cancelBySession: (digest) => baseRegistry.cancelBySession(digest),
      cancelByDevice: (input) => baseRegistry.cancelByDevice(input),
      cancelAll: () => baseRegistry.cancelAll(),
      size: () => baseRegistry.size(),
      diagnostics: () => baseRegistry.diagnostics(),
    };
    const auth = createRemoteHttpAuthentication({
      proofService: service,
      signNegotiationMetadata: (payload) =>
        createHash("sha256").update(payload, "utf8").digest("hex"),
      requestRegistry: instrumentedRegistry,
      sessionRevalidation: {
        isSessionActive: (sessionId: string) => service.describeSession(sessionId) !== undefined,
      },
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
          cancel() {
            throw new Error("upstream cancel rejected");
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });

    const { session } = await issueSessionOverHttp(auth, privateKey);
    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(instrumentedRegistry.size()).toBe(1);

    const reader = response.body!.getReader();
    await reader.read();

    // Cancel the stream — source.cancel() will reject, but the wrapper
    // must still release exactly once.
    await reader.cancel();
    // R3: Flush microtasks without timers.
    await Promise.resolve().then(() => {});
    await Promise.resolve().then(() => {});
    // R3: Assert release was called exactly once.
    expect(releaseCount).toBe(1);
    expect(instrumentedRegistry.size()).toBe(0);
    connection.close();
  });

  // R3: B4 exact-once release — the abort signal is the authoritative
  // cancellation. When it fires, the wrapper releases exactly once and
  // errors the stream, even if source.cancel() never settles.
  it("releases exactly once on registry abort even when source.cancel() never settles", async () => {
    const { privateKey, connection, service } = setup({
      withSelfService: true,
      withRegistry: true,
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
          cancel() {
            return new Promise(() => {});
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    // R3: Create an instrumented registry that counts release calls for
    // the product request only (not the sign-out request, which is a
    // separate registration released immediately as non-streaming).
    const baseRegistry = createRemoteRequestRegistry();
    let productReleaseCount = 0;
    let productRegistered = false;
    const instrumentedRegistry: RemoteRequestRegistry = {
      register: (input) => {
        const isProduct = !productRegistered;
        if (isProduct) productRegistered = true;
        const release = baseRegistry.register(input);
        if (!isProduct) return release;
        return () => {
          productReleaseCount++;
          release();
        };
      },
      cancelBySession: (digest) => baseRegistry.cancelBySession(digest),
      cancelByDevice: (input) => baseRegistry.cancelByDevice(input),
      cancelAll: () => baseRegistry.cancelAll(),
      size: () => baseRegistry.size(),
      diagnostics: () => baseRegistry.diagnostics(),
    };
    // R3: Create a lifecycle service wired to the same instrumented registry.
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => new Date(now).toISOString(),
    });
    let lifecycleUuidCounter = 0;
    const canceled: string[] = [];
    const lifecycleService = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId: "44444444-4444-4444-8444-444444444444",
      uuid: () =>
        `44444444-4444-4444-8444-${(lifecycleUuidCounter++).toString(16).padStart(12, "0")}`,
      clock: () => new Date(now).toISOString(),
      onSessionsInvalidated: (input) => {
        let canceledCount = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = instrumentedRegistry.cancelByDevice({
            hostId: input.hostId,
            deviceId: id,
          });
          canceledCount += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        canceled.push(...input.sessionIdDigests);
        return { canceled: canceledCount, cancelHookFailures };
      },
    });
    const auth = createRemoteHttpAuthentication({
      proofService: service,
      signNegotiationMetadata: (payload) =>
        createHash("sha256").update(payload, "utf8").digest("hex"),
      credentialSelfService: asCredentialSelfService(lifecycleService),
      requestRegistry: instrumentedRegistry,
      sessionRevalidation: {
        isSessionActive: (sessionId: string) => service.describeSession(sessionId) !== undefined,
      },
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
          cancel() {
            return new Promise(() => {});
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });

    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(instrumentedRegistry.size()).toBe(1);

    const reader = response.body!.getReader();
    await reader.read();

    // Sign out — fires the registry abort signal. The wrapper must release
    // exactly once even though source.cancel() never settles.
    const signOutReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
      requestCommandId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      nonce: "nonce_b4_abort_001",
    });
    const signOutResponse = await auth.handleAuthenticated(signOutReq, transport, signOutRoute);
    expect(signOutResponse.status).toBe(200);
    expect(canceled).toContain(sessionIdDigest);
    // R3: Flush microtasks without timers.
    await Promise.resolve().then(() => {});
    await Promise.resolve().then(() => {});
    // R3: Assert product request release was called exactly once.
    expect(productReleaseCount).toBe(1);
    expect(instrumentedRegistry.size()).toBe(0);

    // The stream should be errored (abort signal is authoritative).
    await expect(reader.read()).rejects.toThrow();
    // R3: Release count must still be 1 after the stream error read.
    expect(productReleaseCount).toBe(1);
    connection.close();
  });

  // R3: B4 exact-once release — the registry entry is released exactly once
  // even if both the consumer cancel and the abort signal fire. Uses
  // microtask flushing, not timers.
  it("releases exactly once when both consumer cancel and abort signal fire", async () => {
    const { privateKey, connection, service } = setup({
      withSelfService: true,
      withRegistry: true,
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    // R3: Create an instrumented registry that counts release calls for
    // the product request only.
    const baseRegistry = createRemoteRequestRegistry();
    let productReleaseCount = 0;
    let productRegistered = false;
    const instrumentedRegistry: RemoteRequestRegistry = {
      register: (input) => {
        const isProduct = !productRegistered;
        if (isProduct) productRegistered = true;
        const release = baseRegistry.register(input);
        if (!isProduct) return release;
        return () => {
          productReleaseCount++;
          release();
        };
      },
      cancelBySession: (digest) => baseRegistry.cancelBySession(digest),
      cancelByDevice: (input) => baseRegistry.cancelByDevice(input),
      cancelAll: () => baseRegistry.cancelAll(),
      size: () => baseRegistry.size(),
      diagnostics: () => baseRegistry.diagnostics(),
    };
    // R3: Create a lifecycle service wired to the same instrumented registry.
    const runtime = createPhase1RuntimeRegistries();
    const journal = new Journal({
      connection,
      registry: runtime.events,
      projections: runtime.projections,
      clock: () => new Date(now).toISOString(),
    });
    let lifecycleUuidCounter = 0;
    const canceled: string[] = [];
    const lifecycleService = new RemoteCredentialLifecycleService({
      connection,
      journal,
      actorId: "44444444-4444-4444-8444-444444444444",
      uuid: () =>
        `44444444-4444-4444-8444-${(lifecycleUuidCounter++).toString(16).padStart(12, "0")}`,
      clock: () => new Date(now).toISOString(),
      onSessionsInvalidated: (input) => {
        let canceledCount = 0;
        let cancelHookFailures = 0;
        for (const id of input.deviceIds) {
          const result = instrumentedRegistry.cancelByDevice({
            hostId: input.hostId,
            deviceId: id,
          });
          canceledCount += result.canceled;
          cancelHookFailures += result.cancelHookFailures;
        }
        canceled.push(...input.sessionIdDigests);
        return { canceled: canceledCount, cancelHookFailures };
      },
    });
    const auth = createRemoteHttpAuthentication({
      proofService: service,
      signNegotiationMetadata: (payload) =>
        createHash("sha256").update(payload, "utf8").digest("hex"),
      credentialSelfService: asCredentialSelfService(lifecycleService),
      requestRegistry: instrumentedRegistry,
      sessionRevalidation: {
        isSessionActive: (sessionId: string) => service.describeSession(sessionId) !== undefined,
      },
      productDispatch: async () => {
        const realBody = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("chunk1\n"));
          },
        });
        return new Response(realBody, { status: 200, headers: { "content-type": "text/plain" } });
      },
    });

    const { session } = await issueSessionOverHttp(auth, privateKey);
    const sessionIdDigest = createHash("sha256").update(session.sessionId, "utf8").digest("hex");

    const inbound = productRequest(session, privateKey, {});
    const response = await auth.handleAuthenticated(inbound, transport);
    expect(response.status).toBe(200);
    expect(instrumentedRegistry.size()).toBe(1);

    const reader = response.body!.getReader();
    await reader.read();

    // Fire both consumer cancel and registry abort (via sign-out) near-
    // simultaneously.
    const cancelPromise = reader.cancel();
    const signOutReq = productRequest(session, privateKey, {
      target: "/api/remote/auth/sign-out",
      body: "{}",
      requestCommandId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      nonce: "nonce_b4_both_001",
    });
    const signOutResponse = await auth.handleAuthenticated(signOutReq, transport, signOutRoute);
    expect(signOutResponse.status).toBe(200);
    expect(canceled).toContain(sessionIdDigest);

    await cancelPromise;
    // R3: Flush microtasks without timers.
    await Promise.resolve().then(() => {});
    await Promise.resolve().then(() => {});

    // R3: Assert product request release was called exactly once.
    expect(productReleaseCount).toBe(1);
    expect(instrumentedRegistry.size()).toBe(0);
    connection.close();
  });
});

// S1/S5: Barrier primitive for event-driven tests (no timer sleeps).
function createBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return {
    open: resolve,
    wait: () => promise,
  };
}

// S3: Helper to generate a new device key for rotation tests.
function generateNewKey(): {
  readonly newPrivateKeyPem: string;
  readonly newPublicKeyPem: string;
  readonly newFingerprint: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const newPublicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const newPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const facts = canonicalDeviceKeyFacts(newPublicKeyPem)!;
  return {
    newPrivateKeyPem,
    newPublicKeyPem,
    newFingerprint: facts.fingerprint,
  };
}
