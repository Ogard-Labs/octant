import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { startCredentialBroker } from "./credentialBroker";
import {
  codeVerifierMatchesChallenge,
  createHostOAuthRuntime,
  exchangeAuthorizationCode,
  type HostOAuthDescriptor,
} from "./hostOAuth";

const ACCESS = "access-token-must-not-leak";
const REFRESH = "refresh-token-must-not-leak";

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
  };
}

function descriptor(
  endpoints: {
    readonly authorize: string;
    readonly token: string;
    readonly device?: string;
  },
  flow: HostOAuthDescriptor["flow"],
): HostOAuthDescriptor {
  return {
    descriptorId: "sample-http",
    clientId: "public-client",
    flow,
    tokenEndpoint: endpoints.token,
    scopes: ["read"],
    termsId: "terms-v1",
    ...(flow === "authorization-code-pkce" ? { authorizationEndpoint: endpoints.authorize } : {}),
    ...(endpoints.device === undefined ? {} : { deviceAuthorizationEndpoint: endpoints.device }),
  };
}

interface FakeAuthorizationServer {
  readonly url: string;
  readonly tokenHits: () => number;
  readonly close: () => Promise<void>;
}

async function startFakeAuthorizationServer(options?: {
  readonly rejectVerifier?: boolean;
  readonly refresh?: { readonly status: number; readonly error?: string };
  readonly device?: {
    readonly interval?: number;
    readonly expiresIn?: number;
    readonly pendingPolls?: number;
    readonly error?: string;
  };
}): Promise<FakeAuthorizationServer> {
  let tokenHits = 0;
  let devicePolls = 0;
  const challenges = new Map<string, string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/authorize") {
      const redirect = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const challenge = url.searchParams.get("code_challenge");
      if (redirect === null || state === null || challenge === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      challenges.set(state, challenge);
      const callback = new URL(redirect);
      callback.searchParams.set("code", "auth-code");
      callback.searchParams.set("state", state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/device") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          device_code: "device-secret-must-not-leak",
          user_code: "ABCD-EFGH",
          verification_uri: `${baseUrl(server)}/verify`,
          expires_in: options?.device?.expiresIn ?? 60,
          interval: options?.device?.interval ?? 1,
        }),
      );
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
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const grant = form.get("grant_type");
      if (grant === "refresh_token") {
        const refresh = options?.refresh;
        if (refresh !== undefined) {
          response.writeHead(refresh.status, { "content-type": "application/json" });
          response.end(JSON.stringify(refresh.error === undefined ? {} : { error: refresh.error }));
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "rotated-access-token",
            token_type: "Bearer",
            expires_in: 30,
          }),
        );
        return;
      }
      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        devicePolls += 1;
        const device = options?.device;
        if (device?.error !== undefined) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: device.error }));
          return;
        }
        const pending = device?.pendingPolls ?? 0;
        if (devicePolls <= pending) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: devicePolls === 1 ? "slow_down" : "authorization_pending" }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: ACCESS,
            refresh_token: REFRESH,
            token_type: "Bearer",
            expires_in: 30,
          }),
        );
        return;
      }
      const verifier = form.get("code_verifier") ?? "";
      const state = [...challenges.entries()].find(
        ([, challenge]) => challenge === challengeFor(verifier),
      );
      if (options?.rejectVerifier === true || state === undefined) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          access_token: ACCESS,
          refresh_token: REFRESH,
          token_type: "Bearer",
          expires_in: 30,
        }),
      );
    });
  });
  await listen(server);
  return {
    url: baseUrl(server),
    tokenHits: () => tokenHits,
    close: () => closeServer(server),
  };
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
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

interface FakeOpenRouterServer {
  readonly url: string;
  readonly keyHits: () => number;
  readonly lastExchange: () => Record<string, string> | undefined;
  readonly close: () => Promise<void>;
}

async function startFakeOpenRouterServer(): Promise<FakeOpenRouterServer> {
  let keyHits = 0;
  let lastExchange: Record<string, string> | undefined;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/auth") {
      // OpenRouter's page redirects back to callback_url with `code` and,
      // when the request carried one, the echoed `state`.
      const callback = url.searchParams.get("callback_url");
      const state = url.searchParams.get("state");
      if (callback === null || url.searchParams.get("code_challenge") === null) {
        response.writeHead(400);
        response.end();
        return;
      }
      const redirect = new URL(callback);
      redirect.searchParams.set("code", "or-auth-code");
      if (state !== null) redirect.searchParams.set("state", state);
      response.writeHead(302, { location: redirect.toString() });
      response.end();
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/api/v1/auth/keys") {
      response.writeHead(404);
      response.end();
      return;
    }
    keyHits += 1;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string>;
      lastExchange = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ key: "sk-or-v1-user-controlled-key" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    keyHits: () => keyHits,
    lastExchange: () => lastExchange,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function openRouterDescriptor(authorize: string, token: string): HostOAuthDescriptor {
  return {
    descriptorId: "openrouter",
    dialect: "openrouter-pkce",
    flow: "authorization-code-pkce",
    authorizationEndpoint: authorize,
    tokenEndpoint: token,
    scopes: [],
    termsId: "openrouter-terms-1",
  };
}

