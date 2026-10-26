import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startCredentialBroker, type CredentialBroker } from "./credentialBroker";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import {
  ACCOUNT_LABEL,
  AUDIENCE,
  BINDING,
  CLIENT_ID,
  DIRECTORY_HOST,
  ENDPOINT_ORIGIN,
  OTHER_TENANT_ID,
  TENANT_ID,
  directoryDescriptor,
  startFakeDirectory,
  type FakeDirectory,
  type FakeIdTokenFlaw,
} from "./fakeDirectory.test-support";
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

async function fakeDirectory(): Promise<FakeDirectory> {
  const fake = await startFakeDirectory();
  open.push(fake);
  return fake;
}

function runtimeFor(store: CredentialStore, fake: FakeDirectory): HostOAuthRuntime {
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

async function signIn(runtime: HostOAuthRuntime, fake: FakeDirectory) {
  const started = await runtime.begin({
    descriptor: directoryDescriptor(),
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
  });
  if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce") {
    throw new Error(`expected a PKCE attempt, got ${started.kind}`);
  }
  await fake.consent(started.authorizationUrl);
  return { started, settled: await waitForSettled(runtime, started.attemptId) };
}

async function signedIn(runtime: HostOAuthRuntime, fake: FakeDirectory): Promise<string> {
  const { settled } = await signIn(runtime, fake);
  if (settled.kind !== "signed-in") throw new Error(`expected a sign-in, got ${settled.kind}`);
  return settled.credentialRef;
}

