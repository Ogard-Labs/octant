import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostOAuthRuntime,
  CredentialStoreFailure,
  SLACK_MCP_USER_OAUTH as slack,
  type CredentialStore,
} from "@octant/host-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerSignIn } from "./mcpServerSignIn";

const extension = "44000000-0000-4000-8000-000000000002";
const component = "slack-fixture";
const credentialRef = "55000000-0000-4000-8000-000000000001";
const secretRef = "55000000-0000-4000-8000-000000000002";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function descriptor() {
  return {
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
    scopes: [slack.readScope],
    termsId: "mcp-terms-fixture",
    clientAuthentication: {
      method: "client_secret_post",
      secretRef,
      tokenEndpoint: slack.tokenEndpoint,
    },
  } as const;
}
function registration() {
  return {
    kind: "registered",
    clientId: "owned-fixture-client",
    resource: slack.resource,
    issuer: slack.issuer,
    redirectPort: 43125,
    clientAuthentication: descriptor().clientAuthentication,
  } as const;
}
function metadataFetch(
  options: {
    readonly transport?: string;
    readonly resource?: string;
    readonly issuer?: string;
    readonly authorization?: string;
    readonly token?: string;
    readonly scopes?: string[];
    readonly methods?: string[];
  } = {},
) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url === (options.transport ?? slack.transportUrl))
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${slack.resource}/.well-known/oauth-protected-resource"`,
          },
        });
      if (url === `${slack.resource}/.well-known/oauth-protected-resource`)
        return Response.json({
          resource: options.resource ?? slack.resource,
          authorization_servers: [slack.issuer],
          scopes_supported: options.scopes ?? ["chat:write", slack.readScope, "channels:history"],
        });
      if (url === `${slack.issuer}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: options.issuer ?? slack.issuer,
          authorization_endpoint: options.authorization ?? slack.authorizationEndpoint,
          token_endpoint: options.token ?? slack.tokenEndpoint,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: options.methods ?? ["client_secret_post"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          response_types_supported: ["code"],
        });
      throw new Error(`Unexpected fixture endpoint: ${url}`);
    },
    { preconnect: () => undefined },
  );
  return { fetchImpl, calls };
}
async function fixture(
  options: {
    readonly transport?: string;
    readonly metadata?: Parameters<typeof metadataFetch>[0];
    readonly access?: (credential: string) => Promise<unknown>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-slack-wire-"));
  directories.push(directory);
  const statePath = join(directory, "sign-ins.json");
  const oauth = { begin: vi.fn(), acknowledgeTerms: vi.fn(), status: vi.fn(), signOut: vi.fn() };
  const metadata = metadataFetch({
    ...options.metadata,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
  const access = vi.fn(options.access ?? (async () => ({ kind: "unavailable" })));
  const service = new McpServerSignIn({
    statePath,
    oauth: oauth as never,
    serverUrl: async () => options.transport ?? slack.transportUrl,
    fetch: metadata.fetchImpl,
    access,
    actorId: credentialRef,
    pickPort: async () => 43125,
  });
  return { service, statePath, oauth, access, calls: metadata.calls };
}

describe("closed Slack MCP transport and OAuth resource", () => {
  it("accepts the exact origin registration but refuses consent until the documented localhost callback is expressible", async () => {
    const { service, oauth, calls } = await fixture();
    expect(
      await service.configureForServer(extension, component, registration(), "local-window"),
    ).toEqual({ kind: "signed-out" });
    expect(await service.begin(extension, component, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
      message: expect.stringContaining("localhost callback"),
    });
    expect(oauth.begin).not.toHaveBeenCalled();
    expect(oauth.acknowledgeTerms).not.toHaveBeenCalled();
    expect(calls).not.toContain(slack.authorizationEndpoint);
    expect(calls).not.toContain(slack.tokenEndpoint);
  });
  it("does not infer support for public none or Basic from general PKCE documentation", async () => {
    const { service } = await fixture();
    const { clientAuthentication: _authentication, ...publicRegistration } = registration();
    expect(
      await service.configureForServer(extension, component, publicRegistration, "local-window"),
    ).toMatchObject({ kind: "refused", reason: "issuer-unsupported" });
    expect(
      await service.configureForServer(
        extension,
        component,
        {
          ...registration(),
          clientAuthentication: {
            ...registration().clientAuthentication,
            method: "client_secret_basic",
          },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "issuer-unsupported" });
  });
  it.each([
    { resource: slack.transportUrl },
    { issuer: "https://other.example" },
    { authorization: "https://slack.com/oauth/v2/authorize" },
    { token: "https://slack.com/api/oauth.v2.access" },
    { scopes: ["chat:write"] },
  ])(
    "refuses unreviewed metadata or missing selected read scope without consent",
    async (metadata) => {
      const { service, oauth } = await fixture({ metadata });
      await service.configureForServer(extension, component, registration(), "local-window");
      expect(await service.begin(extension, component, "local-window")).toMatchObject({
        kind: "refused",
        reason: "issuer-unsupported",
      });
      expect(oauth.begin).not.toHaveBeenCalled();
    },
  );
  it.each([
    slack.resource,
    "https://mcp.slack.com/other",
    "https://mcp.slack.com/mcp?tools=all",
    "https://other.example/mcp",
  ])("does not extend the origin resource alias to another transport (%s)", async (transport) => {
    const { service, oauth } = await fixture({ transport });
    expect(await service.begin(extension, component, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
    });
    expect(oauth.begin).not.toHaveBeenCalled();
  });
  it("runs real broker refresh interpretation through to the final exact-transport MCP Bearer header", async () => {
    const values = new Map<string, string>();
    const store: CredentialStore = {
      set: async (id, value) => void values.set(id, value),
      delete: async (id) => void values.delete(id),
      has: async (id) => values.has(id),
      resolve: async (id) => {
        const value = values.get(id);
        if (value === undefined) throw new CredentialStoreFailure("missing");
        return value;
      },
    };
    // This is a synthetic already-consented grant; no callback or live Slack acceptance is inferred.
    await store.set(
      credentialRef,
      JSON.stringify({
        kind: "host-oauth-grant",
        version: 1,
        accessToken: "synthetic-expired",
        refreshToken: "synthetic-refresh",
        tokenType: "Bearer",
        expiresAt: 0,
        scope: slack.readScope,
        generation: 1,
        clientId: "owned-fixture-client",
        dialect: slack.dialect,
        resource: slack.resource,
        mcpTransportUrl: slack.transportUrl,
        mcpIssuer: slack.issuer,
        tokenEndpoint: slack.tokenEndpoint,
        clientAuthentication: descriptor().clientAuthentication,
      }),
    );
    const requests: Array<{ url: string; form: URLSearchParams }> = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ url: String(input), form: new URLSearchParams(String(init?.body)) });
        return Response.json({
          ok: true,
          token_type: "user",
          access_token: "synthetic-refreshed",
          refresh_token: "synthetic-next-refresh",
          expires_in: 3600,
          scope: slack.readScope,
        });
      },
      { preconnect: () => undefined },
    );
    const runtime = createHostOAuthRuntime({
      store,
      fetch: fetchImpl,
      now: () => 1_000_000,
      resolveClientSecret: async (id) => {
        expect(id).toBe(secretRef);
        return "synthetic-client-secret";
      },
    });
    try {
      const { service, statePath, access } = await fixture({
        access: async (id) => {
          const refreshed = await runtime.refresh(id);
          return refreshed.kind === "refreshed" ? runtime.access(id) : refreshed;
        },
      });
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          signIns: {
            [`${extension}:${component}`]: {
              credentialRef,
              descriptor: descriptor(),
              issuer: "mcp.slack.com",
            },
          },
          registrations: {},
        }),
        { mode: 0o600 },
      );
      expect(
        await service.attachBearer(extension, component, {
          name: "slack-fixture",
          transport: "streamable-http",
          url: slack.transportUrl,
          headers: {},
        }),
      ).toMatchObject({ headers: { Authorization: "Bearer synthetic-refreshed" } });
      expect(requests[0]?.url).toBe(slack.tokenEndpoint);
      expect(requests[0]?.form.get("resource")).toBe(slack.resource);
      expect(requests[0]?.form.get("client_secret")).toBe("synthetic-client-secret");
      expect(JSON.parse(await store.resolve(credentialRef))).toMatchObject({
        dialect: slack.dialect,
        tokenType: "Bearer",
        mcpIssuer: slack.issuer,
        mcpTransportUrl: slack.transportUrl,
      });
      access.mockClear();
      for (const url of [
        slack.resource,
        "https://mcp.slack.com/other",
        "https://mcp.slack.com/mcp?tools=all",
        "https://other.example/mcp",
      ])
        expect(
          await service.attachBearer(extension, component, {
            name: "wrong-transport",
            transport: "streamable-http",
            url,
            headers: {},
          }),
        ).not.toHaveProperty("headers.Authorization");
      expect(access).not.toHaveBeenCalled();
      expect(await readFile(statePath, "utf8")).not.toContain("synthetic-client-secret");
    } finally {
      await runtime.close();
    }
  });
});
