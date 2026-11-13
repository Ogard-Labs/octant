import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Schema } from "effect";
import { decodeChatThread } from "@octant/contracts";
import { ExtensionSelection } from "@octant/contracts/extensions";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import type { HostOAuthService } from "../providers/oauth/hostOAuthService";
import type { ExternalContentIngestionResult } from "../context/externalContentIngestionStore";
import { McpServerSignIn } from "./mcpServerSignIn";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
} from "./extensionChatResolver";
import { decodeExtensionEffectiveSnapshot } from "@octant/contracts/extension-rpc";
import { AGENT_PLUGINS_MCP_SCHEMA } from "@octant/plugin-host/agent-plugins";
import type { AgentPluginMcpSession } from "./agentPluginMcpClient";
import { connectAgentPluginMcpSession } from "./agentPluginMcpClient";
import {
  AgentPluginMcpSessionManager,
  type AgentPluginMcpSessionManagerOptions,
} from "./agentPluginMcpSessionManager";

vi.mock("./agentPluginMcpClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agentPluginMcpClient")>()),
  connectAgentPluginMcpSession: vi.fn(),
}));
const connect = vi.mocked(connectAgentPluginMcpSession);
const EXTENSION = "15000000-0000-4000-8000-000000000001";
const THREAD = "17000000-0000-4000-8000-000000000099";
const managers: AgentPluginMcpSessionManager[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const manager of managers.splice(0)) await manager.drainAll();
  vi.resetAllMocks();
});
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
function effective(component = "mcp-remote", threadId = THREAD) {
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
        extensionId: EXTENSION,
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
function session(): AgentPluginMcpSession {
  return {
    transport: "streamable-http",
    name: "remote",
    tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "fixture result" }] })),
    close: vi.fn(async () => undefined),
  };
}
function manager(
  authorizeToolCall: () => Promise<boolean> = async () => true,
  options: Partial<AgentPluginMcpSessionManagerOptions> = {},
) {
  const result = new AgentPluginMcpSessionManager({
    store: {
      contentRoot: () => "/tmp/plugin",
      pluginDataRoot: () => "/tmp/plugin-data",
      readVerifiedConfiguration: async () =>
        JSON.stringify({
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: { remote: { type: "streamable-http", url: "https://example.test/mcp" } },
        }),
    },
    authorizeToolCall,
    recordExternalContentIngestion: () => ({
      kind: "recorded",
      taint: { externalContentIngested: true, ingestedSources: ["mcp-tool"] },
    }),
    ...options,
  });
  managers.push(result);
  return result;
}
function cachedExecution(subject: AgentPluginMcpSessionManager, threadId = THREAD) {
  const definition = subject
    .toolDefinitions()
    .find((candidate) => candidate.name.includes("lookup"));
  if (definition === undefined) throw new Error("Expected a listed tool");
  const port = subject.createToolExecutionPort();
  const thread = { id: threadId } as Parameters<typeof port.execute>[0]["thread"];
  return () => port.execute({ thread, name: definition.name, inputJson: "{}" });
}

