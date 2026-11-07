import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GITHUB_MCP_OAUTH_APP as github } from "@octant/host-runtime";
import {
  decodeHostOAuthDescriptor,
  decodeMcpOAuthClientRegistration,
} from "@octant/contracts/host-oauth";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { createHostOAuthService } from "../providers/oauth/hostOAuthService";
import { McpServerSignIn, type McpServerSignInOptions } from "./mcpServerSignIn";

const extension = "44000000-0000-4000-8000-000000000002";
const component = "github-fixture";
const credentialRef = "55000000-0000-4000-8000-000000000001";
const secretRef = "55000000-0000-4000-8000-000000000002";
const attemptId = "55000000-0000-4000-8000-000000000003";
const resourceMetadata = "https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/";
const issuerMetadata = "https://github.com/.well-known/oauth-authorization-server/login/oauth";
const descriptor = decodeHostOAuthDescriptor({
  descriptorId: "github-read-fixture",
  clientId: "owned-fixture-client",
  dialect: github.dialect,
  flow: "authorization-code-pkce",
  authorizationEndpoint: github.authorizationEndpoint,
  tokenEndpoint: github.tokenEndpoint,
  resource: github.resource,
  mcpIssuer: github.issuer,
  mcpTransportUrl: github.transportUrl,
  redirectPort: 43125,
  scopes: [github.readScope, github.rotationScope],
  termsId: "mcp-sign-in-terms-1",
  clientAuthentication: {
    method: "client_secret_post",
    secretRef,
    tokenEndpoint: github.tokenEndpoint,
  },
});
const registration = decodeMcpOAuthClientRegistration({
  kind: "registered",
  clientId: descriptor.clientId,
  resource: github.resource,
  issuer: github.issuer,
  redirectPort: 43125,
  clientAuthentication: descriptor.clientAuthentication,
});
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(
  options: {
    readonly resource?: Record<string, unknown>;
    readonly issuer?: Record<string, unknown>;
    readonly accessAccount?: unknown;
    readonly complete?: boolean;
    readonly profile?: "github-repositories-read-write";
    readonly accessProfile?: "github-repositories-read-write" | "legacy";
    readonly policyOwner?: () => number;
    readonly policyCurrent?: () => boolean;
    readonly policyUnavailable?: boolean;
    readonly holdMetadata?: { readonly entered: () => void; readonly held: Promise<void> };
    readonly linkedSecrets?: McpServerSignInOptions["linkedSecrets"];
    readonly replaceState?: McpServerSignInOptions["replaceState"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-github-profile-"));
  directories.push(directory);
  const statePath = join(directory, "sign-ins.json");
  const metadataCalls: string[] = [];
  const brokerCalls: Array<{ readonly path: string; readonly body: Record<string, unknown> }> = [];
  const journal: unknown[] = [];
  const broker = makeHostOAuthBrokerClient({
    url: "http://127.0.0.1:9999",
    token: "synthetic-broker-token",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      brokerCalls.push({ path, body });
      if (path.endsWith("/begin"))
        return Response.json({
          kind: "awaiting-consent",
          flow: "authorization-code-pkce",
          attemptId,
          descriptorId: (body.descriptor as Record<string, unknown>).descriptorId,
          authorizationUrl: `${github.authorizationEndpoint}?state=synthetic`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        });
      if (options.complete && path.endsWith("/status")) {
        const begun = brokerCalls.find((call) => call.path.endsWith("/begin"));
        const sentDescriptor = begun?.body.descriptor as Record<string, unknown>;
        return Response.json({
          kind: "signed-in",
          attemptId,
          descriptorId: sentDescriptor.descriptorId,
          credentialRef,
        });
      }
      return Response.json({ kind: "unknown" });
    },
  });
  const oauth = createHostOAuthService({
    broker,
    journal: { append: (record) => journal.push(record) },
  });
  const fetchPort = new Proxy(globalThis.fetch, {
    apply: async (_target, _receiver, args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      metadataCalls.push(url);
      if (url === github.transportUrl)
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": `Bearer resource_metadata="${resourceMetadata}"` },
        });
      if (url === resourceMetadata)
        return Response.json({
          resource: github.resource,
          authorization_servers: [github.issuer],
          scopes_supported: ["repo", "user:email", github.readScope],
          ...options.resource,
        });
      if (url === issuerMetadata) {
        options.holdMetadata?.entered();
        await options.holdMetadata?.held;
        return Response.json({
          issuer: github.issuer,
          authorization_endpoint: github.authorizationEndpoint,
          token_endpoint: github.tokenEndpoint,
          scopes_supported: [github.rotationScope],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          ...options.issuer,
        });
      }
      throw new Error(`Unexpected fixture address ${url}`);
    },
  });
  const service = new McpServerSignIn({
    statePath,
    oauth,
    actorId: credentialRef,
    fetch: fetchPort,
    pickPort: async () => 43125,
    serverUrl: async () => github.transportUrl,
    serverPolicy: async () => {
      if (options.policyUnavailable) return undefined;
      const owner = options.policyOwner?.();
      return {
        url: github.transportUrl,
        ...(options.profile === undefined ? {} : { mcpPermissionProfile: options.profile }),
        current: () => owner === options.policyOwner?.() && options.policyCurrent?.() !== false,
      };
    },
    ...(options.linkedSecrets === undefined ? {} : { linkedSecrets: options.linkedSecrets }),
    ...(options.replaceState === undefined ? {} : { replaceState: options.replaceState }),
    access: async () => ({
      ...(options.accessProfile === "legacy" ||
      (options.accessProfile === undefined && options.profile === undefined)
        ? {}
        : { mcpPermissionProfile: options.accessProfile ?? options.profile }),
      kind: "granted",
      accessToken: "synthetic-bearer",
      tokenType: "Bearer",
      mcpAccount: options.accessAccount ?? {
        userId: "12345",
        grantedScopes: [github.readScope, ...(options.profile === undefined ? [] : ["repo"])],
      },
    }),
  });
  return { service, statePath, metadataCalls, brokerCalls, journal, oauth };
}

