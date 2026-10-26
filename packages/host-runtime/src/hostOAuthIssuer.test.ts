import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { BINDING as TENANT_BINDING } from "./fakeDirectory.test-support";
import {
  GATEWAY_ORIGIN,
  GATEWAY_SCOPE,
  ISSUER,
  ISSUER_ACCOUNT_LABEL,
  ISSUER_BINDING,
  ISSUER_CLIENT_ID,
  ISSUER_HOST,
  issuerDescriptor,
  startFakeIssuer,
  type FakeDiscoveryFlaw,
  type FakeIssuer,
  type FakeIssuerIdTokenFlaw,
} from "./fakeIssuer.test-support";
import { createHostOAuthRuntime, type HostOAuthRuntime } from "./hostOAuth";

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

const open: Array<{ readonly close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const resource of open.splice(0)) await resource.close();
});

async function fakeIssuer(): Promise<FakeIssuer> {
  const fake = await startFakeIssuer();
  open.push(fake);
  return fake;
}

function runtimeFor(store: CredentialStore, fake: FakeIssuer): HostOAuthRuntime {
  const runtime = createHostOAuthRuntime({ store, fetch: fake.fetch, timeoutMs: 5_000 });
  open.push(runtime);
  return runtime;
}

async function waitForSettled(runtime: HostOAuthRuntime, attemptId: string) {
  const deadline = Date.now() + 3_000;
  let state = runtime.status(attemptId);
  while (state.kind === "awaiting-consent" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    state = runtime.status(attemptId);
  }
  return state;
}

async function signIn(runtime: HostOAuthRuntime, fake: FakeIssuer) {
  const started = await runtime.begin({
    descriptor: issuerDescriptor(),
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
  });
  if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
    throw new Error(`expected a PKCE attempt, got ${started.kind}`);
  }
  await fake.consent(started.authorizationUrl);
  return { started, settled: await waitForSettled(runtime, started.attemptId) };
}

async function signedIn(runtime: HostOAuthRuntime, fake: FakeIssuer): Promise<string> {
  const { settled } = await signIn(runtime, fake);
  if (settled.kind !== "signed-in") throw new Error(`expected a sign-in, got ${settled.kind}`);
  return settled.credentialRef;
}

const REQUESTED_SCOPE = `${GATEWAY_SCOPE} openid profile offline_access`;

