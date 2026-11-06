import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { decodeExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { AGENT_PLUGINS_MCP_SCHEMA } from "@octant/plugin-host/agent-plugins";
import { AgentPluginMcpSessionManager } from "./agentPluginMcpSessionManager";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import {
  createHostOAuthRuntime,
  CredentialStoreFailure,
  SLACK_MCP_USER_OAUTH as slack,
  type CredentialStore,
} from "@octant/host-runtime";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { createHostOAuthService } from "../providers/oauth/hostOAuthService";
import { McpServerSignIn } from "./mcpServerSignIn";

const extension = "44000000-0000-4000-8000-000000000002";
const component = "slack-fixture";
const credentialRef = "55000000-0000-4000-8000-000000000001";
const siblingRef = "55000000-0000-4000-8000-000000000003";
const secretRef = "55000000-0000-4000-8000-000000000002";
const descriptor = decodeHostOAuthDescriptor({
  descriptorId: "slack-user-fixture",
  clientId: "owned-fixture-client",
  dialect: slack.dialect,
  flow: "authorization-code-pkce",
  authorizationEndpoint: slack.authorizationEndpoint,
  tokenEndpoint: slack.tokenEndpoint,
  resource: slack.resource,
  mcpIssuer: slack.issuer,
  mcpTransportUrl: slack.transportUrl,
  redirectPort: 43125,
  redirectHostname: "localhost",
  scopes: [slack.readScope],
  termsId: "mcp-terms-fixture",
  clientAuthentication: {
    method: "client_secret_post",
    secretRef,
    tokenEndpoint: slack.tokenEndpoint,
  },
});
function grant() {
  return {
    kind: "host-oauth-grant",
    version: 1,
    accessToken: "synthetic-old-access",
    refreshToken: "synthetic-refresh",
    tokenType: "Bearer",
    expiresAt: 999_999,
    scope: slack.readScope,
    clientId: descriptor.clientId,
    tokenEndpoint: slack.tokenEndpoint,
    generation: 1,
    dialect: slack.dialect,
    resource: slack.resource,
    mcpIssuer: slack.issuer,
    mcpTransportUrl: slack.transportUrl,
    clientAuthentication: descriptor.clientAuthentication,
  };
}

const activation = {
  installed: true,
  trusted: true,
  pluginDesired: true,
  componentDesired: true,
  compatible: true,
  policyAllowed: true,
  quarantined: false,
  draining: false,
  broken: false,
  unavailable: false,
  interrupted: false,
  waiting: false,
};
function effective(component = "mcp-remote", threadId = "17000000-0000-4000-8000-000000000099") {
  return decodeExtensionEffectiveSnapshot({
    sequence: 1,
    snapshotAt: "2026-11-02T00:00:00.000Z",
    scope: {
      hostId: "local",
      mode: "chat",
      projectId: null,
      threadId,
      providerFamily: "openai-compatible",
    },
    catalogEpoch: `sha256:${"a".repeat(64)}`,
    catalogStatus: "available",
    stale: false,
    packages: [
      {
        extensionId: extension,
        packageId: "15000000-0000-4000-8000-000000000002",
        slug: "remote",
        displayName: "Remote",
        stateVersion: 1,
        version: "1.0.0",
        digest: `sha256:${"c".repeat(64)}`,
        source: { kind: "local-folder", sourceRef: "local-test" },
        compatibility: { platforms: ["linux"], modes: ["chat"], providerFamilies: [] },
        activation,
        diagnostics: [],
        components: [
          {
            component: {
              id: component,
              kind: "mcp-server",
              displayName: "remote",
              declaredCapabilities: ["mcp"],
              entryPoint: "mcp.json",
            },
            effectiveState: { kind: "effective" },
            activation,
            policy: {
              revision: 1,
              projectRevision: 1,
              threadRevision: 1,
              hostAllowed: true,
              modeAllowed: true,
              projectAllowed: true,
              threadAllowed: true,
              policyAllowed: true,
            },
            contextContribution: { kind: "zero", reason: "not-selected" },
          },
        ],
      },
    ],
    collisions: [],
  });
}

describe("MCP refresh and completed sign-out ownership", () => {
  it.each(["complete", "unknown-restart", "delete-retry", "delete-missing"])(
    "joins the real runtime held refresh write before deletion (%s)",
    async (completion) => {
      const directory = await mkdtemp(join(tmpdir(), "octant-mcp-refresh-cleanup-"));
      const values = new Map([
        [credentialRef, JSON.stringify(grant())],
        [siblingRef, JSON.stringify(grant())],
      ]);
      const enteredWrite = Promise.withResolvers<void>();
      const releaseWrite = Promise.withResolvers<void>();
      const enteredCleanup = Promise.withResolvers<void>();
      let failDelete = completion === "delete-retry";
      const store: CredentialStore = {
        has: async (id) => values.has(id),
        resolve: async (id) => {
          const value = values.get(id);
          if (value === undefined) throw new CredentialStoreFailure("missing");
          return value;
        },
        delete: async (id) => {
          if (id === credentialRef && failDelete) {
            failDelete = false;
            throw new CredentialStoreFailure("unavailable");
          }
          values.delete(id);
          if (id === credentialRef && completion === "delete-missing")
            throw new CredentialStoreFailure("missing");
        },
        set: async (id, value) => {
          if (id === credentialRef) {
            enteredWrite.resolve();
            await releaseWrite.promise;
          }
          values.set(id, value);
        },
      };
      const tokenCalls: URLSearchParams[] = [];
      const tokenFetch: typeof fetch = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          tokenCalls.push(new URLSearchParams(String(init?.body)));
          return Response.json({
            ok: true,
            access_token: "synthetic-new-access",
            token_type: "user",
            refresh_token: "synthetic-next-refresh",
            expires_in: 3600,
          });
        },
        { preconnect: () => undefined },
      );
      const runtime = createHostOAuthRuntime({
        store,
        fetch: tokenFetch,
        now: () => 1_000_000,
        resolveClientSecret: async () => "synthetic-owned-secret",
      });
      const broker = makeHostOAuthBrokerClient({
        url: "http://127.0.0.1:9",
        token: "synthetic-broker-token",
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname === "/v1/credentials/delete") {
            enteredCleanup.resolve();
            const body = JSON.parse(String(init?.body));
            await store.delete(body.providerInstanceId);
            return Response.json({ kind: "deleted" });
          }
          const body = JSON.parse(String(init?.body));
          if (url.pathname === "/v1/oauth/revoke") {
            enteredCleanup.resolve();
            return Response.json(await runtime.revoke(body.credentialRef));
          }
          if (url.pathname === "/v1/oauth/refresh")
            return Response.json(await runtime.refresh(body.credentialRef));
          if (url.pathname === "/v1/oauth/access")
            return Response.json(await runtime.access(body.credentialRef));
          return new Response(null, { status: 404 });
        },
      });
      const oauth = createHostOAuthService({ journal: { append: () => undefined }, broker });
      const statePath = join(directory, "sign-ins.json");
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          signIns: {
            [`${extension}:${component}`]: { descriptor, issuer: slack.issuer, credentialRef },
          },
        }),
      );
      const service = new McpServerSignIn({
        statePath,
        oauth,
        access: (ref) => broker.access(ref),
        refresh: (ref) => broker.refresh(ref),
        serverUrl: async () => slack.transportUrl,
        actorId: "66000000-0000-4000-8000-000000000001",
      });
      const refreshing = broker.refresh(credentialRef);
      let signingOut: ReturnType<typeof service.signOut> | undefined;
      try {
        await enteredWrite.promise;
        if (completion === "unknown-restart") vi.useFakeTimers();
        signingOut = service.signOut(extension, component, "local-window");
        await enteredCleanup.promise;
        await Promise.resolve();
        expect(values.has(credentialRef)).toBe(true);
        expect(await runtime.access(credentialRef)).toEqual({ kind: "unavailable" });
        expect(await runtime.access(siblingRef)).toMatchObject({ kind: "granted" });
        if (completion === "unknown-restart") {
          await vi.advanceTimersByTimeAsync(10_001);
          expect(await signingOut).toMatchObject({ kind: "sign-out-pending" });
          vi.useRealTimers();
          const restarted = new McpServerSignIn({
            statePath,
            oauth,
            access: (ref) => broker.access(ref),
            refresh: (ref) => broker.refresh(ref),
            serverUrl: async () => slack.transportUrl,
            actorId: siblingRef,
          });
          expect(await restarted.status(extension, component, "local-window")).toMatchObject({
            kind: "sign-out-pending",
          });
          releaseWrite.resolve();
          await refreshing;
          await setImmediate();
          expect(await restarted.status(extension, component, "local-window")).toMatchObject({
            kind: "sign-out-pending",
          });
          expect(await restarted.signOut(extension, component, "local-window")).toEqual({
            kind: "signed-out",
          });
        } else {
          releaseWrite.resolve();
          await refreshing;
          if (completion === "delete-retry") {
            expect(await signingOut).toMatchObject({ kind: "sign-out-pending" });
            expect(await runtime.access(credentialRef)).toEqual({ kind: "unavailable" });
            expect(await runtime.refresh(credentialRef)).toEqual({ kind: "unavailable" });
            expect(await runtime.access(siblingRef)).toMatchObject({ kind: "granted" });
            expect(await service.signOut(extension, component, "local-window")).toEqual({
              kind: "signed-out",
            });
          } else expect(await signingOut).toEqual({ kind: "signed-out" });
        }
        expect(values.has(credentialRef)).toBe(false);
        expect(values.has(siblingRef)).toBe(true);
        expect(tokenCalls).toHaveLength(1);
        expect(tokenCalls[0]?.get("client_id")).toBe(descriptor.clientId);
        expect(tokenCalls[0]?.get("resource")).toBe(slack.resource);
        expect(tokenCalls[0]?.get("client_secret")).toBe("synthetic-owned-secret");
      } finally {
        vi.useRealTimers();
        releaseWrite.resolve();
        await refreshing;
        await signingOut;
        await runtime.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("refreshes the actual retained expired grant before attaching a current bearer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-mcp-expired-access-"));
    const values = new Map([[credentialRef, JSON.stringify(grant())]]);
    const store: CredentialStore = {
      has: async (id) => values.has(id),
      resolve: async (id) => {
        const value = values.get(id);
        if (value === undefined) throw new CredentialStoreFailure("missing");
        return value;
      },
      delete: async (id) => {
        values.delete(id);
      },
      set: async (id, value) => {
        values.set(id, value);
      },
    };
    const tokenCalls: URLSearchParams[] = [];
    const tokenFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        tokenCalls.push(new URLSearchParams(String(init?.body)));
        return Response.json({
          ok: true,
          access_token: "synthetic-new-access",
          token_type: "user",
          refresh_token: "synthetic-next-refresh",
          expires_in: 3600,
        });
      },
      { preconnect: () => undefined },
    );
    const runtime = createHostOAuthRuntime({
      store,
      fetch: tokenFetch,
      now: () => Date.now(),
      resolveClientSecret: async () => "synthetic-owned-secret",
    });
    const broker = makeHostOAuthBrokerClient({
      url: "http://127.0.0.1:9",
      token: "synthetic-broker-token",
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body));
        if (path === "/v1/oauth/refresh")
          return Response.json(await runtime.refresh(body.credentialRef));
        if (path === "/v1/oauth/access")
          return Response.json(await runtime.access(body.credentialRef));
        return new Response(null, { status: 404 });
      },
    });
    const oauth = createHostOAuthService({ journal: { append: () => undefined }, broker });
    const statePath = join(directory, "sign-ins.json");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        signIns: {
          [`${extension}:${component}`]: { descriptor, issuer: slack.issuer, credentialRef },
        },
      }),
    );
    const service = new McpServerSignIn({
      statePath,
      oauth,
      access: (ref) => broker.access(ref),
      refresh: (ref) => broker.refresh(ref),
      serverUrl: async () => slack.transportUrl,
      actorId: "66000000-0000-4000-8000-000000000001",
    });
    try {
      const launch = {
        transport: "streamable-http",
        name: "slack",
        url: slack.transportUrl,
        headers: {},
      } as const;
      expect(await service.attachBearer(extension, component, launch)).toMatchObject({
        headers: { Authorization: "Bearer synthetic-new-access" },
      });
      expect(tokenCalls).toHaveLength(1);
      expect(tokenCalls[0]?.get("resource")).toBe(slack.resource);
      expect(tokenCalls[0]?.get("client_id")).toBe(descriptor.clientId);
      expect(tokenCalls[0]?.get("client_secret")).toBe("synthetic-owned-secret");
    } finally {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("refreshes before approved dispatch, reconciles changed headers, and never replays a401 call", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-mcp-task-refresh-"));
    let now = 1_000_000;
    let tokenCalls = 0;
    let initializations = 0;
    let rejectNext = false;
    const headers: string[] = [];
    const refreshForms: URLSearchParams[] = [];
    const values = new Map([[credentialRef, JSON.stringify({ ...grant(), expiresAt: 2_000_000 })]]);
    const store: CredentialStore = {
      has: async (id) => values.has(id),
      resolve: async (id) => {
        const value = values.get(id);
        if (value === undefined) throw new CredentialStoreFailure("missing");
        return value;
      },
      delete: async (id) => {
        values.delete(id);
      },
      set: async (id, value) => {
        values.set(id, value);
      },
    };
    const tokenFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(slack.tokenEndpoint);
        refreshForms.push(new URLSearchParams(String(init?.body)));
        tokenCalls++;
        return Response.json({
          ok: true,
          access_token: `synthetic-refreshed-${tokenCalls}`,
          token_type: "user",
          refresh_token: `synthetic-refresh-${tokenCalls}`,
          expires_in: 3600,
        });
      },
      { preconnect: () => undefined },
    );
    const runtime = createHostOAuthRuntime({
      store,
      fetch: tokenFetch,
      now: () => now,
      resolveClientSecret: async (id) => {
        expect(id).toBe(secretRef);
        return "synthetic-owned-secret";
      },
    });
    const statePath = join(directory, "sign-ins.json");
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        signIns: {
          [`${extension}:${component}`]: { descriptor, issuer: slack.issuer, credentialRef },
        },
      }),
    );
    const oauth = createHostOAuthService({
      journal: { append: () => undefined },
      broker: makeHostOAuthBrokerClient({
        url: "http://127.0.0.1:9",
        token: "synthetic-broker-token",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          const body = JSON.parse(String(init?.body));
          return Response.json(
            path === "/v1/oauth/revoke"
              ? await runtime.revoke(body.credentialRef)
              : { kind: "unavailable" },
          );
        },
      }),
    });
    const service = new McpServerSignIn({
      statePath,
      oauth,
      access: (ref) => runtime.access(ref),
      refresh: (ref) => runtime.refresh(ref),
      now: () => new Date(now),
      serverUrl: async () => slack.transportUrl,
      actorId: siblingRef,
      onAuthenticationChanged: (extensionId, componentId) =>
        manager.invalidateAuthentication(extensionId, componentId),
    });
    const mcpFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(slack.transportUrl);
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "initialize") initializations++;
        if (body.method === "tools/call") {
          headers.push(new Headers(init?.headers).get("authorization") ?? "");
          if (rejectNext) {
            rejectNext = false;
            return new Response(null, { status: 401 });
          }
        }
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? {
                  protocolVersion: "2025-03-26",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                }
              : body.method === "tools/list"
                ? { tools: [{ name: "lookup_public", inputSchema: { type: "object" } }] }
                : { content: [{ type: "text", text: "Synthetic public result" }] },
        });
      },
      { preconnect: () => undefined },
    );
    const approval = vi.fn(async () => true);
    const manager = new AgentPluginMcpSessionManager({
      store: {
        contentRoot: () => "/tmp/plugin",
        pluginDataRoot: () => "/tmp/plugin-data",
        readVerifiedConfiguration: async () =>
          JSON.stringify({
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: { remote: { type: "streamable-http", url: slack.transportUrl } },
          }),
      },
      fetch: mcpFetch,
      isUserAddedSource: () => true,
      authorizeToolCall: approval,
      resolveUserAddedSecrets: (launch) => service.attachBearer(extension, component, launch),
      bindUserAddedAuthentication: (launch) =>
        service.bindAuthentication(extension, component, launch),
      recordExternalContentIngestion: () => ({
        kind: "recorded",
        taint: { externalContentIngested: true, ingestedSources: ["mcp-tool"] },
      }),
    });
    const state = effective(component);
    const port = manager.createToolExecutionPort();
    const execute = () => {
      const name = manager.toolDefinitions()[0]?.name;
      if (name === undefined) throw new Error("Expected discovered tool");
      return port.execute({ thread: { id: String(state.scope.threadId) }, name, inputJson: "{}" });
    };
    try {
      await manager.reconcile(state);
      expect(initializations).toBe(1);
      await service.configureForServer(
        extension,
        component,
        {
          kind: "registered",
          clientId: "replacement-setup-client",
          resource: slack.resource,
          issuer: slack.issuer,
          redirectPort: 43125,
          redirectHostname: "localhost",
          clientAuthentication: descriptor.clientAuthentication,
        },
        "local-window",
      );
      now = 2_000_001;
      expect(await execute()).toMatchObject({
        isError: true,
        result: { error: expect.stringContaining("no tool call was sent") },
      });
      expect(headers).toEqual([]);
      expect(tokenCalls).toBe(1);
      expect(initializations).toBe(1);
      expect(manager.toolDefinitions()).toEqual([]);
      await manager.reconcile(state);
      expect((await execute()).isError).not.toBe(true);
      expect(headers).toEqual(["Bearer synthetic-refreshed-1"]);
      rejectNext = true;
      expect(await execute()).toMatchObject({
        isError: true,
        result: { error: expect.stringContaining("not replayed") },
      });
      expect(headers).toEqual(["Bearer synthetic-refreshed-1", "Bearer synthetic-refreshed-1"]);
      expect(manager.toolDefinitions()).toEqual([]);
      expect(tokenCalls).toBe(1);
      await manager.reconcile(state);
      expect(tokenCalls).toBe(2);
      expect((await execute()).isError).not.toBe(true);
      expect(headers).toEqual([
        "Bearer synthetic-refreshed-1",
        "Bearer synthetic-refreshed-1",
        "Bearer synthetic-refreshed-2",
      ]);
      expect(approval).toHaveBeenCalledTimes(4);
      for (const form of refreshForms) {
        expect(form.get("client_id")).toBe(descriptor.clientId);
        expect(form.get("resource")).toBe(slack.resource);
        expect(form.get("client_secret")).toBe("synthetic-owned-secret");
      }
    } finally {
      await manager.drainAll();
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