describe("host OAuth runners", () => {
  it("refuses a standard descriptor without a client ID or scopes", async () => {
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: {
          descriptorId: "sample-http",
          flow: "authorization-code-pkce",
          authorizationEndpoint: "https://example.com/authorize",
          tokenEndpoint: "https://example.com/token",
          scopes: [],
          termsId: "terms-v1",
        },
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      expect(started).toEqual({ kind: "refused", reason: "invalid" });
    } finally {
      await runtime.close();
    }
  });

  it("runs the OpenRouter dialect end to end and stores the issued key", async () => {
    const fake = await startFakeOpenRouterServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: openRouterDescriptor(`${fake.url}/auth`, `${fake.url}/api/v1/auth/keys`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      expect(started.kind).toBe("awaiting-consent");
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const authorization = new URL(started.authorizationUrl);
      // The dialect sends callback_url, the S256 challenge, and a CSRF state
      // — no client_id, no scope.
      expect(authorization.searchParams.get("callback_url")).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorization.searchParams.get("client_id")).toBeNull();
      expect(authorization.searchParams.get("state")).not.toBeNull();
      expect(authorization.searchParams.get("scope")).toBeNull();
      const followed = await fetch(started.authorizationUrl);
      expect(followed.ok).toBe(true);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      expect(fake.keyHits()).toBe(1);
      expect(fake.lastExchange()).toMatchObject({
        code: "or-auth-code",
        code_challenge_method: "S256",
      });
      const published = JSON.stringify(runtime.status(started.attemptId));
      expect(published).not.toContain("sk-or-v1");
      const stored = [...store.values.values()].join("\n");
      expect(stored).toContain("sk-or-v1-user-controlled-key");
      expect(stored).toContain("openrouter-pkce");
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses a dialect callback whose state does not match and does not exchange the code", async () => {
    const fake = await startFakeOpenRouterServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: openRouterDescriptor(`${fake.url}/auth`, `${fake.url}/api/v1/auth/keys`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const redirect = new URL(
        new URL(started.authorizationUrl).searchParams.get("callback_url") ?? "",
      );
      redirect.searchParams.set("code", "stolen-or-code");
      redirect.searchParams.set("state", "not-the-issued-state");
      await fetch(redirect);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "state-mismatch" });
      expect(fake.keyHits()).toBe(0);
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("stores a dialect key without expiry and still grants access far in the future", async () => {
    const fake = await startFakeOpenRouterServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: openRouterDescriptor(`${fake.url}/auth`, `${fake.url}/api/v1/auth/keys`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const status = runtime.status(started.attemptId);
      if (status.kind !== "signed-in") throw new Error("missing credential ref");
      const stored = JSON.parse(store.values.get(status.credentialRef) ?? "{}") as Record<
        string,
        unknown
      >;
      // The key never expires: no expiry is manufactured, so a stored grant
      // keeps resolving after any amount of time has passed.
      expect(stored.expiresAt).toBeUndefined();
      const farFuture = createHostOAuthRuntime({
        store,
        now: () => Date.parse("2126-10-03T18:00:00.000Z"),
      });
      try {
        await expect(farFuture.refresh(status.credentialRef)).resolves.toEqual({
          kind: "refreshed",
        });
        const access = await farFuture.access(status.credentialRef);
        expect(access).toMatchObject({
          kind: "granted",
          accessToken: "sk-or-v1-user-controlled-key",
        });
        expect(
          (access as { expiresAt?: string }).expiresAt,
          "a non-expiring grant reports no expiry",
        ).toBeUndefined();
      } finally {
        await farFuture.close();
      }
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refreshes a dialect grant without a token exchange while the key is stored", async () => {
    const fake = await startFakeOpenRouterServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: openRouterDescriptor(`${fake.url}/auth`, `${fake.url}/api/v1/auth/keys`),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      if (done.kind !== "signed-in") throw new Error("expected a signed-in state");
      const credentialRef = (
        done as Extract<ReturnType<typeof runtime.status>, { kind: "signed-in" }>
      ).credentialRef;
      const hitsBefore = fake.keyHits();
      expect(await runtime.refresh(credentialRef)).toEqual({ kind: "refreshed" });
      expect(fake.keyHits()).toBe(hitsBefore);
      const access = await runtime.access(credentialRef);
      expect(access).toMatchObject({
        kind: "granted",
        accessToken: "sk-or-v1-user-controlled-key",
      });
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses to exchange a code when the verifier does not match the challenge", async () => {
    let fetched = false;
    const result = await exchangeAuthorizationCode({
      tokenEndpoint: "http://127.0.0.1:9/token",
      clientId: "public-client",
      code: "auth-code",
      redirectUri: "http://127.0.0.1:9/oauth/callback",
      verifier: "wrong-verifier-value-that-is-long-enough",
      challenge: challengeFor("the-verifier-that-was-issued"),
      fetch: async () => {
        fetched = true;
        throw new Error("must not fetch");
      },
      now: () => 0,
    });
    expect(result).toEqual({ kind: "refused", reason: "verifier-mismatch" });
    expect(fetched).toBe(false);
    expect(
      codeVerifierMatchesChallenge(
        "the-verifier-that-was-issued",
        challengeFor("the-verifier-that-was-issued"),
      ),
    ).toBe(true);
  });

  it("stores the grant in the credential store and keeps it out of the public sign-in state", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
          "authorization-code-pkce",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      expect(started.kind).toBe("awaiting-consent");
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const followed = await fetch(started.authorizationUrl);
      expect(followed.ok).toBe(true);
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      const published = JSON.stringify(runtime.status(started.attemptId));
      expect(published).not.toContain(ACCESS);
      expect(published).not.toContain(REFRESH);
      expect([...store.values.values()].join("\n")).toContain(REFRESH);
      expect(fake.tokenHits()).toBe(1);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses a callback whose state does not match and does not exchange the code", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
          "authorization-code-pkce",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const redirect = new URL(
        new URL(started.authorizationUrl).searchParams.get("redirect_uri") ?? "",
      );
      redirect.searchParams.set("code", "stolen-code");
      redirect.searchParams.set("state", "not-the-issued-state");
      await fetch(redirect);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "state-mismatch" });
      expect(fake.tokenHits()).toBe(0);
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses the grant when the authorization server rejects the code verifier", async () => {
    const fake = await startFakeAuthorizationServer({ rejectVerifier: true });
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
          "authorization-code-pkce",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      await fetch(started.authorizationUrl);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "verifier-mismatch" });
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("closes the loopback listener when consent does not arrive before the timeout", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 30 });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
          "authorization-code-pkce",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "timeout" });
      expect(store.values.size).toBe(0);
      const redirect = new URL(
        new URL(started.authorizationUrl).searchParams.get("redirect_uri") ?? "",
      );
      redirect.searchParams.set("code", "late-code");
      redirect.searchParams.set(
        "state",
        new URL(started.authorizationUrl).searchParams.get("state") ?? "",
      );
      await expect(fetch(redirect)).rejects.toThrow();
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("refuses a denied consent callback and does not exchange the code", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
          "authorization-code-pkce",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
        throw new Error("expected a PKCE attempt");
      }
      const redirect = new URL(
        new URL(started.authorizationUrl).searchParams.get("redirect_uri") ?? "",
      );
      const state = new URL(started.authorizationUrl).searchParams.get("state") ?? "";
      redirect.searchParams.set("error", "access_denied");
      redirect.searchParams.set("state", state);
      await fetch(redirect);
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "denied" });
      expect(fake.tokenHits()).toBe(0);
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("keeps the stored grant when refresh fails transiently and asks to sign in again when it is revoked", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const credentialRef = await signIn(runtime, fake);
      const failing = await startFakeAuthorizationServer({ refresh: { status: 503 } });
      const refreshed = createHostOAuthRuntime({
        store,
        fetch: async (input, init) => {
          const url = String(input);
          if (url === `${fake.url}/token`) return fetch(`${failing.url}/token`, init);
          return fetch(input, init);
        },
      });
      try {
        await expect(refreshed.refresh(credentialRef)).resolves.toEqual({ kind: "transient" });
        expect([...store.values.keys()]).toContain(credentialRef);
      } finally {
        await refreshed.close();
        await failing.close();
      }
      const revokedServer = await startFakeAuthorizationServer({
        refresh: { status: 400, error: "invalid_grant" },
      });
      const revoked = createHostOAuthRuntime({
        store,
        fetch: async (input, init) => fetch(new URL("/token", revokedServer.url), init),
      });
      try {
        await expect(revoked.refresh(credentialRef)).resolves.toEqual({
          kind: "sign-in-again",
          reason: "revoked",
        });
        expect(store.values.has(credentialRef)).toBe(false);
      } finally {
        await revoked.close();
        await revokedServer.close();
      }
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("asks to sign in again when the authorization server reports a reused refresh token", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const credentialRef = await signIn(runtime, fake);
      const reused = await startFakeAuthorizationServer({
        refresh: { status: 400, error: "refresh_token_reused" },
      });
      const refreshing = createHostOAuthRuntime({
        store,
        fetch: async (_input, init) => fetch(new URL("/token", reused.url), init),
      });
      try {
        await expect(refreshing.refresh(credentialRef)).resolves.toEqual({
          kind: "sign-in-again",
          reason: "refresh-reused",
        });
        expect(store.values.has(credentialRef)).toBe(false);
      } finally {
        await refreshing.close();
        await reused.close();
      }
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("polls a device code with backoff and stores the grant only after consent", async () => {
    const waits: number[] = [];
    const fake = await startFakeAuthorizationServer({
      device: { interval: 1, pendingPolls: 1 },
    });
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({
      store,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          {
            authorize: `${fake.url}/authorize`,
            token: `${fake.url}/token`,
            device: `${fake.url}/device`,
          },
          "device-code",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      expect(started).toMatchObject({
        kind: "awaiting-consent",
        flow: "device-code",
        userCode: "ABCD-EFGH",
      });
      if (started.kind !== "awaiting-consent") throw new Error("expected a device attempt");
      const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
      expect(done.kind).toBe("signed-in");
      expect(waits[0]).toBe(1_000);
      expect(waits[1]).toBe(6_000);
      expect(JSON.stringify(runtime.status(started.attemptId))).not.toContain(
        "device-secret-must-not-leak",
      );
      expect([...store.values.values()].join("\n")).toContain(REFRESH);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("stops device polling when the code expires and stores nothing", async () => {
    const fake = await startFakeAuthorizationServer({
      device: { interval: 1, expiresIn: 0, error: "expired_token" },
    });
    const store = memoryStore();
    const runtime = createHostOAuthRuntime({ store, sleep: async () => undefined });
    try {
      const started = await runtime.begin({
        descriptor: descriptor(
          {
            authorize: `${fake.url}/authorize`,
            token: `${fake.url}/token`,
            device: `${fake.url}/device`,
          },
          "device-code",
        ),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
      });
      if (started.kind !== "awaiting-consent") throw new Error("expected a device attempt");
      const done = await waitForState(() => runtime.status(started.attemptId), "refused");
      expect(done).toMatchObject({ kind: "refused", reason: "timeout" });
      expect(store.values.size).toBe(0);
    } finally {
      await runtime.close();
      await fake.close();
    }
  });

  it("does not return an oauth grant from the raw credential resolve path", async () => {
    const fake = await startFakeAuthorizationServer();
    const store = memoryStore();
    const broker = await startCredentialBroker(store);
    const runtime = createHostOAuthRuntime({ store, timeoutMs: 2_000 });
    try {
      const credentialRef = await signIn(runtime, fake);
      const resolved = await broker.fetchForTest(
        new Request(new URL("/v1/credentials/resolve", broker.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-credential-broker-token": broker.token,
          },
          body: JSON.stringify({ providerInstanceId: credentialRef }),
        }),
      );
      expect(resolved.status).toBe(403);
      const body = await resolved.text();
      expect(body).not.toContain(ACCESS);
      expect(body).not.toContain(REFRESH);
      expect(body).toContain("oauth-material");
    } finally {
      await runtime.close();
      await broker.close();
      await fake.close();
    }
  });
});

async function signIn(
  runtime: ReturnType<typeof createHostOAuthRuntime>,
  fake: FakeAuthorizationServer,
): Promise<string> {
  const started = await runtime.begin({
    descriptor: descriptor(
      { authorize: `${fake.url}/authorize`, token: `${fake.url}/token` },
      "authorization-code-pkce",
    ),
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-03T18:00:00.000Z",
  });
  if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
    throw new Error("expected a PKCE attempt");
  }
  await fetch(started.authorizationUrl);
  const done = await waitForState(() => runtime.status(started.attemptId), "signed-in");
  if (done.kind !== "signed-in") throw new Error("sign-in did not complete");
  const status = runtime.status(started.attemptId);
  if (status.kind !== "signed-in") throw new Error("missing credential ref");
  return status.credentialRef;
}
