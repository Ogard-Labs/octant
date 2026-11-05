import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { decodeChatThread } from "@octant/contracts";
import { decodeExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { decodeExtensionPackageManifest, ExtensionSelection } from "@octant/contracts/extensions";
import {
  startCredentialBroker,
  CredentialStoreFailure,
  SLACK_MCP_USER_OAUTH as slack,
  type CredentialStore,
} from "@octant/host-runtime";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { createHostOAuthService } from "../providers/oauth/hostOAuthService";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";
import { UserAddedMcpServerStore } from "./userAddedMcpServers";
import { normalizeAgentPluginPackage } from "./agentPluginIngestion";
import { McpServerSignIn } from "./mcpServerSignIn";
import { AgentPluginMcpSessionManager } from "./agentPluginMcpSessionManager";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
} from "./extensionChatResolver";

function memoryStore(): CredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    set: async (id, value) => {
      values.set(id, value);
    },
    delete: async (id) => {
      values.delete(id);
    },
  };
}
function callback(authorization: URL): Promise<number> {
  const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  const params = new URLSearchParams({
    state: authorization.searchParams.get("state") ?? "",
    code: "synthetic-fixture-code",
    iss: slack.issuer,
  });
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: Number(redirect.port),
        path: `${redirect.pathname}?${params}`,
        method: "GET",
        agent: false,
        headers: { host: redirect.host },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

/** Local broker/callback sockets; vendor discovery, token exchange and MCP are controlled fixtures. */
describe("registered Slack connector through existing task authority", () => {
  it("configures an actual generated connector, explicitly consents, uses discovered tools and reconnects without old-bearer calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-slack-connector-"));
    const credentials = memoryStore();
    const secrets = memoryStore();
    let broker: Awaited<ReturnType<typeof startCredentialBroker>> | undefined;
    let manager: AgentPluginMcpSessionManager | undefined;
    let tokenCalls = 0;
    let currentChallenge = "";
    let currentCallback = "";
    let approvals = false;
    const calls: string[] = [];
    const metadataCalls: string[] = [];
    const journal: unknown[] = [];
    const account = {
      workspaceId: "TTEST001",
      userId: "UTEST001",
      grantedScopes: [slack.readScope],
    };
    const tokenFetch: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        expect(String(input)).toBe(slack.tokenEndpoint);
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("client_id")).toBe("owned-fixture-client");
        expect(form.get("client_secret")).toBe("synthetic-private-app-secret");
        expect(form.get("resource")).toBe(slack.resource);
        expect(form.get("redirect_uri")).toBe(currentCallback);
        expect(
          createHash("sha256")
            .update(form.get("code_verifier") ?? "")
            .digest("base64url"),
        ).toBe(currentChallenge);
        tokenCalls++;
        return Response.json({
          ok: true,
          access_token: `synthetic-slack-access-${tokenCalls}`,
          token_type: "user",
          refresh_token: `synthetic-slack-refresh-${tokenCalls}`,
          expires_in: 3600,
          team: { id: account.workspaceId },
          authed_user: { id: account.userId, scope: slack.readScope },
        });
      },
      { preconnect: () => undefined },
    );
    try {
      broker = await startCredentialBroker(
        credentials,
        undefined,
        { fetch: tokenFetch, timeoutMs: 10_000 },
        undefined,
        undefined,
        undefined,
        secrets,
      );
      const brokerClient = makeHostOAuthBrokerClient({ url: broker.url, token: broker.token });
      const oauth = createHostOAuthService({
        broker: brokerClient,
        journal: { append: (record) => journal.push(record) },
      });
      const registry = new LocalPluginFolderRegistry({
        sourceKind: "user-added",
        platform: "linux",
      });
      const servers = new UserAddedMcpServerStore({
        directory: join(directory, "generated"),
        registry,
      });
      const { source } = await servers.add({
        name: "Slack",
        connectorId: "slack",
        server: { type: "streamable-http", url: slack.transportUrl, headers: [] },
      });
      const registered = registry.get(source.sourceRef);
      if (registered === undefined) throw new Error("Expected host generated connector");
      const manifest = decodeExtensionPackageManifest(
        normalizeAgentPluginPackage(registered.packageInput).manifest,
      );
      const component = manifest.components.find((candidate) => candidate.kind === "mcp-server");
      if (component === undefined) throw new Error("Expected generated MCP component");
      expect(manifest.slug).toBe("connector-slack");
      expect(servers.owns(source.sourceRef)).toBe(true);
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
      const threadId = "17000000-0000-4000-8000-000000000099";
      const effective = decodeExtensionEffectiveSnapshot({
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
            extensionId: manifest.extensionId,
            packageId: manifest.packageId,
            slug: manifest.slug,
            displayName: manifest.displayName,
            stateVersion: 1,
            version: manifest.version,
            digest: manifest.digest,
            source: manifest.source,
            compatibility: manifest.compatibility,
            activation,
            components: [
              {
                component,
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
                effectiveState: { kind: "effective" },
                contextContribution: { kind: "zero", reason: "not-selected" },
              },
            ],
            diagnostics: [],
          },
        ],
        collisions: [],
      });
      const installed = effective.packages[0];
      if (installed === undefined) throw new Error("Expected fixture installed authority");
      const metadataFetch: typeof fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          const url = String(input);
          metadataCalls.push(url);
          if (url === slack.transportUrl)
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${slack.resource}/.well-known/oauth-protected-resource"`,
              },
            });
          if (url === `${slack.resource}/.well-known/oauth-protected-resource`)
            return Response.json({
              resource: slack.resource,
              authorization_servers: [slack.issuer],
              scopes_supported: [slack.readScope],
            });
          if (url === `${slack.issuer}/.well-known/oauth-authorization-server`)
            return Response.json({
              issuer: slack.issuer,
              authorization_endpoint: slack.authorizationEndpoint,
              token_endpoint: slack.tokenEndpoint,
              response_types_supported: ["code"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              token_endpoint_auth_methods_supported: ["client_secret_post"],
              code_challenge_methods_supported: ["S256"],
            });
          throw new Error("Unexpected metadata endpoint");
        },
        { preconnect: () => undefined },
      );
      const signIn = new McpServerSignIn({
        statePath: join(directory, "sign-ins.json"),
        oauth,
        access: (ref) => brokerClient.access(ref),
        refresh: (ref) => brokerClient.refresh(ref),
        actorId: "66000000-0000-4000-8000-000000000001",
        fetch: metadataFetch,
        serverUrl: (extensionId, componentId) =>
          extensionId === manifest.extensionId && componentId === component.id
            ? servers.signInAddress(installed, componentId, () =>
                readFile(join(registered.absolutePath, "mcp.json"), "utf8"),
              )
            : Promise.resolve(undefined),
        linkedSecrets: {
          // A fixture linked item writes only the broker's MCP namespace, never a host response.
          point: async (id, pointer) => {
            expect(pointer).toEqual({
              store: "onepassword",
              reference: "op://Private/Slack/client secret",
            });
            await secrets.set(id, "synthetic-private-app-secret");
            return { status: "pointed" };
          },
          forget: async (id) => {
            await secrets.delete(id);
          },
        },
        onAuthenticationChanged: async (extensionId, componentId) => {
          await manager?.invalidateAuthentication(extensionId, componentId);
        },
      });
      const mcpFetch: typeof fetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          expect(String(input)).toBe(slack.transportUrl);
          if (init?.method === "DELETE") return new Response(null, { status: 204 });
          const message = JSON.parse(String(init?.body));
          if (message.method === "notifications/initialized")
            return new Response(null, { status: 202 });
          if (message.method === "tools/call")
            calls.push(new Headers(init?.headers).get("authorization") ?? "");
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    protocolVersion: "2025-03-26",
                    capabilities: {},
                    serverInfo: { name: "fixture", version: "1" },
                  }
                : message.method === "tools/list"
                  ? { tools: [{ name: "fixture_public_search", inputSchema: { type: "object" } }] }
                  : { content: [{ type: "text", text: "Synthetic public Slack result" }] },
          });
        },
        { preconnect: () => undefined },
      );
      manager = new AgentPluginMcpSessionManager({
        store: {
          contentRoot: () => registered.absolutePath,
          pluginDataRoot: () => join(directory, "plugin-data"),
          readVerifiedConfiguration: () =>
            readFile(join(registered.absolutePath, "mcp.json"), "utf8"),
        },
        fetch: mcpFetch,
        isUserAddedSource: (ref) => servers.owns(ref),
        resolveUserAddedSecrets: (launch, target) =>
          signIn.attachBearer(target.extensionId, target.componentId, launch),
        bindUserAddedAuthentication: (launch, target) =>
          signIn.bindAuthentication(target.extensionId, target.componentId, launch),
        authorizeToolCall: async () => approvals,
        recordExternalContentIngestion: () => ({
          kind: "recorded",
          taint: { externalContentIngested: true, ingestedSources: ["mcp-tool"] },
        }),
      });
      const activeManager = manager;
      const resolver = createExtensionChatResolver({
        snapshot: () => effective,
        resolveEffectiveState: () => effective,
        reconcileEffectiveState: (state) => activeManager.reconcile(state),
        providerFamily: () => effective.scope.providerFamily,
        materialLoader: createStoredExtensionMaterialLoader(
          {
            readVerifiedComponentText: async () => {
              throw new Error("No instructions selected");
            },
          },
          {
            mcpToolsForComponent: ({ packageId, componentId, scope }) =>
              activeManager.toolDefinitionsFor(packageId, componentId, scope),
          },
        ),
        toolExecution: activeManager.createToolExecutionPort(),
      });
      const thread = decodeChatThread({
        id: threadId,
        title: "Retained task",
        lifecycle: "active",
        providerInstanceId: "94000000-0000-4000-8000-000000000003",
        modelId: "generic-model",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be helpful.",
        version: 1,
        createdAt: "2026-11-02T00:00:00.000Z",
        updatedAt: "2026-11-02T00:00:00.000Z",
      });
      const selection = Schema.decodeUnknownSync(ExtensionSelection)({
        kind: "plugin",
        extensionId: manifest.extensionId,
        packageId: manifest.packageId,
        componentId: component.id,
        packageVersion: manifest.version,
        packageDigest: manifest.digest,
        catalogEpoch: effective.catalogEpoch,
        origin: { kind: "draft", reference: "retained-draft" },
      });
      expect(await signIn.status(manifest.extensionId, component.id, "local-window")).toMatchObject(
        { kind: "client-setup-required" },
      );
      expect(metadataCalls).toEqual([]);
      const prepared = await signIn.prepareClient(
        manifest.extensionId,
        component.id,
        "local-window",
      );
      if (prepared.kind !== "client-setup") throw new Error("Expected explicit app setup");
      expect(
        await signIn.saveClient(
          manifest.extensionId,
          component.id,
          {
            binding: {
              resource: prepared.resource,
              issuer: prepared.issuer,
              tokenEndpoint: prepared.tokenEndpoint,
              callback: prepared.callback,
            },
            kind: "registered",
            clientId: "owned-fixture-client",
            authentication: "client_secret_post",
            secret: { store: "onepassword", reference: "op://Private/Slack/client secret" },
          },
          "local-window",
        ),
      ).toEqual({ kind: "client-configured" });
      expect(tokenCalls).toBe(0);
      expect(credentials.values.size).toBe(0);
      const consent = async () => {
        const started = await signIn.begin(manifest.extensionId, component.id, "local-window");
        if (started.kind !== "awaiting-consent")
          throw new Error(`Expected consent, got ${started.kind}`);
        const authorization = new URL(started.authorizationUrl);
        currentChallenge = authorization.searchParams.get("code_challenge") ?? "";
        currentCallback = authorization.searchParams.get("redirect_uri") ?? "";
        expect(currentCallback).toBe(prepared.callback);
        expect(authorization.searchParams.get("scope")).toBe(slack.readScope);
        expect(await callback(authorization)).toBe(200);
        expect(
          await signIn.poll(manifest.extensionId, component.id, started.attemptId, "local-window"),
        ).toEqual({ kind: "signed-in", issuer: new URL(slack.issuer).host, account });
      };
      await consent();
      const resolved = await resolver({ phase: "send", thread, selections: [selection] });
      const toolSet = resolved.toolSet;
      const definition = toolSet?.definitions[0];
      if (toolSet === undefined || definition === undefined)
        throw new Error("Expected actual discovered task tool");
      const execute = () => toolSet.execute({ name: definition.name, inputJson: "{}" });
      expect(await execute()).toMatchObject({
        isError: true,
        result: { error: "extension-tool-approval-required" },
      });
      expect(calls).toEqual([]);
      approvals = true;
      expect((await execute()).isError).not.toBe(true);
      expect(calls).toEqual(["Bearer synthetic-slack-access-1"]);
      expect(await signIn.signOut(manifest.extensionId, component.id, "local-window")).toEqual({
        kind: "signed-out",
      });
      expect((await execute()).isError).toBe(true);
      expect(calls).toHaveLength(1);
      expect(credentials.values.size).toBe(0);
      expect(secrets.values.size).toBe(1);
      await consent();
      const again = await resolver({ phase: "send", thread, selections: [selection] });
      const next = again.toolSet?.definitions[0];
      if (again.toolSet === undefined || next === undefined)
        throw new Error("Expected refreshed task tools");
      expect((await again.toolSet.execute({ name: next.name, inputJson: "{}" })).isError).not.toBe(
        true,
      );
      expect(calls).toEqual(["Bearer synthetic-slack-access-1", "Bearer synthetic-slack-access-2"]);
      expect(JSON.stringify(journal)).not.toContain("synthetic-private-app-secret");
      expect(JSON.stringify(journal)).not.toContain("synthetic-slack-access");
    } finally {
      try {
        await manager?.drainAll();
      } finally {
        try {
          await broker?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    }
  });
});