describe("directory sign-in dialect", () => {
  it("signs in against the tenant's own authority with PKCE, a nonce, and only the audience", async () => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { started, settled } = await signIn(runtime, fake);

    const authorize = new URL(started.authorizationUrl);
    expect(authorize.origin).toBe(`https://${DIRECTORY_HOST}`);
    expect(authorize.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("scope")).toBe(
      `${AUDIENCE}/.default openid profile offline_access`,
    );
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(authorize.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
    );
    expect(settled.kind).toBe("signed-in");

    const [exchange] = fake.tokenRequests();
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      scope: `${AUDIENCE}/.default openid profile offline_access`,
    });
    // A public client the organization registered has no secret to send.
    expect(exchange).not.toHaveProperty("client_secret");
    expect(exchange).not.toHaveProperty("client_assertion");
    expect(new Set(fake.hostsContacted())).toEqual(new Set([DIRECTORY_HOST]));

    const [stored] = [...store.values.values()];
    const grant: unknown = JSON.parse(stored ?? "{}");
    expect(grant).toMatchObject({
      dialect: "directory-oidc",
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      audience: AUDIENCE,
      endpointOrigin: ENDPOINT_ORIGIN,
      accountLabel: ACCOUNT_LABEL,
      tokenEndpoint: `https://${DIRECTORY_HOST}/${TENANT_ID}/oauth2/v2.0/token`,
    });
    // Nothing later needs the identity token, so the broker does not keep it.
    expect(grant).not.toHaveProperty("idToken");
  });

  it.each([
    ["a multi-tenant alias", { tenantId: "organizations" }],
    ["the common alias", { tenantId: "common" }],
    ["a domain name for the tenant", { tenantId: "contoso.onmicrosoft.com" }],
    ["an uppercase tenant GUID", { tenantId: TENANT_ID.toUpperCase() }],
    ["a client id that is not a GUID", { clientId: "octant-desktop" }],
    ["an audience off the closed list", { audience: "https://management.azure.com" }],
    ["an http endpoint origin", { endpointOrigin: "http://contoso.openai.azure.com" }],
    ["an endpoint origin with a path", { endpointOrigin: `${ENDPOINT_ORIGIN}/openai` }],
    ["its own authorize URL", { authorizationEndpoint: "https://idp.example/authorize" }],
    ["its own token URL", { tokenEndpoint: "https://idp.example/token" }],
    ["its own scopes", { scopes: ["https://management.azure.com/.default"] }],
    ["the device-code flow", { flow: "device-code" as const }],
  ])("refuses a descriptor that names %s before any listener or request", async (_, change) => {
    const fake = await fakeDirectory();
    const runtime = runtimeFor(memoryStore(), fake);
    const descriptor = { ...directoryDescriptor(), ...change };

    const started = await runtime.begin({
      descriptor,
      actorId: randomUUID(),
      termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
    });

    expect(started).toEqual({ kind: "refused", reason: "invalid" });
    expect(fake.hostsContacted()).toEqual([]);
  });

  it("refuses directory binding fields on a descriptor of another dialect", async () => {
    const fake = await fakeDirectory();
    const runtime = runtimeFor(memoryStore(), fake);

    const started = await runtime.begin({
      descriptor: {
        descriptorId: "sample-http",
        clientId: "public-client",
        flow: "authorization-code-pkce",
        authorizationEndpoint: "https://idp.example/authorize",
        tokenEndpoint: "https://idp.example/token",
        scopes: ["read"],
        termsId: "terms-v1",
        tenantId: TENANT_ID,
      },
      actorId: randomUUID(),
      termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
    });

    expect(started).toEqual({ kind: "refused", reason: "invalid" });
  });

  it.each<[string, FakeIdTokenFlaw]>([
    ["names another tenant in tid", "other-tenant"],
    ["comes from another tenant's issuer", "other-issuer"],
    ["was issued to another client", "other-audience"],
    ["echoes another nonce", "other-nonce"],
    ["has expired", "expired"],
    ["is signed with a key the tenant does not publish", "unpublished-key"],
    ["is missing", "missing"],
  ])("refuses a sign-in whose identity token %s and stores nothing", async (_, flaw) => {
    const fake = await fakeDirectory();
    fake.flawExchangeIdToken(flaw);
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { settled } = await signIn(runtime, fake);

    expect(settled).toMatchObject({ kind: "refused", reason: "exchange-refused" });
    expect(store.values.size).toBe(0);
  });

  it.each([
    ["another resource", "https://management.azure.com/user_impersonation"],
    ["the audience beside another resource", `${AUDIENCE}/x https://graph.microsoft.com/User.Read`],
    ["no resource at all", "openid profile offline_access"],
  ])("refuses a sign-in whose echoed scope names %s", async (_, scope) => {
    const fake = await fakeDirectory();
    fake.echoExchangeScope(scope);
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);

    const { settled } = await signIn(runtime, fake);

    expect(settled).toMatchObject({ kind: "refused", reason: "exchange-refused" });
    expect(store.values.size).toBe(0);
  });

  it("releases the access token and its expiry only for the binding the grant was signed in for", async () => {
    const fake = await fakeDirectory();
    const runtime = runtimeFor(memoryStore(), fake);
    const credentialRef = await signedIn(runtime, fake);

    const granted = await runtime.access(credentialRef, BINDING);

    expect(granted).toMatchObject({ kind: "granted", tokenType: "Bearer" });
    if (granted.kind !== "granted") throw new Error("expected a grant");
    expect(fake.issued()).toContain(granted.accessToken);
    expect(Date.parse(granted.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it.each([
    ["another tenant", { ...BINDING, tenantId: OTHER_TENANT_ID }],
    ["another client", { ...BINDING, clientId: randomUUID() }],
    ["another audience", { ...BINDING, audience: "https://management.azure.com" }],
    ["another endpoint origin", { ...BINDING, endpointOrigin: "https://other.openai.azure.com" }],
    ["no binding", undefined],
  ])("refuses access under %s and keeps the grant", async (_, binding) => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);

    expect(await runtime.access(credentialRef, binding)).toEqual({ kind: "binding-mismatch" });
    expect(store.values.has(credentialRef)).toBe(true);
    expect((await runtime.access(credentialRef, BINDING)).kind).toBe("granted");
  });

  it("refuses a binding for a grant of another kind, so a directory caller never gets its bearer", async () => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = randomUUID();
    store.values.set(
      credentialRef,
      JSON.stringify({
        kind: "host-oauth-grant",
        version: 1,
        accessToken: "subscription-access-token",
        refreshToken: "subscription-refresh-token",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3_600_000,
        scope: "read",
        clientId: "public-client",
        tokenEndpoint: "https://idp.example/token",
        generation: 1,
      }),
    );

    expect(await runtime.access(credentialRef, BINDING)).toEqual({ kind: "binding-mismatch" });
    expect((await runtime.access(credentialRef)).kind).toBe("granted");
  });

  it("refreshes once for concurrent callers and stores the rotated tokens", async () => {
    const fake = await fakeDirectory();
    const runtime = runtimeFor(memoryStore(), fake);
    const credentialRef = await signedIn(runtime, fake);
    const before = await runtime.access(credentialRef, BINDING);
    fake.answerRefreshWith({ kind: "tokens", idToken: "same-subject" });

    const results = await Promise.all([
      runtime.refresh(credentialRef),
      runtime.refresh(credentialRef),
      runtime.refresh(credentialRef),
    ]);

    expect(results).toEqual([{ kind: "refreshed" }, { kind: "refreshed" }, { kind: "refreshed" }]);
    const refreshes = fake.tokenRequests().filter((form) => form.grant_type === "refresh_token");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      client_id: CLIENT_ID,
      scope: `${AUDIENCE}/.default openid profile offline_access`,
    });
    const after = await runtime.access(credentialRef, BINDING);
    expect(after.kind).toBe("granted");
    expect(after).not.toEqual(before);
  });

  it.each([
    [
      "an inactive refresh token",
      { kind: "error", error: "invalid_grant", errorCodes: [700082] },
      "expired",
    ],
    [
      "a refresh token past its lifetime",
      { kind: "error", error: "invalid_grant", suberror: "token_expired" },
      "expired",
    ],
    [
      "a password change or an administrator's revocation",
      { kind: "error", error: "invalid_grant", errorCodes: [50173] },
      "revoked",
    ],
    ["an unexplained invalid grant", { kind: "error", error: "invalid_grant" }, "revoked"],
    ["a removed app registration", { kind: "error", error: "invalid_client" }, "revoked"],
    [
      "a refresh whose identity token names another person",
      { kind: "tokens", idToken: "other-subject" },
      "revoked",
    ],
    [
      "a refresh whose identity token names another tenant",
      { kind: "tokens", idToken: "other-tenant" },
      "revoked",
    ],
    [
      "a refresh whose scope leaves the audience",
      { kind: "tokens", scope: "https://management.azure.com/user_impersonation" },
      "revoked",
    ],
  ] as const)("ends the grant on %s as sign-in-again (%s)", async (_, answer, reason) => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    fake.answerRefreshWith(answer);

    expect(await runtime.refresh(credentialRef)).toEqual({ kind: "sign-in-again", reason });
    expect(store.values.has(credentialRef)).toBe(false);
    expect(await runtime.access(credentialRef, BINDING)).toEqual({
      kind: "sign-in-again",
      reason: "expired",
    });
  });

  it.each([
    ["an interaction_required error", { kind: "error", error: "interaction_required" }],
    ["a multi-factor requirement", { kind: "error", error: "invalid_grant", errorCodes: [50076] }],
    [
      "a conditional access prompt",
      { kind: "error", error: "invalid_grant", suberror: "basic_action" },
    ],
  ] as const)("keeps the grant when %s needs the person present", async (_, answer) => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    fake.answerRefreshWith(answer);

    expect(await runtime.refresh(credentialRef)).toEqual({
      kind: "sign-in-again",
      reason: "interaction-required",
    });
    expect(store.values.has(credentialRef)).toBe(true);
  });

  it.each([
    ["the directory is unreachable", { kind: "unreachable" }],
    ["the directory answers 503", { kind: "status", status: 503 }],
    ["the directory throttles", { kind: "status", status: 429 }],
    [
      "the directory is temporarily unavailable",
      { kind: "error", error: "temporarily_unavailable" },
    ],
  ] as const)("keeps the grant as transient when %s", async (_, answer) => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    fake.answerRefreshWith(answer);

    expect(await runtime.refresh(credentialRef)).toEqual({ kind: "transient" });
    expect(store.values.has(credentialRef)).toBe(true);
    fake.answerRefreshWith({ kind: "tokens" });
    expect(await runtime.refresh(credentialRef)).toEqual({ kind: "refreshed" });
  });

  it("signs out by deleting the local grant without asking the directory", async () => {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const runtime = runtimeFor(store, fake);
    const credentialRef = await signedIn(runtime, fake);
    const contacted = fake.hostsContacted().length;

    expect(await runtime.revoke(credentialRef)).toEqual({ kind: "revoked" });
    expect(store.values.has(credentialRef)).toBe(false);
    expect(fake.hostsContacted()).toHaveLength(contacted);
    expect(await runtime.refresh(credentialRef)).toEqual({
      kind: "sign-in-again",
      reason: "expired",
    });
  });
});

