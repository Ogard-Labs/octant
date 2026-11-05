import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHostOAuthRuntime, exchangeAuthorizationCode } from "./hostOAuth";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { controlIssuerDeadlines, stalledAnswer } from "./stalledIssuer.test-support";

const github = {
  dialect: "github-mcp-oauth-app",
  resource: "https://api.githubcopilot.com/mcp/",
  issuer: "https://github.com/login/oauth",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  identityEndpoint: "https://api.github.com/user",
} as const;
const verifier = "x".repeat(43);
const secretRef = "55000000-0000-4000-8000-000000000001";

describe("GitHub OAuth App MCP read profile", () => {
  it("exchanges an expiring code with broker-only app authentication and validates identity before publishing a grant", async () => {
    const calls: string[] = [];
    const fetchPort = new Proxy(globalThis.fetch, {
      apply: async (_target, _receiver, args: Parameters<typeof globalThis.fetch>) => {
        const [url, init] = args;
        calls.push(String(url));
        if (String(url) === github.tokenEndpoint) {
          const form = new URLSearchParams(String(init?.body));
          expect(form.get("client_id")).toBe("synthetic-owned-app");
          expect(form.get("client_secret")).toBe("synthetic-app-secret");
          expect(form.get("code_verifier")).toBe(verifier);
          expect(form.get("redirect_uri")).toBe("http://127.0.0.1:43125/oauth/callback");
          return Response.json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            expires_in: 28800,
            refresh_token_expires_in: 15897600,
            token_type: "bearer",
            scope: "read:user",
          });
        }
        expect(String(url)).toBe(github.identityEndpoint);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer synthetic-access");
        expect(headers.get("user-agent")).toBe("Octant");
        expect(headers.get("accept")).toBe("application/vnd.github+json");
        expect(headers.get("x-github-api-version")).toBe("2026-03-10");
        expect(init?.redirect).toBe("error");
        return Response.json(
          {
            id: 12345,
            login: "synthetic-fixture-user",
            email: "discard-this-field@example.invalid",
            private_gists: 3,
          },
          { headers: { "x-oauth-scopes": "read:user" } },
        );
      },
    });
    const result = await exchangeAuthorizationCode({
      dialect: github.dialect,
      resource: github.resource,
      mcpTransportUrl: github.resource,
      mcpIssuer: github.issuer,
      clientAuthentication: {
        method: "client_secret_post",
        secretRef,
        tokenEndpoint: github.tokenEndpoint,
      },
      resolveClientSecret: async () => "synthetic-app-secret",
      tokenEndpoint: github.tokenEndpoint,
      clientId: "synthetic-owned-app",
      code: "synthetic-code",
      redirectUri: "http://127.0.0.1:43125/oauth/callback",
      verifier,
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      fetch: fetchPort,
      now: () => 1_000_000,
    });
    expect(result).toMatchObject({
      kind: "tokens",
      grant: {
        tokenType: "Bearer",
        dialect: github.dialect,
        mcpAccount: { userId: "12345", grantedScopes: ["read:user"] },
      },
    });
    expect(calls).toEqual([github.tokenEndpoint, github.identityEndpoint]);
    expect(JSON.stringify(result)).not.toContain("discard-this-field");
    expect(JSON.stringify(result)).not.toContain("synthetic-app-secret");
  });
});

const credentialRef = "55000000-0000-4000-8000-000000000002";
const goodToken = {
  access_token: "synthetic-access",
  refresh_token: "synthetic-refresh",
  expires_in: 28800,
  token_type: "bearer",
  scope: "read:user",
};
function protocol(
  options: {
    readonly token?: unknown;
    readonly identity?: unknown;
    readonly headers?: HeadersInit;
    readonly identityResponse?: (init: RequestInit | undefined) => Promise<Response>;
  } = {},
) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const fetchPort = new Proxy(globalThis.fetch, {
    apply: async (_target, _receiver, args: Parameters<typeof fetch>) => {
      const [url, init] = args;
      calls.push({ url: String(url), init });
      if (String(url) === github.tokenEndpoint) return Response.json(options.token ?? goodToken);
      expect(String(url)).toBe(github.identityEndpoint);
      return options.identityResponse === undefined
        ? Response.json(options.identity ?? { id: 12345 }, {
            headers: options.headers ?? { "x-oauth-scopes": "read:user" },
          })
        : options.identityResponse(init);
    },
  });
  const input = {
    dialect: github.dialect,
    resource: github.resource,
    mcpTransportUrl: github.resource,
    mcpIssuer: github.issuer,
    clientAuthentication: {
      method: "client_secret_post" as const,
      secretRef,
      tokenEndpoint: github.tokenEndpoint,
    },
    tokenEndpoint: github.tokenEndpoint,
    clientId: "synthetic-owned-app",
    code: "synthetic-code",
    redirectUri: "http://127.0.0.1:43125/oauth/callback",
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    resolveClientSecret: async () => "synthetic-app-secret",
    fetch: fetchPort,
    now: () => 1_000_000,
  };
  return { input, calls, fetchPort };
}
function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    has: async (id) => values.has(id),
    set: async (id, value) => void values.set(id, value),
    delete: async (id) => void values.delete(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
  };
}

