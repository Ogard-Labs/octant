import { randomUUID } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { createHostOAuthRuntime, type HostOAuthDescriptor } from "./hostOAuth";
import { SLACK_MCP_USER_OAUTH as slack } from "./slackMcpOAuth";

async function listener(host: string, port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ...(host === "::1" ? { ipv6Only: true } : {}) }, resolve);
  });
  return server;
}
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
async function availablePort(): Promise<number> {
  const ipv4 = await listener("127.0.0.1");
  try {
    const port = (ipv4.address() as AddressInfo).port;
    const ipv6 = await listener("::1", port);
    await close(ipv6);
    return port;
  } finally {
    await close(ipv4);
  }
}
async function released(port: number): Promise<void> {
  for (const host of ["127.0.0.1", "::1"]) {
    const server = await listener(host, port);
    await close(server);
  }
}
function callback(
  host: string,
  port: number,
  path: string,
  authority = `localhost:${port}`,
  method = "GET",
): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { hostname: host, port, path, method, agent: false, headers: { host: authority } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}
function fixture(timeoutMs = 2_000) {
  const values = new Map<string, string>();
  const store: CredentialStore = {
    set: async (id, value) => void values.set(id, value),
    has: async (id) => values.has(id),
    delete: async (id) => void values.delete(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
  };
  const forms: URLSearchParams[] = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toBe(slack.tokenEndpoint);
      forms.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        ok: true,
        token_type: "user",
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
        scope: slack.readScope,
      });
    },
    { preconnect: () => undefined },
  );
  const runtime = createHostOAuthRuntime({
    store,
    timeoutMs,
    fetch: fetchImpl,
    resolveClientSecret: async () => "synthetic-client-secret",
  });
  return { runtime, values, forms };
}
function descriptor(port: number): HostOAuthDescriptor {
  return {
    descriptorId: "slack-localhost-fixture",
    clientId: "owned-fixture-client",
    dialect: slack.dialect,
    flow: "authorization-code-pkce",
    termsId: "mcp-terms-fixture",
    scopes: [slack.readScope],
    authorizationEndpoint: slack.authorizationEndpoint,
    tokenEndpoint: slack.tokenEndpoint,
    resource: slack.resource,
    mcpTransportUrl: slack.transportUrl,
    mcpIssuer: slack.issuer,
    redirectPort: port,
    redirectHostname: "localhost",
    clientAuthentication: {
      method: "client_secret_post",
      secretRef: "55000000-0000-4000-8000-000000000001",
      tokenEndpoint: slack.tokenEndpoint,
    },
  };
}
async function begin(runtime: ReturnType<typeof createHostOAuthRuntime>, port: number) {
  const started = await runtime.begin({
    descriptor: descriptor(port),
    actorId: randomUUID(),
    termsAcknowledgedAt: "2026-11-02T00:00:00.000Z",
  });
  expect(started.kind).toBe("awaiting-consent");
  if (started.kind !== "awaiting-consent" || started.flow !== "authorization-code-pkce")
    throw new Error("Callback was not offered");
  const authorization = new URL(started.authorizationUrl);
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    `http://localhost:${port}/oauth/callback`,
  );
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("scope")).toBe(slack.readScope);
  const params = new URLSearchParams({
    code: "synthetic-code",
    state: authorization.searchParams.get("state") ?? "",
    iss: slack.issuer,
  });
  return { started, authorization, path: `/oauth/callback?${params}`, params };
}