describe("issuer sign-in dialect", () => {
  it("signs in at the organization's own issuer, found by its discovery document, for only the gateway scope", async () => {
    const fake = await fakeIssuer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { started, settled } = await signIn(runtime, fake);

    const authorize = new URL(started.authorizationUrl);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/v1/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe(ISSUER_CLIENT_ID);
    expect(authorize.searchParams.get("scope")).toBe(REQUESTED_SCOPE);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The issuer may not support RFC 8707, and some refuse it outright.
    expect(authorize.searchParams.has("resource")).toBe(false);
    expect(settled).toMatchObject({ kind: "signed-in", accountLabel: ISSUER_ACCOUNT_LABEL });

    const [exchange] = fake.tokenRequests();
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      client_id: ISSUER_CLIENT_ID,
      scope: REQUESTED_SCOPE,
    });
    expect(exchange).not.toHaveProperty("client_secret");
    expect(new Set(fake.hostsContacted())).toEqual(new Set([ISSUER_HOST]));

    const [stored] = [...store.values.values()];
    const grant: unknown = JSON.parse(stored ?? "{}");
    expect(grant).toMatchObject({
      dialect: "issuer-oidc",
      issuer: ISSUER,
      clientId: ISSUER_CLIENT_ID,
      resourceScope: GATEWAY_SCOPE,
      endpointOrigin: GATEWAY_ORIGIN,
      accountLabel: ISSUER_ACCOUNT_LABEL,
      tokenEndpoint: `${ISSUER}/v1/token`,
      jwksUrl: `${ISSUER}/v1/keys`,
    });
    expect(grant).not.toHaveProperty("idToken");
  });

  it.each<[string, FakeDiscoveryFlaw, "invalid" | "unavailable"]>([
    ["names another issuer", "other-issuer", "invalid"],
    ["puts its token endpoint on another host", "token-endpoint-off-origin", "invalid"],
    ["puts its sign-in page on another host", "authorize-endpoint-off-origin", "invalid"],
    ["puts its key set on another host", "key-set-off-origin", "invalid"],
    ["does not offer PKCE with S256", "no-s256", "invalid"],
    ["cannot be reached", "unreachable", "unavailable"],
    ["answers with a server error", "server-error", "unavailable"],
  ])(
    "refuses to begin when the discovery document %s, before any listener or sign-in page",
    async (_, flaw, reason) => {
      const fake = await fakeIssuer();
      fake.flawDiscovery(flaw);
      const runtime = runtimeFor(memoryStore(), fake);

      const started = await runtime.begin({
        descriptor: issuerDescriptor(),
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
      });

      expect(started).toEqual({ kind: "refused", reason });
      expect(fake.authorizeRequests()).toHaveLength(0);
      expect(new Set(fake.hostsContacted())).toEqual(new Set([ISSUER_HOST]));
    },
  );

  it.each([
    ["a tenant", { tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f" }],
    ["an audience", { audience: "https://cognitiveservices.azure.com" }],
    ["a token endpoint", { tokenEndpoint: `${ISSUER}/v1/token` }],
    ["no scope", { scopes: [] }],
    ["two scopes", { scopes: [GATEWAY_SCOPE, "gateway.admin"] }],
    ["only an identity scope", { scopes: ["openid"] }],
    ["an http issuer", { issuer: "http://login.gateway-issuer.example/oauth2/gateway" }],
    ["an issuer with a query", { issuer: `${ISSUER}?tenant=other` }],
    ["an endpoint with a path", { endpointOrigin: `${GATEWAY_ORIGIN}/v1` }],
    // Device-code sign-in is the closed directory's alone.
    ["the device-code flow", { flow: "device-code" as const }],
  ])("refuses an issuer descriptor naming %s", async (_, overrides) => {
    const fake = await fakeIssuer();
    const runtime = runtimeFor(memoryStore(), fake);
    const { issuer: _issuer, ...withoutIssuer } = issuerDescriptor();

    for (const descriptor of [{ ...issuerDescriptor(), ...overrides }, withoutIssuer]) {
      const started = await runtime.begin({
        descriptor,
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
      });
      expect(started).toEqual({ kind: "refused", reason: "invalid" });
    }
    expect(fake.discoveryRequests()).toBe(0);
  });

  it.each<[string, FakeIssuerIdTokenFlaw]>([
    ["another issuer", "other-issuer"],
    ["another client", "other-audience"],
    ["another sign-in's nonce", "other-nonce"],
    ["an expired identity", "expired"],
    ["a key the issuer never published", "unpublished-key"],
    ["no identity token", "missing"],
  ])("stores nothing when the identity token names %s", async (_, flaw) => {
    const fake = await fakeIssuer();
    fake.flawExchangeIdToken(flaw);
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { settled } = await signIn(runtime, fake);

    expect(settled).toMatchObject({ kind: "refused", reason: "exchange-refused" });
    expect(store.values.size).toBe(0);
  });

  it.each([
    ["no scope at all", undefined],
    ["only identity scopes", "openid profile"],
    ["the gateway scope beside another resource", `${GATEWAY_SCOPE} gateway.admin`],
    ["another resource in place of the gateway scope", "gateway.admin"],
  ])("stores nothing when the issuer echoes %s", async (_, scope) => {
    const fake = await fakeIssuer();
    fake.echoExchangeScope(scope);
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { settled } = await signIn(runtime, fake);

    expect(settled).toMatchObject({ kind: "refused", reason: "exchange-refused" });
    expect(store.values.size).toBe(0);
  });

  it("releases the token only to its exact issuer binding, never to a tenant binding or none", async () => {
    const fake = await fakeIssuer();
    const runtime = runtimeFor(memoryStore(), fake);
    const credentialRef = await signedIn(runtime, fake);

    expect(await runtime.access(credentialRef, ISSUER_BINDING)).toMatchObject({
      kind: "granted",
    });
    for (const binding of [
      undefined,
      { ...ISSUER_BINDING, issuer: "https://login.gateway-issuer.example/oauth2/other" },
      { ...ISSUER_BINDING, clientId: "0oa1other" },
      { ...ISSUER_BINDING, scope: "gateway.admin" },
      { ...ISSUER_BINDING, endpointOrigin: "https://llm-staging.gateway-issuer.example" },
      { ...TENANT_BINDING, clientId: ISSUER_CLIENT_ID, endpointOrigin: GATEWAY_ORIGIN },
    ]) {
      expect(await runtime.access(credentialRef, binding)).toEqual({ kind: "binding-mismatch" });
    }
  });

  it("refreshes once for concurrent callers at the stored token endpoint, without discovering again", async () => {
    const fake = await fakeIssuer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    const discovered = fake.discoveryRequests();
    fake.answerRefreshWith({ kind: "tokens", idToken: "same-subject" });

    const results = await Promise.all([
      runtime.refresh(credentialRef),
      runtime.refresh(credentialRef),
      runtime.refresh(credentialRef),
    ]);

    expect(results).toEqual([{ kind: "refreshed" }, { kind: "refreshed" }, { kind: "refreshed" }]);
    const refreshes = fake.tokenRequests().filter((form) => form.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({ client_id: ISSUER_CLIENT_ID, scope: REQUESTED_SCOPE });
    expect(fake.discoveryRequests()).toBe(discovered);
    expect(await runtime.access(credentialRef, ISSUER_BINDING)).toMatchObject({
      kind: "granted",
    });
  });

  it.each<[string, Parameters<FakeIssuer["answerRefreshWith"]>[0], string, boolean]>([
    [
      "asks for the person again",
      { kind: "error", error: "interaction_required" },
      "interaction-required",
      true,
    ],
    [
      "asks for a fresh login",
      { kind: "error", error: "login_required" },
      "interaction-required",
      true,
    ],
    ["refuses the refresh token", { kind: "error", error: "invalid_grant" }, "revoked", false],
    ["no longer knows the client", { kind: "error", error: "invalid_client" }, "revoked", false],
    [
      "echoes a scope off the gateway",
      { kind: "tokens", scope: "gateway.admin" },
      "revoked",
      false,
    ],
    ["names another person", { kind: "tokens", idToken: "other-subject" }, "revoked", false],
  ])(
    "reads a refresh where the issuer %s as sign-in-again and keeps or drops the grant",
    async (_, answer, reason, kept) => {
      const fake = await fakeIssuer();
      const store = memoryStore();
      const runtime = runtimeFor(store, fake);
      const credentialRef = await signedIn(runtime, fake);
      fake.answerRefreshWith(answer);

      expect(await runtime.refresh(credentialRef)).toEqual({ kind: "sign-in-again", reason });
      expect(store.values.has(credentialRef)).toBe(kept);
    },
  );

  it("keeps the grant through a transient answer and never reads the issuer's description", async () => {
    const fake = await fakeIssuer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);

    for (const status of [429, 500, 503]) {
      fake.answerRefreshWith({ kind: "status", status });
      expect(await runtime.refresh(credentialRef)).toEqual({ kind: "transient" });
    }
    fake.answerRefreshWith({ kind: "error", error: "temporarily_unavailable" });
    expect(await runtime.refresh(credentialRef)).toEqual({ kind: "transient" });
    expect(store.values.has(credentialRef)).toBe(true);
  });

  it("signs out by deleting the local grant without asking the issuer", async () => {
    const fake = await fakeIssuer();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    const requests = fake.tokenRequests().length;

    expect(await runtime.revoke(credentialRef)).toEqual({ kind: "revoked" });
    expect(store.values.has(credentialRef)).toBe(false);
    expect(fake.tokenRequests()).toHaveLength(requests);
  });
});