describe("MCP authentication retirement", () => {
  it("does not resolve credentials before required tool approval or retire on an application error", async () => {
    const transport = session();
    connect.mockResolvedValue(transport);
    const check = vi.fn(async () => "unchanged" as const);
    const rejected = vi.fn(async () => undefined);
    const recordExternalContentIngestion = vi.fn(
      (): ExternalContentIngestionResult => ({
        kind: "recorded",
        taint: { externalContentIngested: true, ingestedSources: ["mcp-tool"] },
      }),
    );
    let approved = false;
    const subject = manager(async () => approved, {
      isUserAddedSource: () => true,
      bindUserAddedAuthentication: async () => ({ check, rejected }),
      recordExternalContentIngestion,
    });
    await subject.reconcile(effective());
    const execute = cachedExecution(subject);
    expect(await execute()).toMatchObject({
      isError: true,
      result: { error: "extension-tool-approval-required" },
    });
    expect(check).not.toHaveBeenCalled();
    expect(transport.callTool).not.toHaveBeenCalled();
    approved = true;
    vi.mocked(transport.callTool).mockRejectedValue(new Error("Synthetic application refusal"));
    expect(await execute()).toEqual({
      isError: true,
      result: { error: "MCP tool call failed." },
    });
    expect(check).toHaveBeenCalledOnce();
    expect(rejected).not.toHaveBeenCalled();
    expect(recordExternalContentIngestion).not.toHaveBeenCalled();
    expect(subject.sessions().map((record) => record.session)).toEqual([transport]);
  });

  it("suppresses an old credential check completing after replacement without retiring the replacement", async () => {
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<"unchanged">();
    const old = session();
    const replacement = session();
    connect.mockResolvedValueOnce(old).mockResolvedValue(replacement);
    let binding = 0;
    const subject = manager(async () => true, {
      isUserAddedSource: () => true,
      bindUserAddedAuthentication: async () =>
        ++binding === 1
          ? {
              check: async () => {
                entered.resolve();
                return held.promise;
              },
              rejected: async () => undefined,
            }
          : { check: async () => "unchanged", rejected: async () => undefined },
    });
    await subject.reconcile(effective());
    const pending = cachedExecution(subject)();
    await entered.promise;
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    await subject.reconcile(effective());
    held.resolve("unchanged");
    expect(await pending).toMatchObject({
      isError: true,
      result: { error: "extension-tool-authentication-changed" },
    });
    expect(old.callTool).not.toHaveBeenCalled();
    expect(replacement.callTool).not.toHaveBeenCalled();
    expect(subject.sessions().map((record) => record.session)).toEqual([replacement]);
  });

  it("retires a rejected HTTP authentication session without replaying its dispatched tool call", async () => {
    const actual =
      await vi.importActual<typeof import("./agentPluginMcpClient")>("./agentPluginMcpClient");
    connect.mockImplementation(actual.connectAgentPluginMcpSession);
    let calls = 0;
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/call") {
          calls++;
          return new Response(null, { status: 401 });
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
              : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
        });
      },
      { preconnect: () => undefined },
    );
    const subject = manager(async () => true, { fetch: fetchImpl, isUserAddedSource: () => true });
    await subject.reconcile(effective());
    const execute = cachedExecution(subject);
    expect((await execute()).isError).toBe(true);
    expect(subject.toolDefinitions()).toEqual([]);
    expect((await execute()).isError).toBe(true);
    expect(calls).toBe(1);
  });

  it("fences the actual resolved task-tool closure after completed-grant Sign out", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octant-mcp-auth-retirement-"));
    const approval = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    let holdApproval = false;
    const transport = session();
    connect.mockResolvedValue(transport);
    const subject = manager(async () => {
      if (!holdApproval) return true;
      entered.resolve();
      return approval.promise;
    });
    const state = effective();
    await subject.reconcile(state);
    const resolver = createExtensionChatResolver({
      snapshot: () => state,
      resolveEffectiveState: () => state,
      providerFamily: () => state.scope.providerFamily,
      materialLoader: createStoredExtensionMaterialLoader(
        { readVerifiedComponentText: async () => "" },
        {
          mcpToolsForComponent: ({ packageId, componentId, scope }) =>
            subject.toolDefinitionsFor(packageId, componentId, scope),
        },
      ),
      toolExecution: subject.createToolExecutionPort(),
    });
    const thread = decodeChatThread({
      id: THREAD,
      title: "Fixture",
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
    const selected = Schema.decodeUnknownSync(ExtensionSelection)({
      kind: "plugin",
      extensionId: EXTENSION,
      packageId: "15000000-0000-4000-8000-000000000002",
      componentId: "mcp-remote",
      packageVersion: "1.0.0",
      packageDigest: `sha256:${"c".repeat(64)}`,
      catalogEpoch: state.catalogEpoch,
      origin: { kind: "draft", reference: "draft-1" },
    });
    const resolved = await resolver({ phase: "send", thread, selections: [selected] });
    const definition = resolved.toolSet?.definitions[0];
    if (resolved.toolSet === undefined || definition === undefined)
      throw new Error("Expected a resolved tool set");
    const execute = () => resolved.toolSet?.execute({ name: definition.name, inputJson: "{}" });
    const descriptor = decodeHostOAuthDescriptor({
      descriptorId: "mcp-fixture",
      flow: "authorization-code-pkce",
      dialect: "mcp-authorization",
      termsId: "fixture-terms",
      clientId: "registered-fixture",
      authorizationEndpoint: "https://auth.example/authorize",
      tokenEndpoint: "https://auth.example/token",
      resource: "https://example.test/mcp",
      scopes: [],
      redirectPort: 43125,
    });
    const signOut = vi.fn<HostOAuthService["signOut"]>(async () => ({ kind: "signed-out" }));
    try {
      const statePath = join(directory, "sign-ins.json");
      await writeFile(
        statePath,
        JSON.stringify({
          schemaVersion: 1,
          signIns: {
            [`${EXTENSION}:mcp-remote`]: {
              descriptor,
              issuer: "https://auth.example",
              credentialRef: "55000000-0000-4000-8000-000000000002",
            },
          },
        }),
      );
      const service = new McpServerSignIn({
        statePath,
        oauth: {
          offer: vi.fn<HostOAuthService["offer"]>(),
          acknowledgeTerms: vi.fn<HostOAuthService["acknowledgeTerms"]>(),
          restoreAcknowledgment: vi.fn<HostOAuthService["restoreAcknowledgment"]>(),
          begin: vi.fn<HostOAuthService["begin"]>(),
          cancel: vi.fn<HostOAuthService["cancel"]>(),
          status: vi.fn<HostOAuthService["status"]>(),
          refresh: vi.fn<HostOAuthService["refresh"]>(),
          revokesOnSignOut: () => false,
          signOut,
        },
        access: async () => ({ kind: "unavailable" }),
        serverUrl: async () => "https://example.test/mcp",
        actorId: "66000000-0000-4000-8000-000000000001",
        onAuthenticationChanged: (extensionId, componentId) =>
          subject.invalidateAuthentication(extensionId, componentId),
      });
      expect((await execute())?.isError).not.toBe(true);
      holdApproval = true;
      const awaitingApproval = execute();
      await entered.promise;
      expect(await service.signOut(EXTENSION, "mcp-remote", "local-window")).toEqual({
        kind: "signed-out",
      });
      approval.resolve(true);
      expect(await awaitingApproval).toMatchObject({
        isError: true,
        result: { error: "extension-tool-authentication-changed" },
      });
      expect(await execute()).toMatchObject({
        isError: true,
        result: { error: "extension-tool-unavailable" },
      });
      expect(transport.callTool).toHaveBeenCalledOnce();
      expect(signOut).toHaveBeenCalledOnce();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fences a cached execution closure and a held approval without dispatching again", async () => {
    const approval = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    let held = false;
    const transport = session();
    connect.mockResolvedValue(transport);
    const subject = manager(async () => {
      if (!held) return true;
      entered.resolve();
      return approval.promise;
    });
    await subject.reconcile(effective());
    const execute = cachedExecution(subject);
    expect((await execute()).isError).not.toBe(true);
    held = true;
    const pending = execute();
    await entered.promise;
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    approval.resolve(true);
    expect(await pending).toMatchObject({
      isError: true,
      result: { error: "extension-tool-authentication-changed" },
    });
    expect(await execute()).toMatchObject({
      isError: true,
      result: { error: "extension-tool-unavailable" },
    });
    expect(transport.callTool).toHaveBeenCalledTimes(1);
    expect(subject.toolDefinitions()).toEqual([]);
  });

  it("never publishes tools when the active transport closes before initialization resolves", async () => {
    const held = Promise.withResolvers<AgentPluginMcpSession>();
    const entered = Promise.withResolvers<void>();
    const transport = session();
    let closed: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    connect.mockImplementationOnce(async (_launch, options) => {
      closed = options?.onTransportClosed;
      signal = options?.signal;
      entered.resolve();
      return held.promise;
    });
    const subject = manager();
    const reconciling = subject.reconcile(effective());
    await entered.promise;
    closed?.();
    expect(signal?.aborted).toBe(true);
    held.resolve(transport);
    await reconciling;
    expect(subject.sessions()).toEqual([]);
    expect(subject.toolDefinitions()).toEqual([]);
    expect(subject.failedComponents()).toHaveLength(1);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("discards a late initialize and its callback after replacement initialization", async () => {
    const held = Promise.withResolvers<AgentPluginMcpSession>();
    const entered = Promise.withResolvers<void>();
    const old = session();
    const replacement = session();
    let oldClosed: (() => void) | undefined;
    connect
      .mockImplementationOnce(async (_launch, options) => {
        oldClosed = options?.onTransportClosed;
        entered.resolve();
        return held.promise;
      })
      .mockResolvedValue(replacement);
    const subject = manager();
    const first = subject.reconcile(effective());
    await entered.promise;
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    await subject.reconcile(effective());
    held.resolve(old);
    await first;
    oldClosed?.();
    expect(old.close).toHaveBeenCalledOnce();
    expect(subject.sessions().map((record) => record.session)).toEqual([replacement]);
    expect(subject.failedComponents()).toEqual([]);
    expect((await cachedExecution(subject)()).isError).not.toBe(true);
    expect(old.callTool).not.toHaveBeenCalled();
  });

  it("ignores an old same-generation transport-close callback after idle replacement", async () => {
    vi.useFakeTimers();
    const old = session();
    const replacement = session();
    let oldClosed: (() => void) | undefined;
    connect
      .mockImplementationOnce(async (_launch, options) => {
        oldClosed = options?.onTransportClosed;
        return old;
      })
      .mockResolvedValue(replacement);
    const subject = manager();
    await subject.reconcile(effective());
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await subject.reconcile(effective());
    oldClosed?.();
    expect(subject.sessions().map((record) => record.session)).toEqual([replacement]);
    expect(subject.failedComponents()).toEqual([]);
    expect((await cachedExecution(subject)()).isError).not.toBe(true);
  });

  it("never replays a dispatched call and does not let its late failure retire a replacement", async () => {
    const response = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const old = session();
    vi.mocked(old.callTool).mockImplementation(async () => {
      entered.resolve();
      return response.promise;
    });
    const replacement = session();
    connect.mockResolvedValueOnce(old).mockResolvedValue(replacement);
    const subject = manager();
    await subject.reconcile(effective());
    const pending = cachedExecution(subject)();
    await entered.promise;
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    await subject.reconcile(effective());
    response.reject(new DOMException("Old call aborted", "AbortError"));
    expect(await pending).toMatchObject({
      isError: true,
      result: { error: expect.stringContaining("uncertain") },
    });
    expect(old.callTool).toHaveBeenCalledTimes(1);
    expect(replacement.callTool).not.toHaveBeenCalled();
    expect(subject.sessions().map((record) => record.session)).toEqual([replacement]);
    expect(subject.failedComponents()).toEqual([]);
    await cachedExecution(subject)();
    expect(replacement.callTool).toHaveBeenCalledOnce();
  });

  it("does not mark a replacement failed when an already-closing old call finally returns", async () => {
    const closing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const old = session();
    const replacement = session();
    vi.mocked(old.close).mockImplementation(async () => {
      entered.resolve();
      return closing.promise;
    });
    vi.mocked(old.callTool).mockImplementation(
      async (_name, _args, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        ),
    );
    connect.mockResolvedValueOnce(old).mockResolvedValue(replacement);
    const subject = manager();
    await subject.reconcile(effective());
    const name = subject.toolDefinitions()[0]?.name;
    if (name === undefined) throw new Error("Expected a tool");
    const controller = new AbortController();
    const pending = subject
      .createToolExecutionPort()
      .execute({ thread: { id: THREAD }, name, inputJson: "{}", signal: controller.signal });
    await vi.waitFor(() => expect(old.callTool).toHaveBeenCalledOnce());
    controller.abort();
    await entered.promise;
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    await subject.reconcile(effective());
    closing.resolve();
    expect((await pending).isError).toBe(true);
    expect(subject.sessions().map((record) => record.session)).toEqual([replacement]);
    expect(subject.failedComponents()).toEqual([]);
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it("uses the new bearer only after a fresh authoritative task reconciliation", async () => {
    const actual =
      await vi.importActual<typeof import("./agentPluginMcpClient")>("./agentPluginMcpClient");
    connect.mockImplementation(actual.connectAgentPluginMcpSession);
    let bearer = "old-synthetic-bearer";
    const calls: string[] = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const body = JSON.parse(String(init?.body));
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (body.method === "tools/call")
          calls.push(new Headers(init?.headers).get("authorization") ?? "");
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
                ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
                : { content: [{ type: "text", text: "fixture result" }] },
        });
      },
      { preconnect: () => undefined },
    );
    const subject = manager(async () => true, {
      fetch: fetchImpl,
      isUserAddedSource: () => true,
      resolveUserAddedSecrets: async (launch) =>
        launch.transport === "stdio"
          ? launch
          : { ...launch, headers: { ...launch.headers, Authorization: `Bearer ${bearer}` } },
    });
    await subject.reconcile(effective());
    const execute = cachedExecution(subject);
    await execute();
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    bearer = "new-synthetic-bearer";
    expect((await execute()).isError).toBe(true);
    expect(calls).toEqual(["Bearer old-synthetic-bearer"]);
    await subject.reconcile(effective());
    await cachedExecution(subject)();
    expect(calls).toEqual(["Bearer old-synthetic-bearer", "Bearer new-synthetic-bearer"]);
  });

  it("retires every task scope for the component and preserves a sibling component", async () => {
    connect.mockImplementation(async () => session());
    const subject = manager();
    await subject.reconcile(effective());
    await subject.reconcile(effective("mcp-remote", "17000000-0000-4000-8000-000000000098"));
    await subject.reconcile(effective("mcp-sibling", "17000000-0000-4000-8000-000000000097"));
    const sibling = subject.sessions().find((record) => record.componentId === "mcp-sibling");
    await subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    expect(subject.sessions()).toEqual([sibling]);
    expect(sibling?.session.close).not.toHaveBeenCalled();
  });

  it("retires synchronously and bounds a noncooperative close without blocking sibling work", async () => {
    vi.useFakeTimers();
    const held = Promise.withResolvers<void>();
    const old = session();
    vi.mocked(old.close).mockReturnValue(held.promise);
    connect.mockResolvedValueOnce(old).mockImplementation(async () => session());
    const subject = manager();
    await subject.reconcile(effective());
    const execute = cachedExecution(subject);
    const retirement = subject.invalidateAuthentication(EXTENSION, "mcp-remote");
    expect(subject.sessions()).toEqual([]);
    expect((await execute()).isError).toBe(true);
    await subject.reconcile(effective("mcp-sibling"));
    await vi.advanceTimersByTimeAsync(10_000);
    await retirement;
    expect(subject.sessions()).toHaveLength(1);
    held.resolve();
  });
});