describe("Slack retained localhost callback", () => {
  it("closes a callback bind that completes after the host was closed", async () => {
    const port = await availablePort();
    const { runtime, forms } = fixture();
    const pending = runtime.begin({
      descriptor: descriptor(port),
      actorId: randomUUID(),
      termsAcknowledgedAt: "2026-11-02T00:00:00.000Z",
    });
    await runtime.close();
    expect(await pending).toEqual({ kind: "refused", reason: "unavailable" });
    expect(forms).toHaveLength(0);
    await released(port);
  });
  it.each(["127.0.0.1", "::1"])(
    "accepts localhost authority through %s and retains the exact exchange binding",
    async (host) => {
      const port = await availablePort();
      const { runtime, forms, values } = fixture();
      try {
        const { started, path } = await begin(runtime, port);
        expect(await callback(host, port, path)).toBe(200);
        const state = runtime.status(started.attemptId);
        expect(state.kind).toBe("signed-in");
        expect(forms[0]?.get("redirect_uri")).toBe(`http://localhost:${port}/oauth/callback`);
        expect(forms[0]?.get("resource")).toBe(slack.resource);
        expect(forms[0]?.get("client_secret")).toBe("synthetic-client-secret");
        expect(forms[0]?.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
        if (state.kind !== "signed-in") return;
        expect(JSON.parse(values.get(state.credentialRef) ?? "{}")).toMatchObject({
          dialect: slack.dialect,
          mcpIssuer: slack.issuer,
          mcpTransportUrl: slack.transportUrl,
          tokenType: "Bearer",
        });
        expect(await runtime.refresh(state.credentialRef)).toEqual({ kind: "refreshed" });
        expect(await runtime.access(state.credentialRef)).toMatchObject({
          kind: "granted",
          tokenType: "Bearer",
        });
        await released(port);
      } finally {
        await runtime.close();
      }
    },
  );
  it.each(["127.0.0.1", "::1"])(
    "refuses an occupied %s port and releases any partial callback bind",
    async (host) => {
      const port = await availablePort();
      const occupied = await listener(host, port);
      const { runtime, forms } = fixture();
      try {
        expect(
          await runtime.begin({
            descriptor: descriptor(port),
            actorId: randomUUID(),
            termsAcknowledgedAt: "2026-11-02T00:00:00.000Z",
          }),
        ).toEqual({ kind: "refused", reason: "unavailable" });
        expect(forms).toHaveLength(0);
      } finally {
        await close(occupied);
        await runtime.close();
      }
      await released(port);
    },
  );
  it("rejects another host, port, request authority, method and path without consuming the valid attempt", async () => {
    const port = await availablePort();
    const { runtime, forms } = fixture();
    try {
      const { started, path } = await begin(runtime, port);
      for (const authority of [
        `127.0.0.1:${port}`,
        `other.example:${port}`,
        `localhost:${port + 1}`,
      ])
        expect(await callback("127.0.0.1", port, path, authority)).toBe(400);
      expect(await callback("127.0.0.1", port, `http://other.example:${port}${path}`)).toBe(400);
      expect(await callback("127.0.0.1", port, path, `localhost:${port}`, "POST")).toBe(404);
      // request(options.path) sends these raw targets without URL normalization.
      expect(await callback("127.0.0.1", port, `/\\other.example${path}`)).toBe(400);
      expect(await callback("127.0.0.1", port, `//other.example${path}`)).toBe(400);
      expect(await callback("127.0.0.1", port, "/wrong")).toBe(404);
      expect(forms).toHaveLength(0);
      expect(runtime.status(started.attemptId).kind).toBe("awaiting-consent");
      expect(await callback("::1", port, path)).toBe(200);
      expect(forms).toHaveLength(1);
    } finally {
      await runtime.close();
    }
    await released(port);
  });
  it.each(["state", "issuer", "denied"])(
    "refuses %s before exchange and closes both families",
    async (reason) => {
      const port = await availablePort();
      const { runtime, forms } = fixture();
      try {
        const { started, params } = await begin(runtime, port);
        if (reason === "state") params.set("state", "wrong-state");
        if (reason === "issuer") params.set("iss", "https://other.example");
        if (reason === "denied") params.set("error", "access_denied");
        expect(await callback("127.0.0.1", port, `/oauth/callback?${params}`)).toBe(400);
        expect(runtime.status(started.attemptId)).toMatchObject({
          kind: "refused",
          reason:
            reason === "state"
              ? "state-mismatch"
              : reason === "issuer"
                ? "exchange-refused"
                : "denied",
        });
        expect(forms).toHaveLength(0);
      } finally {
        await runtime.close();
      }
      await released(port);
    },
  );
  it("releases both listeners at timeout and reuses the retained port on an explicit restart", async () => {
    const port = await availablePort();
    const first = fixture(30);
    try {
      const { started } = await begin(first.runtime, port);
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(first.runtime.status(started.attemptId)).toMatchObject({
        kind: "refused",
        reason: "timeout",
      });
      await released(port);
    } finally {
      await first.runtime.close();
    }
    const second = fixture();
    try {
      await begin(second.runtime, port);
    } finally {
      await second.runtime.close();
    }
    await released(port);
  });
});
