import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import {
  createHostOAuthRuntime,
  exchangeAuthorizationCode,
  type HostOAuthDescriptor,
} from "./hostOAuth";
import { SLACK_MCP_USER_OAUTH as slack, mcpOAuthResourceForTransport } from "./slackMcpOAuth";

const ref = "55000000-0000-4000-8000-000000000001";
const credential = "55000000-0000-4000-8000-000000000002";
const secret = "synthetic-owned-client-secret";
const verifier = "x".repeat(43);
const binding = {
  dialect: slack.dialect,
  resource: slack.resource,
  mcpIssuer: slack.issuer,
  mcpTransportUrl: slack.transportUrl,
  tokenEndpoint: slack.tokenEndpoint,
  clientAuthentication: {
    method: "client_secret_post",
    secretRef: ref,
    tokenEndpoint: slack.tokenEndpoint,
  },
} as const;
const descriptor: HostOAuthDescriptor = {
  ...binding,
  descriptorId: "slack-user-fixture",
  clientId: "owned-fixture-client",
  scopes: [slack.readScope],
  termsId: "mcp-terms-fixture",
  flow: "authorization-code-pkce",
  authorizationEndpoint: slack.authorizationEndpoint,
  redirectPort: 43125,
  redirectHostname: "localhost",
};
function memoryStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    delete: async (id) => void values.delete(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
  };
}
function protocol(
  body: unknown = {
    ok: true,
    access_token: "synthetic-access",
    token_type: "user",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    scope: slack.readScope,
  },
) {
  const calls: Array<{ url: string; form: URLSearchParams }> = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
      return Response.json(body);
    },
    { preconnect: () => undefined },
  );
  const input = {
    ...binding,
    clientId: descriptor.clientId ?? "",
    code: "synthetic-code",
    redirectUri: "http://localhost:43125/oauth/callback",
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    fetch: fetchImpl,
    now: () => 1_000_000,
    resolveClientSecret: async () => secret,
  };
  return { calls, fetchImpl, input };
}