describe("credential broker with an issuer grant", () => {
  async function brokerWithGrant(): Promise<{
    readonly broker: CredentialBroker;
    readonly store: CredentialStore & { readonly values: Map<string, string> };
    readonly credentialRef: string;
  }> {
    const fake = await fakeIssuer();
    const store = memoryStore();
    const broker = await startCredentialBroker(store, undefined, {
      fetch: fake.fetch,
      timeoutMs: 5_000,
    });
    open.push(broker);
    const started: unknown = await (
      await brokerPost(broker, "/v1/oauth/begin", {
        actorId: randomUUID(),
        termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
        descriptor: issuerDescriptor(),
      })
    ).json();
    if (!isRecord(started) || typeof started.authorizationUrl !== "string") {
      throw new Error("expected an authorization URL");
    }
    await fake.consent(started.authorizationUrl);
    const status: unknown = await (
      await brokerPost(broker, "/v1/oauth/status", { attemptId: started.attemptId })
    ).json();
    if (!isRecord(status) || typeof status.credentialRef !== "string") {
      throw new Error("expected a signed-in state");
    }
    expect(status.accountLabel).toBe(ISSUER_ACCOUNT_LABEL);
    return { broker, store, credentialRef: status.credentialRef };
  }

  it("signs in through the broker's routes and releases the token only under the issuer binding", async () => {
    const { broker, credentialRef } = await brokerWithGrant();

    const granted: unknown = await (
      await brokerPost(broker, "/v1/oauth/access", { credentialRef, binding: ISSUER_BINDING })
    ).json();
    const unbound: unknown = await (
      await brokerPost(broker, "/v1/oauth/access", { credentialRef })
    ).json();

    expect(granted).toMatchObject({ kind: "granted" });
    expect(unbound).toEqual({ kind: "binding-mismatch" });
  });

  it("refuses a binding that mixes a tenant's fields with an issuer's as malformed", async () => {
    const { broker, credentialRef } = await brokerWithGrant();

    const response = await brokerPost(broker, "/v1/oauth/access", {
      credentialRef,
      binding: { ...ISSUER_BINDING, tenantId: TENANT_BINDING.tenantId },
    });

    expect(response.status).toBe(400);
  });

  it("refuses a raw credential resolve of the grant", async () => {
    const { broker, store, credentialRef } = await brokerWithGrant();

    const response = await brokerPost(broker, "/v1/credentials/resolve", {
      providerInstanceId: credentialRef,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "oauth-material" });
    expect(store.values.has(credentialRef)).toBe(true);
  });
});

async function brokerPost(broker: CredentialBroker, path: string, body: unknown) {
  return broker.fetchForTest(
    new Request(new URL(path, broker.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-credential-broker-token": broker.token,
      },
      body: JSON.stringify(body),
    }),
    "127.0.0.1",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
