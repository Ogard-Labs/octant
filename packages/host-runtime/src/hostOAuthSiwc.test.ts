import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import {
  createHostOAuthRuntime,
  handleHostOAuthBrokerRoute,
  type HostOAuthDescriptor,
} from "./hostOAuth";

const HOST_ID = "urn:uuid:11111111-2222-4333-8444-555555555555";
const ISSUED_CLIENT_ID = "oaiapp_test-client-123";
const ACCESS = "siwc-access-token-must-not-leak";
const REFRESH = "siwc-refresh-token-must-not-leak";
const SUBJECT = "user-subject-123";
const EMAIL = "person@example.com";

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
    list: async () => [...values.keys()],
  };
}

/** A store that can resolve a named ref but cannot enumerate, like Keychain. */
function unlistableStore(
  values: Map<string, string> = new Map(),
): CredentialStore & { readonly values: Map<string, string> } {
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => void values.delete(id),
  };
}

function chatGptPlanDescriptor(authorize: string, token: string): HostOAuthDescriptor {
  return {
    descriptorId: "chatgpt-plan",
    dialect: "chatgpt-plan-siwc",
    flow: "authorization-code-pkce",
    authorizationEndpoint: authorize,
    tokenEndpoint: token,
    scopes: [
      "openid",
      "profile",
      "email",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
    termsId: "chatgpt-plan-terms-1",
    extAgentHostId: HOST_ID,
    agentNameHint: "Octant",
  };
}

interface RsaKeyPair {
  readonly publicKeyJwk: { readonly kty: "RSA"; readonly n: string; readonly e: string };
  readonly sign: (payload: string) => string;
}

function rsaKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const jwk = createPublicKey(publicKey).export({ format: "jwk" }) as {
    kty: "RSA";
    n: string;
    e: string;
  };
  return {
    publicKeyJwk: { kty: "RSA", n: jwk.n, e: jwk.e },
    sign: (payload: string) =>
      cryptoSign("RSA-SHA256", Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
  };
}

function idToken(keyPair: RsaKeyPair, claims: Record<string, unknown>, kid = "test-key"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = keyPair.sign(`${header}.${payload}`);
  return `${header}.${payload}.${signature}`;
}

interface FakeSiwcServer {
  readonly url: string;
  readonly tokenHits: () => number;
  readonly lastExchange: () => Record<string, string> | undefined;
  readonly lastRefresh: () => Record<string, string> | undefined;
  readonly revokeHits: () => number;
  readonly lastRevocation: () => Record<string, string> | undefined;
  readonly close: () => Promise<void>;
}

async function startFakeSiwcServer(options?: {
  readonly keyPair?: RsaKeyPair;
  readonly scope?: string;
  readonly refresh?: { readonly status: number; readonly error?: string };
  readonly omitIdToken?: boolean;
  readonly issuer?: string;
  /**
   * When set, a successful refresh response includes an identity token.
   * `authorize-nonce` reuses the nonce from the authorize request.
   * `wrong-subject` does the same but names a different subject.
   */
  readonly refreshIdToken?: "authorize-nonce" | "wrong-subject";
}): Promise<FakeSiwcServer> {
  const keyPair = options?.keyPair ?? rsaKeyPair();
  let issuer = options?.issuer ?? "";
  let tokenHits = 0;
  let revokeHits = 0;
  let lastExchange: Record<string, string> | undefined;
  let lastRefresh: Record<string, string> | undefined;
  let lastRevocation: Record<string, string> | undefined;
  const challenges = new Map<string, string>();
  const nonces = new Map<string, string>();
  let authorizeNonce: string | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      const nonce = url.searchParams.get("nonce");
      if (redirect === null || state === null || challenge === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      challenges.set(state, challenge);
      if (nonce !== null) {
        nonces.set(state, nonce);
        authorizeNonce = nonce;
      }
      const callback = new URL(redirect);
      callback.searchParams.set("code", "siwc-auth-code");
      callback.searchParams.set("state", state);
      callback.searchParams.set("client_id", ISSUED_CLIENT_ID);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ keys: [{ ...keyPair.publicKeyJwk, kid: "test-key", alg: "RS256" }] }),
      );
      return;
    }
    if (request.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          issuer,
          revocation_endpoint: `${baseUrl(server)}/revoke`,
        }),
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/revoke") {
      revokeHits += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on("end", () => {
        lastRevocation = Object.fromEntries(
          new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
        );
        response.writeHead(200);
        response.end();
      });
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/token") {
      response.writeHead(404);
      response.end();
      return;
    }
    tokenHits += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      const grant = form.grant_type;
      if (grant === "refresh_token") {
        lastRefresh = form;
        const refresh = options?.refresh;
        if (refresh !== undefined) {
          response.writeHead(refresh.status, { "content-type": "application/json" });
          response.end(JSON.stringify(refresh.error === undefined ? {} : { error: refresh.error }));
          return;
        }
        const refreshKind = options?.refreshIdToken;
        const token =
          refreshKind === undefined
            ? undefined
            : idToken(keyPair, {
                iss: issuer,
                aud: ISSUED_CLIENT_ID,
                sub: refreshKind === "wrong-subject" ? "other-subject" : SUBJECT,
                email: EMAIL,
                exp: Math.floor(Date.now() / 1000) + 3600,
                nonce: authorizeNonce ?? "missing-authorize-nonce",
              });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "rotated-access-token",
            refresh_token: "rotated-refresh-token",
            token_type: "Bearer",
            expires_in: 30,
            scope:
              options?.scope ??
              "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            ...(token === undefined ? {} : { id_token: token }),
          }),
        );
        return;
      }
      lastExchange = form;
      const verifier = form.code_verifier ?? "";
      const state = [...challenges.entries()].find(
        ([, challenge]) => challenge === createHash("sha256").update(verifier).digest("base64url"),
      );
      if (state === undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      const nonce = nonces.get(state[0]) ?? randomUUID();
      const token =
        options?.omitIdToken === true
          ? undefined
          : idToken(keyPair, {
              iss: issuer,
              aud: ISSUED_CLIENT_ID,
              sub: SUBJECT,
              email: EMAIL,
              exp: Math.floor(Date.now() / 1000) + 3600,
              nonce,
            });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: ACCESS,
          refresh_token: REFRESH,
          token_type: "Bearer",
          expires_in: 30,
          scope:
            options?.scope ??
            "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
          ...(token === undefined ? {} : { id_token: token }),
        }),
      );
    });
  });
  await listen(server);
  if (issuer === "") issuer = baseUrl(server);
  return {
    url: baseUrl(server),
    tokenHits: () => tokenHits,
    lastExchange: () => lastExchange,
    lastRefresh: () => lastRefresh,
    revokeHits: () => revokeHits,
    lastRevocation: () => lastRevocation,
    close: () => closeServer(server),
  };
}

