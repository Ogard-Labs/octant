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
function fixture(
  timeoutMs = 2_000,
  hooks: {
    readonly set?: () => Promise<void>;
    readonly remove?: () => Promise<void>;
    readonly reply?: () => Promise<void>;
  } = {},
) {
  const values = new Map<string, string>();
  const store: CredentialStore = {
    set: async (id, value) => {
      await hooks.set?.();
      values.set(id, value);
    },
    has: async (id) => values.has(id),
    delete: async (id) => {
      await hooks.remove?.();
      values.delete(id);
    },
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
      await hooks.reply?.();
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
  const actorId = randomUUID();
  const started = await runtime.begin({
    descriptor: descriptor(port),
    actorId,
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
  return { started, actorId, authorization, path: `/oauth/callback?${params}`, params };
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

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function cancelInput(session: Awaited<ReturnType<typeof begin>>) {
  return {
    attemptId: session.started.attemptId,
    descriptorId: "slack-localhost-fixture",
    actorId: session.actorId,
  };
}
describe("host-owned pending MCP cancellation", () => {
  it("does not store a late token response after host close", async () => {
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    const { runtime, values } = fixture(2_000, {
      reply: async () => {
        entered.resolve();
        await release.promise;
      },
      set: async () => {
        writes++;
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      const response = callback("127.0.0.1", port, session.path).catch(() => 0);
      await entered.promise;
      await runtime.close();
      release.resolve();
      await response;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(0);
      expect(values.size).toBe(0);
      await released(port);
    } finally {
      release.resolve();
      await runtime.close();
    }
  });
  it("owns cleanup of a held grant write on host close while preserving a published grant", async () => {
    const entered = deferred();
    const release = deferred();
    let deletes = 0;
    const { runtime, values } = fixture(2_000, {
      set: async () => {
        entered.resolve();
        await release.promise;
      },
      remove: async () => {
        deletes++;
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      const response = callback("127.0.0.1", port, session.path).catch(() => 0);
      await entered.promise;
      let settled = false;
      const closing = runtime.close().then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(deletes).toBe(0);
      release.resolve();
      await closing;
      await response;
      expect(deletes).toBe(1);
      expect(values.size).toBe(0);
      await released(port);
    } finally {
      release.resolve();
      await runtime.close();
    }
    const completed = fixture();
    try {
      const session = await begin(completed.runtime, port);
      expect(await callback("127.0.0.1", port, session.path)).toBe(200);
      await completed.runtime.close();
      expect(completed.values.size).toBe(1);
    } finally {
      await completed.runtime.close();
    }
  });
  it("rejects another actor or descriptor and cancels only the owned attempt", async () => {
    const firstPort = await availablePort();
    const secondPort = await availablePort();
    const { runtime, forms } = fixture();
    try {
      const first = await begin(runtime, firstPort);
      const second = await begin(runtime, secondPort);
      expect(await runtime.cancel({ ...cancelInput(first), actorId: randomUUID() })).toEqual({
        kind: "refused",
      });
      expect(
        await runtime.cancel({ ...cancelInput(first), descriptorId: "another-descriptor" }),
      ).toEqual({ kind: "refused" });
      expect(await runtime.cancel(cancelInput(first))).toEqual({ kind: "cancelled" });
      await released(firstPort);
      expect(forms).toHaveLength(0);
      expect(await callback("::1", secondPort, second.path)).toBe(200);
      expect(forms).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });
  it("never stores a late successful token response after cancellation", async () => {
    const entered = deferred();
    const release = deferred();
    let writes = 0;
    const { runtime, values } = fixture(2_000, {
      reply: async () => {
        entered.resolve();
        await release.promise;
      },
      set: async () => {
        writes++;
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      const response = callback("127.0.0.1", port, session.path).catch(() => 0);
      await entered.promise;
      expect(await runtime.cancel(cancelInput(session))).toEqual({ kind: "cancelled" });
      release.resolve();
      await response;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writes).toBe(0);
      expect(values.size).toBe(0);
      await released(port);
    } finally {
      release.resolve();
      await runtime.close();
    }
  });
  it("waits for an already issued grant write before deleting that exact original grant", async () => {
    const entered = deferred();
    const release = deferred();
    let deletes = 0;
    const { runtime, values } = fixture(2_000, {
      set: async () => {
        entered.resolve();
        await release.promise;
      },
      remove: async () => {
        deletes++;
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      const response = callback("127.0.0.1", port, session.path).catch(() => 0);
      await entered.promise;
      let settled = false;
      const cancelling = runtime.cancel(cancelInput(session)).then((result) => {
        settled = true;
        return result;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(deletes).toBe(0);
      release.resolve();
      expect(await cancelling).toEqual({ kind: "cancelled" });
      await response;
      expect(deletes).toBe(1);
      expect(values.size).toBe(0);
      await released(port);
    } finally {
      release.resolve();
      await runtime.close();
    }
  });
  it("bounds cancellation wait while an original write is held and cleans only after that write settles", async () => {
    const entered = deferred();
    const release = deferred();
    let deletes = 0;
    const { runtime, values } = fixture(2_000, {
      set: async () => {
        entered.resolve();
        await release.promise;
      },
      remove: async () => {
        deletes++;
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      const response = callback("127.0.0.1", port, session.path).catch(() => 0);
      await entered.promise;
      expect(await runtime.cancel(cancelInput(session))).toEqual({ kind: "unavailable" });
      expect(deletes).toBe(0);
      release.resolve();
      await response;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(deletes).toBe(1);
      expect(values.size).toBe(0);
      expect(await runtime.cancel(cancelInput(session))).toEqual({ kind: "cancelled" });
    } finally {
      release.resolve();
      await runtime.close();
    }
  }, 15_000);
  it("keeps an unpolled completed grant owned when deletion fails and allows explicit cancellation retry", async () => {
    let fail = true;
    const { runtime, values } = fixture(2_000, {
      remove: async () => {
        if (fail) throw new CredentialStoreFailure("unavailable");
      },
    });
    const port = await availablePort();
    try {
      const session = await begin(runtime, port);
      expect(await callback("127.0.0.1", port, session.path)).toBe(200);
      expect(values.size).toBe(1);
      expect(await runtime.cancel(cancelInput(session))).toEqual({ kind: "unavailable" });
      expect(values.size).toBe(1);
      fail = false;
      expect(await runtime.cancel(cancelInput(session))).toEqual({ kind: "cancelled" });
      expect(values.size).toBe(0);
    } finally {
      await runtime.close();
    }
  });
});