describe("GitHub read-profile binding and rotation", () => {
  it.each([
    { clientId: "https://client.example/metadata.json" },
    { resource: "https://api.githubcopilot.com/" },
    { mcpTransportUrl: "https://api.githubcopilot.com/mcp" },
    { mcpIssuer: "https://github.com/login/oauth/" },
    { tokenEndpoint: "https://other.example/token" },
    { redirectUri: "http://localhost:43125/oauth/callback" },
    { dialect: "mcp-authorization" as const },
  ])("refuses a changed binding before any credential request: %j", async (change) => {
    const fixture = protocol();
    expect((await exchangeAuthorizationCode({ ...fixture.input, ...change })).kind).toBe("refused");
    expect(fixture.calls).toEqual([]);
  });
  it.each([undefined, ""])(
    "refuses an unavailable broker secret before network access (%s)",
    async (secret) => {
      const fixture = protocol();
      expect(
        (
          await exchangeAuthorizationCode({
            ...fixture.input,
            resolveClientSecret: async () => {
              if (secret === undefined) throw new CredentialStoreFailure("missing");
              return secret;
            },
          })
        ).kind,
      ).toBe("refused");
      expect(fixture.calls).toEqual([]);
    },
  );
  it.each([
    { expires_in: undefined },
    { expires_in: 0 },
    { expires_in: 1.5 },
    { expires_in: Number.MAX_SAFE_INTEGER },
    { refresh_token: undefined },
    { token_type: "user" },
    { error: "bad_verification_code" },
  ])(
    "refuses an unsupported token response without substituting a lifetime: %j",
    async (change) => {
      const fixture = protocol({ token: { ...goodToken, ...change } });
      expect((await exchangeAuthorizationCode(fixture.input)).kind).toBe("refused");
      expect(fixture.calls.map((call) => call.url)).toEqual([github.tokenEndpoint]);
    },
  );
  it.each([0, -1, 1.5, "12345", Number.MAX_SAFE_INTEGER + 1, null])(
    "refuses identity %j without substituting a login name",
    async (id) => {
      const fixture = protocol({ identity: { id, login: "synthetic-login" } });
      expect((await exchangeAuthorizationCode(fixture.input)).kind).toBe("refused");
    },
  );
  it.each(["", "repo,read:user", "user", "read:user,user:email"])(
    "refuses reported permissions outside the reviewed read profile: %s",
    async (scope) => {
      expect(
        (await exchangeAuthorizationCode(protocol({ token: { ...goodToken, scope } }).input)).kind,
      ).toBe("refused");
      expect(
        (await exchangeAuthorizationCode(protocol({ headers: { "x-oauth-scopes": scope } }).input))
          .kind,
      ).toBe("refused");
    },
  );
  it.each(["hangs", "stalls-mid-answer"] as const)(
    "bounds a fixed identity request that %s",
    async (kind) => {
      const deadlines = controlIssuerDeadlines();
      try {
        const fixture = protocol({ identityResponse: (init) => stalledAnswer(kind, init?.signal) });
        expect((await exchangeAuthorizationCode(fixture.input)).kind).toBe("refused");
        expect(deadlines.bounds()).toEqual([30000, 30000]);
      } finally {
        deadlines.restore();
      }
    },
  );
  it("rejects an identity redirect without following a new destination", async () => {
    const fixture = protocol({
      identityResponse: async () =>
        new Response(null, { status: 302, headers: { location: "https://other.example/user" } }),
    });
    expect((await exchangeAuthorizationCode(fixture.input)).kind).toBe("refused");
    expect(fixture.calls).toHaveLength(2);
  });
  it.each([
    { identity: { id: 99999 }, reason: "account-changed" },
    { token: { ...goodToken, scope: "read:user,repo" }, reason: "permission-mismatch" },
    { token: { ...goodToken, scope: "" }, reason: "permission-missing" },
    {
      identityResponse: async () => new Response(null, { status: 503 }),
      reason: "identity-unavailable",
    },
  ])(
    "retires a rotated grant on $reason and never falls back to its previous bearer",
    async ({ reason, ...change }) => {
      const first = await exchangeAuthorizationCode(protocol().input);
      if (first.kind !== "tokens") throw new Error("Expected first grant");
      const store = memoryStore();
      await store.set(credentialRef, JSON.stringify(first.grant));
      const fixture = protocol(change);
      const runtime = createHostOAuthRuntime({
        store,
        fetch: fixture.fetchPort,
        resolveClientSecret: async () => "synthetic-app-secret",
        now: () => 1_000_000,
      });
      try {
        expect(await runtime.refresh(credentialRef)).toEqual({ kind: "sign-in-again", reason });
        expect(store.values.has(credentialRef)).toBe(false);
        expect(await runtime.access(credentialRef)).not.toMatchObject({ kind: "granted" });
      } finally {
        await runtime.close();
      }
    },
  );
  it("asks to sign in again when GitHub reports the refresh token is no longer usable", async () => {
    const first = await exchangeAuthorizationCode(protocol().input);
    if (first.kind !== "tokens") throw new Error("Expected first grant");
    const store = memoryStore();
    await store.set(credentialRef, JSON.stringify(first.grant));
    const fixture = protocol({
      token: {
        error: "bad_refresh_token",
        error_description: "The refresh token passed is incorrect or expired.",
      },
    });
    const runtime = createHostOAuthRuntime({
      store,
      fetch: fixture.fetchPort,
      resolveClientSecret: async () => "synthetic-app-secret",
      now: () => 1_000_000,
    });
    try {
      expect(await runtime.refresh(credentialRef)).toEqual({
        kind: "sign-in-again",
        reason: "revoked",
      });
      expect(store.values.has(credentialRef)).toBe(false);
    } finally {
      await runtime.close();
    }
  });
  it("reopens the persisted grant and authenticates rotation with the same app, retaining only last-reported permissions", async () => {
    const first = await exchangeAuthorizationCode(protocol().input);
    if (first.kind !== "tokens") throw new Error("Expected first grant");
    const store = memoryStore();
    await store.set(credentialRef, JSON.stringify(first.grant));
    const fixture = protocol({
      token: {
        ...goodToken,
        access_token: "synthetic-new",
        refresh_token: "synthetic-rotated",
        scope: undefined,
      },
      headers: {},
    });
    const runtime = createHostOAuthRuntime({
      store,
      fetch: fixture.fetchPort,
      resolveClientSecret: async () => "synthetic-app-secret",
      now: () => 1_000_000,
    });
    try {
      expect(await runtime.refresh(credentialRef)).toEqual({ kind: "refreshed" });
      const form = new URLSearchParams(String(fixture.calls[0]?.init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("synthetic-refresh");
      expect(form.get("client_secret")).toBe("synthetic-app-secret");
      expect(form.has("code_verifier")).toBe(false);
      expect(await runtime.access(credentialRef)).toMatchObject({
        kind: "granted",
        accessToken: "synthetic-new",
        mcpAccount: { userId: "12345", grantedScopes: ["read:user"] },
      });
      expect(store.values.get(credentialRef)).toContain("synthetic-rotated");
    } finally {
      await runtime.close();
    }
  });
  it.each(["identity", "write"] as const)(
    "joins a held refresh %s before sign-out deletion without affecting another grant",
    async (stage) => {
      const first = await exchangeAuthorizationCode(protocol().input);
      if (first.kind !== "tokens") throw new Error("Expected initial grant");
      const store = memoryStore();
      const sibling = "55000000-0000-4000-8000-000000000004";
      await store.set(credentialRef, JSON.stringify(first.grant));
      await store.set(sibling, JSON.stringify(first.grant));
      let release: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const fixture = protocol(
        stage === "identity"
          ? {
              identityResponse: async () => {
                entered();
                await held;
                return Response.json({ id: 12345 });
              },
            }
          : {},
      );
      const runtime = createHostOAuthRuntime({
        store: {
          ...store,
          set: async (id, value) => {
            if (id === credentialRef && stage === "write") {
              entered();
              await held;
            }
            await store.set(id, value);
          },
        },
        fetch: fixture.fetchPort,
        resolveClientSecret: async () => "synthetic-app-secret",
        now: () => 1_000_000,
      });
      try {
        const refreshing = runtime.refresh(credentialRef);
        await started;
        let retired = false;
        const retirement = runtime.revoke(credentialRef).then((value) => {
          retired = true;
          return value;
        });
        expect(await runtime.access(sibling)).toMatchObject({ kind: "granted" });
        expect(retired).toBe(false);
        expect(store.values.has(credentialRef)).toBe(true);
        expect(await runtime.access(credentialRef)).not.toMatchObject({ kind: "granted" });
        release();
        await refreshing;
        expect(await retirement).toEqual({ kind: "revoked" });
        expect(store.values.has(credentialRef)).toBe(false);
        expect(store.values.has(sibling)).toBe(true);
        expect(await runtime.access(credentialRef)).not.toMatchObject({ kind: "granted" });
      } finally {
        release();
        await runtime.close();
      }
    },
  );
  it.each([
    { tokenType: "user" },
    { expiresAt: null },
    { expiresAt: 1.5 },
    { mcpIssuer: "https://other.example" },
    { mcpAccount: { userId: "unsafe" } },
  ])(
    "refuses a malformed persisted GitHub grant without releasing a bearer: %j",
    async (change) => {
      const first = await exchangeAuthorizationCode(protocol().input);
      if (first.kind !== "tokens") throw new Error("Expected initial grant");
      const store = memoryStore();
      await store.set(credentialRef, JSON.stringify({ ...first.grant, ...change }));
      const runtime = createHostOAuthRuntime({ store });
      try {
        expect(await runtime.access(credentialRef)).not.toMatchObject({ kind: "granted" });
      } finally {
        await runtime.close();
      }
    },
  );
});