function baseUrl(server: Server): string {
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function waitForState(
  read: () => { readonly kind: string; readonly reason?: string },
  kind: string,
): Promise<{ readonly kind: string; readonly reason?: string }> {
  const deadline = Date.now() + 2_000;
  let latest = read();
  while (latest.kind !== kind && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = read();
  }
  return latest;
}

async function completeSignIn(
  runtime: ReturnType<typeof createHostOAuthRuntime>,
  fake: FakeSiwcServer,
): Promise<string> {
  const started = await runtime.begin({
    descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
  });
  if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
    throw new Error("expected a PKCE attempt");
  }
  await fetch(started.authorizationUrl);
  const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
  if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
  const status = runtime.status(started.attemptId);
  if (status.kind !== "signed-in") throw new Error("missing credential ref");
  return status.credentialRef;
}

async function callbackWithoutFollowing(authorizationUrl: string): Promise<URL> {
  const redirected = await fetch(authorizationUrl, { redirect: "manual" });
  const location = redirected.headers.get("location");
  if (location === null) throw new Error("expected a callback redirect");
  return new URL(location);
}

describe("ChatGPT plan (SIWC) dialect", () => {
  // The fake issuer stands in for https://auth.openai.com: the runtime is
  // pointed at it via siwcIssuer so JWKS validation and revocation discovery
  // hit the fake, while the descriptor's authorize/token endpoints are the
  // fake's own URLs.
  function runtimeFor(
    store: CredentialStore & { readonly values: Map<string, string> },
    fake: FakeSiwcServer,
  ) {
    return createHostOAuthRuntime({ store, timeoutMs: 2_000, siwcIssuer: fake.url });
  }

  it("builds a first sign-in authorize URL with the dynamic client, host id, nonce, and resource", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      expect(started.kind).toBe("awaiting-consent");
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(started.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(authorization.searchParams.get("agent_name_hint")).toBe("Octant");
      expect(authorization.searchParams.get("ext_agent_host_id")).toBe(HOST_ID);
      expect(authorization.searchParams.get("resource")).toBe("https://api.openai.com/v1");
      expect(authorization.searchParams.get("nonce")).not.toBeNull();
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(authorization.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");
      expect(authorization.searchParams.get("id_token_hint")).toBeNull();
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("runs the loopback flow end to end and stores the issued client id, identity, and plan flag", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      // The exchange used the issued client id from the callback, never the
      // dynamic_agent_client placeholder, and sent the resource.
      expect(fake.lastExchange()).toMatchObject({
        grant_type: "authorization_code",
        client_id: ISSUED_CLIENT_ID,
        resource: "https://api.openai.com/v1",
      });
      expect(fake.lastExchange()?.client_id).not.toBe("dynamic_agent_client");
      const stored = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(stored.clientId).toBe(ISSUED_CLIENT_ID);
      expect(stored.dialect).toBe("chatgpt-plan-siwc");
      expect(stored.extAgentHostId).toBe(HOST_ID);
      expect(stored.subject).toBe(SUBJECT);
      expect(stored.email).toBe(EMAIL);
      expect(stored.planUsageEnabled).toBe(true);
      expect(stored.idToken).toBeDefined();
      // The public sign-in state never carries token material.
      const published = JSON.stringify(runtime.status(started.attemptId));
      expect(published).not.toContain(ACCESS);
      expect(published).not.toContain(REFRESH);
      const access = await runtime.access(status.credentialRef);
      expect(access).toMatchObject({
        kind: "granted",
        accessToken: ACCESS,
        planUsageEnabled: true,
      });
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("marks plan usage disabled when the granted scopes omit the plan scope but keeps the sign-in", async () => {
    const fake = await startFakeSiwcServer({ scope: "openid profile email" });
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const stored = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(stored.planUsageEnabled).toBe(false);
      const access = await runtime.access(status.credentialRef);
      expect(access).toMatchObject({ kind: "granted", planUsageEnabled: false });
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses the exchange when the callback omits the issued client id", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const redirect = new URL(
        new URL(started.authorizationUrl).searchParams.get("redirect_uri") ?? "",
      );
      redirect.searchParams.set("code", "siwc-auth-code");
      redirect.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      );
      await fetch(redirect);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "exchange-refused" });
      expect(fake.tokenHits()).toBe(0);
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses the exchange when the identity token fails validation", async () => {
    // The fake signs identity tokens with otherKeys but serves a JWKS for
    // goodKeys: the signature check must fail and the grant must not be
    // stored.
    const goodKeys = rsaKeyPair();
    const otherKeys = rsaKeyPair();
    const fake = await startFakeSiwcServer({ keyPair: otherKeys });
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({
      store,
      timeoutMs: 2_000,
      siwcIssuer: fake.url,
      fetch: async (input, init) => {
        const url = String(input);
        if (url === `${fake.url}/.well-known/jwks.json`) {
          return new Response(
            JSON.stringify({
              keys: [{ ...goodKeys.publicKeyJwk, kid: "test-key", alg: "RS256" }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return fetch(input, init);
      },
    });
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "exchange-refused" });
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("reauthorizes from the named credential when the store cannot list grants", async () => {
    const fake = await startFakeSiwcServer();
    const listed = memoryStore();
    const firstRuntime = runtimeFor(listed, fake);
    let credentialRef = "";
    let idToken = "";
    try {
      const first = await firstRuntime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (first.kind !== "awaiting-consent" || first.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(first.authorizationUrl);
      const done = await waitForState(() => firstRuntime.status(first.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = firstRuntime.status(first.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      credentialRef = status.credentialRef;
      const stored = JSON.parse(listed.values.get(credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      if (typeof stored.idToken !== "string") throw new Error("missing identity token");
      idToken = stored.idToken;
    } finally {
      await firstRuntime.close();
    }
    const runtime = runtimeFor(unlistableStore(listed.values), fake);
    try {
      const second = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
        credentialRef,
      });
      if (second.kind !== "awaiting-consent" || second.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(second.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe(ISSUED_CLIENT_ID);
      expect(authorization.searchParams.get("agent_name_hint")).toBeNull();
      expect(authorization.searchParams.get("id_token_hint")).toBe(idToken);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("starts a first sign-in when no credential is named, even if a grant is stored and the store cannot list", async () => {
    const fake = await startFakeSiwcServer();
    const listed = memoryStore();
    const firstRuntime = runtimeFor(listed, fake);
    try {
      const first = await firstRuntime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (first.kind !== "awaiting-consent" || first.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(first.authorizationUrl);
      const done = await waitForState(() => firstRuntime.status(first.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
    } finally {
      await firstRuntime.close();
    }
    const runtime = runtimeFor(unlistableStore(listed.values), fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(started.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
      expect(authorization.searchParams.get("agent_name_hint")).toBe("Octant");
      expect(authorization.searchParams.get("id_token_hint")).toBeNull();
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("uses a named credential ref from the begin route instead of listing the store", async () => {
    const fake = await startFakeSiwcServer();
    const listed = memoryStore();
    const firstRuntime = runtimeFor(listed, fake);
    let credentialRef = "";
    try {
      credentialRef = await completeSignIn(firstRuntime, fake);
    } finally {
      await firstRuntime.close();
    }
    const runtime = runtimeFor(unlistableStore(listed.values), fake);
    try {
      const response = await handleHostOAuthBrokerRoute(
        "/v1/oauth/begin",
        new Request("http://127.0.0.1/v1/oauth/begin", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            actorId: randomUUID(),
            termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
            credentialRef,
            descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
          }),
        }),
        runtime,
      );
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("authorizationUrl" in body) ||
        typeof body.authorizationUrl !== "string"
      ) {
        throw new Error("expected an authorize URL");
      }
      const authorization = new URL(body.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe(ISSUED_CLIENT_ID);
      expect(authorization.searchParams.get("agent_name_hint")).toBeNull();
      expect(authorization.searchParams.get("id_token_hint")).not.toBeNull();
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("reuses the issued client id and omits the agent name hint on reauthorization", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      // First sign-in stores the grant.
      const first = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (first.kind !== "awaiting-consent" || first.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(first.authorizationUrl);
      const done = await waitForState(() => runtime.status(first.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      const signedIn = runtime.status(first.attemptId);
      if (signedIn.kind !== "signed-in") throw new Error("missing credential ref");
      // Second begin names the stored grant and reauthorizes with the issued
      // client id, no agent name hint, and an id_token_hint.
      const second = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
        credentialRef: signedIn.credentialRef,
      });
      if (second.kind !== "awaiting-consent" || second.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(second.authorizationUrl);
      expect(authorization.searchParams.get("client_id")).toBe(ISSUED_CLIENT_ID);
      expect(authorization.searchParams.get("agent_name_hint")).toBeNull();
      expect(authorization.searchParams.get("id_token_hint")).not.toBeNull();
      expect(authorization.searchParams.get("ext_agent_host_id")).toBe(HOST_ID);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("keeps the issued client id when a reauthorization callback omits client_id", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const credentialRef = await completeSignIn(runtime, fake);
      const second = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
        credentialRef,
      });
      if (second.kind !== "awaiting-consent" || second.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const callback = await callbackWithoutFollowing(second.authorizationUrl);
      callback.searchParams.delete("client_id");
      const hitsBefore = fake.tokenHits();
      await fetch(callback);
      const done = await waitForState(() => runtime.status(second.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      expect(fake.tokenHits()).toBe(hitsBefore + 1);
      expect(fake.lastExchange()?.client_id).toBe(ISSUED_CLIENT_ID);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses a reauthorization callback that returns a different client id", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const credentialRef = await completeSignIn(runtime, fake);
      const second = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
        credentialRef,
      });
      if (second.kind !== "awaiting-consent" || second.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const callback = await callbackWithoutFollowing(second.authorizationUrl);
      callback.searchParams.set("client_id", "oaiapp_other-client");
      const hitsBefore = fake.tokenHits();
      await fetch(callback);
      const done = await waitForState(() => runtime.status(second.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "exchange-refused" });
      expect(fake.tokenHits()).toBe(hitsBefore);
      expect(store.values.has(credentialRef)).toBe(true);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses a first sign-in callback that returns the dynamic client placeholder", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const callback = await callbackWithoutFollowing(started.authorizationUrl);
      callback.searchParams.set("client_id", "dynamic_agent_client");
      await fetch(callback);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "exchange-refused" });
      expect(fake.tokenHits()).toBe(0);
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refreshes with the issued client id and resource and stores the rotation", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const prior = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      const priorIdToken = prior.idToken;
      const refreshed = await runtime.refresh(status.credentialRef);
      expect(refreshed).toEqual({ kind: "refreshed" });
      expect(fake.lastRefresh()).toMatchObject({
        grant_type: "refresh_token",
        client_id: ISSUED_CLIENT_ID,
        resource: "https://api.openai.com/v1",
        refresh_token: REFRESH,
      });
      const stored = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      // The rotating replacement refresh token is stored.
      expect(stored.refreshToken).toBe("rotated-refresh-token");
      expect(stored.accessToken).toBe("rotated-access-token");
      // A refresh without a new identity token keeps the prior identity.
      expect(stored.idToken).toBe(priorIdToken);
      expect(stored.subject).toBe(SUBJECT);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("accepts a refresh identity token that still carries the authorize nonce", async () => {
    const fake = await startFakeSiwcServer({ refreshIdToken: "authorize-nonce" });
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const refreshed = await runtime.refresh(status.credentialRef);
      expect(refreshed).toEqual({ kind: "refreshed" });
      expect(store.values.has(status.credentialRef)).toBe(true);
      const stored = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      expect(stored.subject).toBe(SUBJECT);
      expect(typeof stored.idToken).toBe("string");
      expect(stored.refreshToken).toBe("rotated-refresh-token");
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("asks to sign in again when a refresh identity token names a different subject", async () => {
    const fake = await startFakeSiwcServer({ refreshIdToken: "wrong-subject" });
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      await expect(runtime.refresh(status.credentialRef)).resolves.toEqual({
        kind: "sign-in-again",
        reason: "revoked",
      });
      expect(store.values.has(status.credentialRef)).toBe(false);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("serializes concurrent refreshes into a single token exchange", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const hitsBefore = fake.tokenHits();
      const [first, second] = await Promise.all([
        runtime.refresh(status.credentialRef),
        runtime.refresh(status.credentialRef),
      ]);
      expect(first).toEqual({ kind: "refreshed" });
      expect(second).toEqual({ kind: "refreshed" });
      // One exchange for the code plus one refresh; the second concurrent
      // refresh joined the in-flight one.
      expect(fake.tokenHits()).toBe(hitsBefore + 1);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("asks to sign in again and drops the grant when the refresh token is invalidated", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const revokedServer = await startFakeSiwcServer({
        refresh: { status: 400, error: "refresh_token_invalidated" },
      });
      // A second runtime over the same store whose token endpoint is the
      // revoking fake: the refresh fails with refresh_token_invalidated.
      const refreshing = createHostOAuthRuntime({
        store,
        timeoutMs: 2_000,
        siwcIssuer: fake.url,
        fetch: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/token")) return fetch(`${revokedServer.url}/token`, init);
          return fetch(input, init);
        },
      });
      try {
        await expect(refreshing.refresh(status.credentialRef)).resolves.toEqual({
          kind: "sign-in-again",
          reason: "revoked",
        });
        expect(store.values.has(status.credentialRef)).toBe(false);
      } finally {
        await refreshing.close();
        await revokedServer.close();
      }
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("revokes the refresh token at the discovery revocation endpoint on sign-out", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    try {
      const started = await runtime.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      // The runtime is already pointed at the fake issuer via siwcIssuer, so
      // revocation discovery and the revocation POST both hit the fake.
      const result = await runtime.revoke(status.credentialRef);
      expect(result).toEqual({ kind: "revoked" });
      expect(fake.revokeHits()).toBe(1);
      expect(fake.lastRevocation()).toMatchObject({
        token: REFRESH,
        token_type_hint: "refresh_token",
        client_id: ISSUED_CLIENT_ID,
      });
      expect(store.values.has(status.credentialRef)).toBe(false);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("keeps the ext_agent_host_id stable across runtime restarts", async () => {
    const fake = await startFakeSiwcServer();
    const store = memoryStore();
    const first = runtimeFor(store, fake);
    let credentialRef = "";
    try {
      const started = await first.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => first.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      const signedIn = first.status(started.attemptId);
      if (signedIn.kind !== "signed-in") throw new Error("missing credential ref");
      credentialRef = signedIn.credentialRef;
    } finally {
      await first.close();
    }
    // A fresh runtime over the same store reauthorizes the named grant with
    // the same host id and the issued client id.
    const second = runtimeFor(store, fake);
    try {
      const started = await second.begin({
        descriptor: chatGptPlanDescriptor(`${fake.url}/authorize`, `${fake.url}/token`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
        credentialRef,
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(started.authorizationUrl);
      expect(authorization.searchParams.get("ext_agent_host_id")).toBe(HOST_ID);
      expect(authorization.searchParams.get("client_id")).toBe(ISSUED_CLIENT_ID);
    } finally {
      await second.close();
      await fake.close();
    }
  });

  it("refuses a ChatGPT plan descriptor without a host id or agent name hint", async () => {
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: {
          descriptorId: "chatgpt-plan",
          dialect: "chatgpt-plan-siwc",
          flow: "authorization-code-pkce",
          authorizationEndpoint: "https://auth.openai.com/api/accounts/authorize",
          tokenEndpoint: "https://auth.openai.com/api/accounts/oauth/token",
          scopes: ["openid"],
          termsId: "chatgpt-plan-terms-1",
        },
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-06T18:00:00.000Z",
      });
      expect(started).toEqual({ kind: "refused", reason: "invalid" });
    } finally {
      await runtime.close();
    }
  });
});