describe("credential broker with a directory grant", () => {
  async function brokerWithGrant(): Promise<{
    readonly broker: CredentialBroker;
    readonly fake: FakeDirectory;
    readonly store: CredentialStore & { readonly values: Map<string, string> };
    readonly credentialRef: string;
  }> {
    const fake = await fakeDirectory();
    const store = memoryStore();
    const broker = await startCredentialBroker(store, undefined, {
      fetch: fake.fetch,
      timeoutMs: 5_000,
    });
    open.push(broker);
    const begun = await brokerPost(broker, "/v1/oauth/begin", {
      actorId: randomUUID(),
      termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
      descriptor: directoryDescriptor(),
    });
    const started: unknown = await begun.json();
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
    return { broker, fake, store, credentialRef: status.credentialRef };
  }

  it("signs in through the broker's routes and releases the token only under the binding", async () => {
    const { broker, credentialRef } = await brokerWithGrant();

    const granted: unknown = await (
      await brokerPost(broker, "/v1/oauth/access", { credentialRef, binding: BINDING })
    ).json();
    const unbound: unknown = await (
      await brokerPost(broker, "/v1/oauth/access", { credentialRef })
    ).json();
    const misbound: unknown = await (
      await brokerPost(broker, "/v1/oauth/access", {
        credentialRef,
        binding: { ...BINDING, endpointOrigin: "https://other.openai.azure.com" },
      })
    ).json();

    expect(granted).toMatchObject({ kind: "granted" });
    expect(unbound).toEqual({ kind: "binding-mismatch" });
    expect(misbound).toEqual({ kind: "binding-mismatch" });
  });

  it.each([
    ["a binding that is not an object", "tenant"],
    ["a binding missing a field", { tenantId: TENANT_ID, clientId: CLIENT_ID, audience: AUDIENCE }],
    ["a binding with an extra field", { ...BINDING, accountLabel: ACCOUNT_LABEL }],
    ["a binding field that is not text", { ...BINDING, tenantId: 7 }],
  ])("refuses an access request carrying %s as malformed", async (_, binding) => {
    const { broker, credentialRef } = await brokerWithGrant();

    const response = await brokerPost(broker, "/v1/oauth/access", { credentialRef, binding });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-request" });
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

  it.each([
    ["a peer off the loopback interface", { peer: "192.0.2.10" }],
    ["a caller without the broker token", { token: "" }],
    ["a browser page", { origin: "http://127.0.0.1:13773" }],
  ])(
    "refuses %s that begins, refreshes, reads, or signs out, and changes nothing",
    async (_, caller) => {
      const { broker, fake, store, credentialRef } = await brokerWithGrant();
      const requestsBefore = fake.tokenRequests().length;
      const attemptsBefore = fake.authorizeRequests().length;
      const bodies: ReadonlyArray<readonly [string, unknown]> = [
        [
          "/v1/oauth/begin",
          {
            actorId: randomUUID(),
            termsAcknowledgedAt: "2026-10-26T09:00:00.000Z",
            descriptor: directoryDescriptor(),
          },
        ],
        ["/v1/oauth/refresh", { credentialRef }],
        ["/v1/oauth/access", { credentialRef, binding: BINDING }],
        ["/v1/oauth/revoke", { credentialRef }],
        ["/v1/credentials/delete", { providerInstanceId: credentialRef }],
      ];

      for (const [path, body] of bodies) {
        const response = await brokerPost(broker, path, body, caller);
        expect(response.status, path).toBe(401);
        expect(await response.json(), path).toEqual({ error: "unauthorized" });
      }

      expect(store.values.has(credentialRef)).toBe(true);
      expect(fake.tokenRequests()).toHaveLength(requestsBefore);
      expect(fake.authorizeRequests()).toHaveLength(attemptsBefore);
    },
  );
});

async function brokerPost(
  broker: CredentialBroker,
  path: string,
  body: unknown,
  caller: {
    readonly peer?: string;
    readonly token?: string;
    readonly origin?: string;
  } = {},
): Promise<Response> {
  return broker.fetchForTest(
    new Request(new URL(path, broker.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-credential-broker-token": caller.token ?? broker.token,
        ...(caller.origin === undefined ? {} : { origin: caller.origin }),
      },
      body: JSON.stringify(body),
    }),
    caller.peer ?? "127.0.0.1",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