describe("registered GitHub OAuth App read setup", () => {
  it("reports setup without probing and forwards only the reviewed app descriptor through both production serializers", async () => {
    const { service, metadataCalls, brokerCalls, journal } = await fixture();
    expect(await service.status(extension, component, "local-window")).toMatchObject({
      kind: "client-setup-required",
    });
    expect(metadataCalls).toEqual([]);
    expect(brokerCalls).toEqual([]);
    const prepared = await service.prepareClient(extension, component, "local-window");
    expect(prepared).toMatchObject({
      kind: "client-setup",
      callback: "http://127.0.0.1:43125/oauth/callback",
      authenticationMethods: ["client_secret_post"],
      metadataClientSupported: false,
    });
    expect(
      await service.configureForServer(extension, component, registration, "local-window"),
    ).toEqual({ kind: "signed-out" });
    expect(brokerCalls).toEqual([]);
    expect(await service.begin(extension, component, "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    const actual = brokerCalls.find((call) => call.path.endsWith("/begin"));
    expect(actual?.body.descriptor).toMatchObject({
      dialect: github.dialect,
      resource: github.resource,
      mcpTransportUrl: github.transportUrl,
      mcpIssuer: github.issuer,
      authorizationEndpoint: github.authorizationEndpoint,
      tokenEndpoint: github.tokenEndpoint,
      scopes: [github.readScope, github.rotationScope],
      redirectPort: 43125,
      clientAuthentication: registration.clientAuthentication,
    });
    expect(actual?.body.descriptor).not.toHaveProperty("redirectHostname");
    expect(JSON.stringify(journal)).not.toContain(secretRef);
  });
  it("collects and persists broker-verified identity after consent before reporting the connected account", async () => {
    const { service, statePath } = await fixture({ complete: true });
    await service.configureForServer(extension, component, registration, "local-window");
    const started = await service.begin(extension, component, "local-window");
    if (started.kind !== "awaiting-consent") throw new Error("Expected consent");
    expect(await service.poll(extension, component, started.attemptId, "local-window")).toEqual({
      kind: "signed-in",
      issuer: "github.com",
      account: { userId: "12345", grantedScopes: [github.readScope] },
    });
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).toContain('"userId":"12345"');
    expect(persisted).not.toContain("synthetic-bearer");
  });
  it.each([
    { issuer: { issuer: "https://github.com/login/oauth/" } },
    { issuer: { authorization_endpoint: "https://other.example/authorize" } },
    { issuer: { token_endpoint: "https://other.example/token" } },
    { issuer: { scopes_supported: ["repo"] } },
    { issuer: { code_challenge_methods_supported: [] } },
    { issuer: { authorization_response_iss_parameter_supported: false } },
    { issuer: { token_endpoint_auth_methods_supported: ["none"] } },
    { resource: { resource: "https://api.githubcopilot.com/" } },
    { resource: { scopes_supported: ["repo"] } },
  ])("refuses incompatible discovery before starting consent: %j", async (change) => {
    const { service, brokerCalls } = await fixture(change);
    expect(await service.prepareClient(extension, component, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
    });
    expect(brokerCalls).toEqual([]);
  });
  it.each([
    { kind: "registered", clientAuthentication: undefined },
    { issuer: "https://other.example" },
    {
      clientAuthentication: { ...registration.clientAuthentication, method: "client_secret_basic" },
    },
  ])("refuses app setup incompatible with the closed profile: %j", async (change) => {
    const { service } = await fixture();
    expect(
      await service.configureForServer(
        extension,
        component,
        decodeMcpOAuthClientRegistration({ ...registration, ...change }),
        "local-window",
      ),
    ).toMatchObject({ kind: "refused" });
  });
  it("rejects a localhost callback at the public registration decoder", () => {
    expect(() =>
      decodeMcpOAuthClientRegistration({ ...registration, redirectHostname: "localhost" }),
    ).toThrow();
  });
  it("refuses remote setup and consent without discovery or broker access", async () => {
    const { service, metadataCalls, brokerCalls } = await fixture();
    expect(await service.prepareClient(extension, component, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(
      await service.configureForServer(extension, component, registration, "remote-device"),
    ).toMatchObject({ kind: "refused", reason: "local-host-required" });
    expect(await service.begin(extension, component, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(metadataCalls).toEqual([]);
    expect(brokerCalls).toEqual([]);
  });
  it.each([
    { userId: "99999", grantedScopes: [github.readScope], reason: "account-changed" },
    { userId: "12345", grantedScopes: [github.readScope, "repo"], reason: "permission-mismatch" },
    { userId: "12345", grantedScopes: [], reason: "permission-missing" },
  ])(
    "durably retires a changed account observation before bearer attachment: $reason",
    async ({ reason, ...account }) => {
      const { service, statePath, oauth } = await fixture({ accessAccount: account });
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          signIns: {
            [`${extension}:${component}`]: {
              credentialRef,
              descriptor,
              issuer: github.issuer,
              account: { userId: "12345", grantedScopes: [github.readScope] },
            },
          },
        }),
      );
      const launch = {
        transport: "streamable-http" as const,
        name: "GitHub OAuth App",
        url: github.transportUrl,
        headers: {},
      };
      expect(await service.attachBearer(extension, component, launch)).toEqual(launch);
      expect(await service.status(extension, component, "local-window")).toEqual({
        kind: "sign-in-again",
        reason,
      });
      const restarted = new McpServerSignIn({
        statePath,
        oauth,
        actorId: credentialRef,
        serverUrl: async () => github.transportUrl,
        access: async () => {
          throw new Error("Status cannot inspect credentials");
        },
      });
      expect(await restarted.status(extension, component, "local-window")).toEqual({
        kind: "sign-in-again",
        reason,
      });
      expect(await readFile(statePath, "utf8")).not.toContain("synthetic-bearer");
    },
  );
});

const repositoryProfile = "github-repositories-read-write" as const;
function repositoryDescriptor() {
  return decodeHostOAuthDescriptor({
    ...descriptor,
    mcpPermissionProfile: repositoryProfile,
    scopes: [github.readScope, "repo", github.rotationScope],
  });
}
function heldStage() {
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return { held, started, release: () => release(), entered: () => entered() };
}
describe("host-selected GitHub repository consent", () => {
  it("refuses a renderer-selected repository policy without the matching host receipt", async () => {
    const { service, brokerCalls } = await fixture();
    const prepared = await service.prepareClient(extension, component, "local-window");
    if (prepared.kind !== "client-setup") throw new Error("Expected setup");
    expect(
      await service.saveClient(
        extension,
        component,
        {
          binding: {
            resource: prepared.resource,
            issuer: prepared.issuer,
            tokenEndpoint: prepared.tokenEndpoint,
            callback: prepared.callback,
            mcpPermissionProfile: repositoryProfile,
          },
          kind: "registered",
          clientId: "owned-fixture-client",
          authentication: "none",
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(brokerCalls).toEqual([]);
  });
  it("carries the exact catalog policy and scopes through production service and client serializers", async () => {
    const { service, brokerCalls } = await fixture({ profile: repositoryProfile });
    const prepared = await service.prepareClient(extension, component, "local-window");
    expect(prepared).toMatchObject({
      kind: "client-setup",
      mcpPermissionProfile: repositoryProfile,
    });
    await service.configureForServer(extension, component, registration, "local-window");
    expect(await service.begin(extension, component, "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    expect(brokerCalls.find((call) => call.path.endsWith("/begin"))?.body.descriptor).toMatchObject(
      {
        mcpPermissionProfile: repositoryProfile,
        scopes: [github.readScope, "repo", github.rotationScope],
      },
    );
  });
  it("refuses a repository preset when the server does not advertise repo instead of borrowing another scope", async () => {
    const { service, brokerCalls } = await fixture({
      profile: repositoryProfile,
      resource: { scopes_supported: [github.readScope] },
    });
    expect(await service.prepareClient(extension, component, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
    });
    expect(brokerCalls).toEqual([]);
  });
  it("refuses consent if the captured catalog owner changes during discovery", async () => {
    const stage = heldStage();
    let owner = 1;
    const { service, brokerCalls } = await fixture({
      profile: repositoryProfile,
      policyOwner: () => owner,
      holdMetadata: stage,
    });
    await service.configureForServer(extension, component, registration, "local-window");
    const beginning = service.begin(extension, component, "local-window");
    await stage.started;
    owner++;
    stage.release();
    expect(await beginning).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(brokerCalls).toEqual([]);
  });
  it("retains the original catalog owner through a held secret point and refuses a current replacement", async () => {
    const stage = heldStage();
    let owner = 1;
    const forgotten: string[] = [];
    const pointed: string[] = [];
    const { service, statePath } = await fixture({
      profile: repositoryProfile,
      policyOwner: () => owner,
      linkedSecrets: {
        point: async (ref) => {
          pointed.push(ref);
          stage.entered();
          await stage.held;
          return { status: "pointed" };
        },
        forget: async (ref) => {
          forgotten.push(ref);
        },
      },
    });
    const prepared = await service.prepareClient(extension, component, "local-window");
    if (prepared.kind !== "client-setup") throw new Error("Expected setup");
    const saving = service.saveClient(
      extension,
      component,
      {
        binding: {
          resource: prepared.resource,
          issuer: prepared.issuer,
          tokenEndpoint: prepared.tokenEndpoint,
          callback: prepared.callback,
          mcpPermissionProfile: repositoryProfile,
        },
        kind: "registered",
        clientId: "owned-fixture-client",
        authentication: "client_secret_post",
        secret: { store: "onepassword", reference: "op://Private/GitHub/client secret" },
      },
      "local-window",
    );
    await stage.started;
    owner++;
    stage.release();
    expect(await saving).toMatchObject({ kind: "refused" });
    expect(forgotten).toEqual(pointed);
    expect(pointed).toHaveLength(1);
    expect(
      Object.keys(
        (JSON.parse(await readFile(statePath, "utf8")) as { registrations?: object })
          .registrations ?? {},
      ),
    ).toEqual([]);
  });
  it.each(["read-descriptor", "repository-descriptor"] as const)(
    "refuses a mismatched broker grant before bearer use and retains reconnect after restart: %s",
    async (selection) => {
      const repo = selection === "repository-descriptor";
      const { service, statePath, oauth } = await fixture({
        ...(repo
          ? { profile: repositoryProfile, accessProfile: "legacy" as const }
          : { accessProfile: repositoryProfile }),
        accessAccount: {
          userId: "12345",
          grantedScopes: repo ? [github.readScope] : [github.readScope, "repo"],
        },
      });
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          signIns: {
            [`${extension}:${component}`]: {
              credentialRef,
              descriptor: repo ? repositoryDescriptor() : descriptor,
              issuer: github.issuer,
              account: {
                userId: "12345",
                grantedScopes: repo ? [github.readScope, "repo"] : [github.readScope],
              },
            },
          },
        }),
      );
      const launch = {
        transport: "streamable-http" as const,
        name: "GitHub",
        url: github.transportUrl,
        headers: {},
      };
      expect(await service.attachBearer(extension, component, launch)).toEqual(launch);
      expect(await service.status(extension, component, "local-window")).toEqual({
        kind: "sign-in-again",
        reason: "permission-mismatch",
      });
      const restarted = new McpServerSignIn({
        statePath,
        oauth,
        actorId: credentialRef,
        serverUrl: async () => github.transportUrl,
        access: async () => {
          throw new Error("Status cannot use bearer");
        },
      });
      expect(await restarted.status(extension, component, "local-window")).toEqual({
        kind: "sign-in-again",
        reason: "permission-mismatch",
      });
    },
  );
  it("hydrates an absent legacy descriptor profile as profile-read and refuses repository scopes", async () => {
    const { service, statePath } = await fixture();
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        signIns: {
          [`${extension}:${component}`]: {
            credentialRef,
            descriptor: { ...descriptor, scopes: [github.readScope, "repo", github.rotationScope] },
            issuer: github.issuer,
            account: { userId: "12345", grantedScopes: [github.readScope, "repo"] },
          },
        },
      }),
    );
    expect(await service.status(extension, component, "local-window")).toEqual({
      kind: "sign-in-again",
      reason: "permission-mismatch",
    });
  });
});