describe("Slack MCP dedicated user-token dialect", () => {
  it.each([
    "http://127.0.0.1:43125/oauth/callback",
    "https://localhost:43125/oauth/callback",
    "http://localhost:43125/wrong",
    "http://localhost:43125/oauth/callback?extra=1",
    "http://localhost:43125/oauth/callback#extra",
    "http://other.example:43125/oauth/callback",
  ])(
    "refuses an unregistered callback before secret access or exchange (%s)",
    async (redirectUri) => {
      const { input, calls } = protocol();
      const resolveClientSecret = vi.fn(async () => secret);
      expect(
        await exchangeAuthorizationCode({ ...input, redirectUri, resolveClientSecret }),
      ).toMatchObject({ kind: "refused" });
      expect(resolveClientSecret).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );
  it("normalizes only the closed user-token dialect and preserves its refresh binding", async () => {
    const { calls, fetchImpl, input } = protocol();
    const exchanged = await exchangeAuthorizationCode(input);
    expect(exchanged.kind).toBe("tokens");
    if (exchanged.kind !== "tokens") return;
    expect(exchanged.grant).toMatchObject({
      dialect: slack.dialect,
      resource: slack.resource,
      mcpIssuer: slack.issuer,
      mcpTransportUrl: slack.transportUrl,
      tokenEndpoint: slack.tokenEndpoint,
      tokenType: "Bearer",
      clientAuthentication: binding.clientAuthentication,
    });
    expect(calls[0]?.form.get("resource")).toBe(slack.resource);
    expect(calls[0]?.form.get("client_secret")).toBe(secret);
    const store = memoryStore();
    await store.set(credential, JSON.stringify(exchanged.grant));
    // Refresh response is synthetic: public docs name the arguments, not a full rotated payload.
    const runtime = createHostOAuthRuntime({
      store,
      fetch: fetchImpl,
      now: () => 5_000_000,
      resolveClientSecret: async () => secret,
    });
    try {
      expect(await runtime.refresh(credential)).toEqual({ kind: "refreshed" });
      expect(await runtime.access(credential)).toMatchObject({
        kind: "granted",
        tokenType: "Bearer",
        accessToken: "synthetic-access",
      });
      expect(calls[1]?.form.get("grant_type")).toBe("refresh_token");
      expect(calls[1]?.form.get("resource")).toBe(slack.resource);
      expect(calls[1]?.form.get("code_verifier")).toBeNull();
      expect(JSON.parse(await store.resolve(credential))).toMatchObject({
        dialect: slack.dialect,
        tokenType: "Bearer",
        mcpIssuer: slack.issuer,
        mcpTransportUrl: slack.transportUrl,
      });
    } finally {
      await runtime.close();
    }
  });
  it("does not reinterpret user token_type on ordinary MCP resources", async () => {
    const { input } = protocol();
    const generic = {
      ...input,
      dialect: "mcp-authorization" as const,
      resource: "https://generic.example/mcp",
      tokenEndpoint: "https://generic.example/token",
      clientAuthentication: {
        ...binding.clientAuthentication,
        tokenEndpoint: "https://generic.example/token",
      },
    };
    const { mcpIssuer: _issuer, mcpTransportUrl: _transport, ...ordinary } = generic;
    expect(await exchangeAuthorizationCode(ordinary)).toMatchObject({
      kind: "tokens",
      grant: { tokenType: "user" },
    });
  });
  it.each([
    { resource: slack.transportUrl },
    { mcpIssuer: "https://other.example" },
    { mcpTransportUrl: "https://mcp.slack.com/other" },
    { tokenEndpoint: "https://slack.com/api/oauth.v2.access" },
  ])(
    "refuses broken profile binding before resolving a secret or requesting tokens",
    async (changed) => {
      const { input, calls } = protocol();
      const resolveClientSecret = vi.fn(async () => secret);
      expect(
        await exchangeAuthorizationCode({ ...input, ...changed, resolveClientSecret }),
      ).toEqual({ kind: "refused", reason: "exchange-refused" });
      expect(resolveClientSecret).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    },
  );
  it("refuses a missing client secret binding before requesting the dedicated endpoint", async () => {
    const { input, calls } = protocol();
    const { clientAuthentication: _auth, ...withoutAuthentication } = input;
    expect(await exchangeAuthorizationCode(withoutAuthentication)).toEqual({
      kind: "refused",
      reason: "exchange-refused",
    });
    expect(calls).toHaveLength(0);
  });
  it("does not let the generic dialect request the dedicated vendor endpoint", async () => {
    const { input, calls } = protocol();
    const { mcpIssuer: _issuer, mcpTransportUrl: _transport, ...ordinary } = input;
    expect(
      await exchangeAuthorizationCode({
        ...ordinary,
        dialect: "mcp-authorization",
        resource: "https://other.example/mcp",
      }),
    ).toEqual({ kind: "refused", reason: "exchange-refused" });
    expect(calls).toHaveLength(0);
  });
  it.each([
    { ok: false, access_token: "must-not-store", token_type: "user" },
    { ok: true, access_token: "must-not-store", token_type: "bot" },
    { ok: true, access_token: "must-not-store" },
  ])("refuses malformed or non-user successful HTTP responses", async (body) => {
    expect(await exchangeAuthorizationCode(protocol(body).input)).toEqual({
      kind: "refused",
      reason: "exchange-refused",
    });
  });
  it.each([
    "invalid_refresh_token",
    "token_expired",
    "token_revoked",
    "bad_client_secret",
    "invalid_client_id",
    "ratelimited",
    "service_unavailable",
  ])("maps documented refresh failure without exposing descriptions (%s)", async (error) => {
    const initial = await exchangeAuthorizationCode(protocol().input);
    if (initial.kind !== "tokens") throw new Error("fixture exchange failed");
    const store = memoryStore();
    await store.set(credential, JSON.stringify(initial.grant));
    const failure = protocol({
      ok: false,
      error,
      error_description: "synthetic-description-must-not-leak",
    });
    const runtime = createHostOAuthRuntime({
      store,
      fetch: failure.fetchImpl,
      now: () => 5_000_000,
      resolveClientSecret: async () => secret,
    });
    try {
      const answer = await runtime.refresh(credential);
      expect(JSON.stringify(answer)).not.toContain("synthetic-description");
      if (error === "ratelimited" || error === "service_unavailable") {
        expect(answer).toEqual({ kind: "transient" });
        expect(await store.has(credential)).toBe(true);
      } else {
        expect(answer).toMatchObject({
          kind: "sign-in-again",
          reason: error === "token_expired" ? "expired" : "revoked",
        });
        expect(await store.has(credential)).toBe(false);
      }
    } finally {
      await runtime.close();
    }
  });
  it("rejects a poisoned persisted profile without a refresh request", async () => {
    const initial = await exchangeAuthorizationCode(protocol().input);
    if (initial.kind !== "tokens") throw new Error("fixture exchange failed");
    const store = memoryStore();
    await store.set(
      credential,
      JSON.stringify({ ...initial.grant, mcpTransportUrl: "https://mcp.slack.com/other" }),
    );
    const { fetchImpl, calls } = protocol();
    const runtime = createHostOAuthRuntime({ store, fetch: fetchImpl, now: () => 5_000_000 });
    try {
      expect(await runtime.access(credential)).toEqual({ kind: "unavailable" });
      expect(calls).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });
  it("maps only the exact documented transport to its distinct OAuth origin", () => {
    expect(mcpOAuthResourceForTransport(slack.transportUrl)).toBe(slack.resource);
    for (const transport of [
      "https://generic.example/mcp",
      "https://mcp.slack.com/other",
      "https://mcp.slack.com/mcp?tools=all",
    ])
      expect(mcpOAuthResourceForTransport(transport)).toBe(transport);
  });
});
