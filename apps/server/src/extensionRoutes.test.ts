import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionCommand,
  ExtensionCommandResult,
  ExtensionSnapshot,
} from "@octant/contracts/extension-rpc";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createExtensionRouteHandler, type ExtensionRouteService } from "./extensionRoutes";
import { ExtensionApiService } from "./extensions/extensionApiService";
import type { ExtensionLifecycleService } from "./extensions/extensionLifecycleService";
import type { ResolvedExtensionPackage } from "./extensions/packageInspector";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { LocalPluginImportReceiptStore } from "./extensions/localPluginImportReceiptStore";
import { ExtensionToolApprovalService } from "./extensions/extensionToolApprovalService";
import { UserAddedMcpServerError } from "./extensions/userAddedMcpServers";

const now = Date.parse("2026-07-28T12:00:00.000Z");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const windowId = "44000000-0000-4000-8000-000000000001";
const extensionId = "44000000-0000-4000-8000-000000000002";
const packageId = "44000000-0000-4000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;
const pairedDeviceId = "55000000-0000-4000-8000-000000000001";

/** A request the remote gateway already authenticated as a paired device. */
function pairedDeviceRequest(path: string, body: unknown): Request {
  const remoteRequest = new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  bindPrincipalRouteContext(remoteRequest, {
    principal: {
      kind: "remote-device",
      hostId: "local",
      deviceId: pairedDeviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-000000000002",
    } as never,
    scopeId: pairedDeviceId as never,
  });
  return remoteRequest;
}

function setup(service?: ExtensionRouteService, maxRequestBodySize = 4_096) {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now });
  const fallback: ExtensionRouteService = {
    snapshot: () =>
      ({
        sequence: 0,
        snapshotAt: "2026-07-28T12:00:00.000Z",
        packages: [],
        collisions: [],
      }) as unknown as ExtensionSnapshot,
    execute: async () =>
      ({
        kind: "extension-command-failed",
        failure: { category: "unavailable", message: "Extension source is unavailable." },
      }) as ExtensionCommandResult,
  };
  return createExtensionRouteHandler({
    service: service ?? fallback,
    windowAuthorityStore,
    maxRequestBodySize,
    now: () => now,
  });
}

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-window-capability": capability,
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("bounded authenticated extension routes", () => {
  it("accepts source-qualified skill lifecycle commands only from an authorized window", async () => {
    const observed: Array<ExtensionCommand> = [];
    const handler = setup({
      snapshot: setupSnapshot,
      execute: async (command) => {
        observed.push(command);
        return { kind: "extension-state-updated", snapshot: setupSnapshot() };
      },
    });
    const qualifiedId = `agents-skills-directory:project:fixture:qa-marker:${digest}`;
    const commands = [
      { kind: "review-skill", qualifiedId, digest },
      { kind: "trust-skill-source", qualifiedId, digest, trusted: true },
      { kind: "set-skill-desired", qualifiedId, digest, desired: true },
      { kind: "select-skill-collision", qualifiedId, name: "qa-marker" },
    ] as const;
    for (const command of commands) {
      const denied = await handler(
        request("/api/extensions/lifecycle", command, {
          "x-octant-window-capability": "invalid",
        }),
      );
      expect(denied?.status).toBe(401);
      expect(observed).not.toContainEqual(command);
      const accepted = await handler(request("/api/extensions/lifecycle", command));
      expect(accepted?.status).toBe(200);
      expect(await accepted?.json()).toMatchObject({ kind: "extension-state-updated" });
    }
    expect(observed).toEqual(commands);
    const malformed = await handler(
      request("/api/extensions/lifecycle", {
        kind: "review-skill",
        qualifiedId,
        digest: "invalid",
      }),
    );
    expect(malformed?.status).toBe(400);
    expect(observed).toEqual(commands);
  });

  it("lists and decides only window-bound extension tool approvals", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now });
    const list = vi.fn(
      () =>
        [
          {
            approvalId: "44000000-0000-4000-8000-000000000010",
            threadId: "44000000-0000-4000-8000-000000000011",
            packageId,
            componentId: "server",
            providerToolName: "plugin__server__read",
            mcpToolName: "read",
            inputJson: "{}",
            requestedAt: "2026-08-09T06:00:00.000Z",
          },
        ] as never,
    );
    const decide = vi.fn(() => true);
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore,
      toolApprovals: { list, decide },
      now: () => now,
    });

    const listed = await handler(request("/api/extensions/tool-approvals", { kind: "list" }));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual(list());
    const decided = await handler(
      request("/api/extensions/tool-approvals", {
        kind: "decide",
        approvalId: "44000000-0000-4000-8000-000000000010",
        decision: "approved",
      }),
    );
    expect(decided?.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ kind: "local-window", scopeId: windowId });
    expect(decide).toHaveBeenCalledWith(
      { kind: "local-window", scopeId: windowId },
      {
        approvalId: "44000000-0000-4000-8000-000000000010",
        decision: "approved",
      },
    );
  });

  it("lets a local window answer a tool approval with always allow", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now });
    const decide = vi.fn(() => false);
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore,
      toolApprovals: { list: () => [], decide },
      now: () => now,
    });
    const answer = {
      kind: "decide",
      approvalId: "44000000-0000-4000-8000-000000000010",
      decision: "approved",
      remember: true,
    };

    // The host refused to remember it (no Project, say): the call is still pending.
    const refused = await handler(request("/api/extensions/tool-approvals", answer));
    expect(refused?.status).toBe(409);
    expect(await refused?.json()).toEqual({ accepted: false });
    expect(decide).toHaveBeenCalledWith(
      { kind: "local-window", scopeId: windowId },
      {
        approvalId: answer.approvalId,
        decision: "approved",
        remember: true,
      },
    );

    const denied = await handler(
      request("/api/extensions/tool-approvals", { ...answer, decision: "denied" }),
    );
    expect(denied?.status).toBe(400);
    expect(decide).toHaveBeenCalledOnce();
  });

  it("lists and revokes remembered tool approvals for a local window and creates none", async () => {
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now });
    const grantId = `sha256:${"b".repeat(64)}`;
    const grant = {
      grantId,
      projectId: "44000000-0000-4000-8000-000000000020",
      extensionId,
      packageId,
      componentId: "mcp-notes",
      mcpToolName: "search",
      version: "1.0.0",
      digest,
      definitionDigest: `sha256:${"c".repeat(64)}`,
      grantedAt: "2026-10-12T10:00:00.000Z",
    };
    const list = vi.fn(() => [grant] as never);
    const revoke = vi.fn((id: string) => (id === grantId ? "revoked" : "not-found"));
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore,
      toolGrants: { list, revoke },
      now: () => now,
    });

    const listed = await handler(request("/api/extensions/tool-grants", { kind: "list" }));
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual([grant]);

    const revoked = await handler(
      request("/api/extensions/tool-grants", { kind: "revoke", grantId }),
    );
    expect(revoked?.status).toBe(200);
    expect(await revoked?.json()).toEqual({ revoked: true });
    const unknown = await handler(
      request("/api/extensions/tool-grants", {
        kind: "revoke",
        grantId: `sha256:${"d".repeat(64)}`,
      }),
    );
    expect(unknown?.status).toBe(200);
    expect(await unknown?.json()).toEqual({ revoked: false });

    for (const body of [
      { kind: "record", ...grant },
      { kind: "grant", ...grant },
      { ...grant },
      { kind: "revoke", grantId, projectId: grant.projectId },
      { kind: "list", projectId: grant.projectId },
    ]) {
      const response = await handler(request("/api/extensions/tool-grants", body));
      expect(response?.status).toBe(400);
    }
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledOnce();
  });

  it("refuses a paired device the remembered-approval route", async () => {
    const list = vi.fn(() => []);
    const revoke = vi.fn(() => "revoked" as const);
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: new WindowAuthorityStore(),
      toolGrants: { list, revoke },
      now: () => now,
    });
    for (const body of [
      { kind: "list" },
      { kind: "revoke", grantId: `sha256:${"b".repeat(64)}` },
    ]) {
      const response = await handler(pairedDeviceRequest("/api/extensions/tool-grants", body));
      expect(response?.status).toBe(401);
    }
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("lets a paired device list and approve its own turn's MCP prompt once, and refuses remembering it", async () => {
    const approvals = new ExtensionToolApprovalService({
      uuid: () => "44000000-0000-4000-8000-000000000010",
      now: () => now,
      isPairedDeviceScope: (scope) => String(scope) === pairedDeviceId,
      threadAuthorityIsCurrent: () => true,
    });
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: new WindowAuthorityStore(),
      toolApprovals: approvals,
      now: () => now,
    });
    const remember = vi.fn(() => true);
    const call = approvals.request({
      windowId: pairedDeviceId as never,
      threadId: "44000000-0000-4000-8000-000000000011",
      projectId: "44000000-0000-4000-8000-000000000012",
      extensionId,
      packageId,
      componentId: "server",
      serverName: "server",
      providerToolName: "plugin__server__read",
      mcpToolName: "read",
      inputJson: "{}",
      remember,
    });

    const listed = await handler(
      pairedDeviceRequest("/api/extensions/tool-approvals", { kind: "list" }),
    );
    expect(listed?.status).toBe(200);
    expect(await listed?.json()).toEqual([
      expect.objectContaining({ approvalId: "44000000-0000-4000-8000-000000000010" }),
    ]);
    const answer = {
      kind: "decide",
      approvalId: "44000000-0000-4000-8000-000000000010",
      decision: "approved",
    };
    const remembered = await handler(
      pairedDeviceRequest("/api/extensions/tool-approvals", { ...answer, remember: true }),
    );
    expect(remembered?.status).toBe(409);
    expect(remember).not.toHaveBeenCalled();
    // Nobody signed in: no window capability and no paired principal.
    const anonymous = await handler(
      new Request("http://127.0.0.1/api/extensions/tool-approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(answer),
      }),
    );
    expect(anonymous?.status).toBe(401);
    const approved = await handler(pairedDeviceRequest("/api/extensions/tool-approvals", answer));
    expect(approved?.status).toBe(200);
    await expect(call).resolves.toBe(true);
  });

  it("refuses a paired device another scope's MCP prompt", async () => {
    const approvals = new ExtensionToolApprovalService({
      uuid: () => "44000000-0000-4000-8000-000000000010",
      now: () => now,
      isPairedDeviceScope: () => true,
      threadAuthorityIsCurrent: () => true,
      windowCanReachThread: () => true,
    });
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: new WindowAuthorityStore(),
      toolApprovals: approvals,
      now: () => now,
    });
    const call = approvals.request({
      windowId: windowId as never,
      threadId: "44000000-0000-4000-8000-000000000011",
      projectId: "44000000-0000-4000-8000-000000000012",
      extensionId,
      packageId,
      componentId: "server",
      serverName: "server",
      providerToolName: "plugin__server__read",
      mcpToolName: "read",
      inputJson: "{}",
    });
    const listed = await handler(
      pairedDeviceRequest("/api/extensions/tool-approvals", { kind: "list" }),
    );
    expect(await listed?.json()).toEqual([]);
    const answered = await handler(
      pairedDeviceRequest("/api/extensions/tool-approvals", {
        kind: "decide",
        approvalId: "44000000-0000-4000-8000-000000000010",
        decision: "approved",
      }),
    );
    expect(answered?.status).toBe(409);
    approvals.revokeWindow(windowId as never);
    await expect(call).resolves.toBe(false);
  });

  it("imports a desktop-selected folder through a one-time window-bound receipt", async () => {
    const otherWindowId = "44000000-0000-4000-8000-000000000009";
    const otherCapability = "ZYXWVUTSRQPONMLKJIHGFEDCBAabcdefghijklmnop0";
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now });
    windowAuthorityStore.register({
      windowId: otherWindowId as never,
      capability: otherCapability,
      now,
    });
    const register = vi.fn(async () => ({
      source: { kind: "local-folder", sourceRef: "local-receipt" },
      notes: [],
    }));
    const execute = vi.fn(async () => ({
      kind: "extension-command-failed",
      failure: { category: "blocked", message: "Fixture inspection." },
    }));
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as ExtensionRouteService,
      windowAuthorityStore,
      desktopBridgeSecret: "desktop-secret",
      localPluginFolderRegistry: { register } as never,
      localPluginImportReceipts: new LocalPluginImportReceiptStore({
        randomBytes: () => Uint8Array.from({ length: 32 }, () => 5),
      }),
      now: () => now,
    });
    const issue = await handler(
      new Request("http://127.0.0.1/api/extensions/import-local-receipts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": "desktop-secret",
        },
        body: JSON.stringify({ windowId, absolutePath: "/Users/demo/hello-plugin" }),
      }),
    );
    expect(issue?.status).toBe(201);
    const issued = (await issue?.json()) as { receiptId: string };

    expect(
      (
        await handler(
          request(
            "/api/extensions/import-local",
            { receiptId: issued.receiptId },
            { "x-octant-window-capability": otherCapability },
          ),
        )
      )?.status,
    ).toBe(400);
    expect(
      (await handler(request("/api/extensions/import-local", { receiptId: issued.receiptId })))
        ?.status,
    ).toBe(200);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith("/Users/demo/hello-plugin");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      (await handler(request("/api/extensions/import-local", { receiptId: issued.receiptId })))
        ?.status,
    ).toBe(400);
    expect(
      (await handler(request("/api/extensions/import-local", { absolutePath: "/tmp/bypass" })))
        ?.status,
    ).toBe(400);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("refuses every package lifecycle command from a paired device before it reaches the service", async () => {
    const execute = vi.fn(
      async (): Promise<ExtensionCommandResult> => ({
        kind: "extension-state-updated",
        snapshot: setupSnapshot(),
      }),
    );
    const handler = setup({ snapshot: setupSnapshot, execute });
    const target = { extensionId, packageId, version: "1.0.0", digest };
    const mutation = { commandVersion: 1, extensionId, expectedStateVersion: 1 };
    for (const command of [
      { kind: "install-package", ...target },
      { kind: "update-package", ...target },
      { kind: "rollback-package", ...target },
      { kind: "uninstall-package", extensionId, packageId },
      { kind: "set-source-trust", ...mutation, trusted: true },
      { kind: "trust-new-publisher", ...mutation, publisherKey: `ed25519:${"b".repeat(64)}` },
      { kind: "forget-publisher", ...mutation, publisherKey: `ed25519:${"a".repeat(64)}` },
      { kind: "set-plugin-desired", ...mutation, desired: true },
      { kind: "set-component-desired", ...mutation, componentId: "driver", desired: true },
    ]) {
      const denied = await handler(pairedDeviceRequest("/api/extensions/lifecycle", command));
      expect(denied?.status).toBe(401);
    }
    expect(execute).not.toHaveBeenCalled();
    const accepted = await handler(
      request("/api/extensions/lifecycle", { kind: "install-package", ...target }),
    );
    expect(accepted?.status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses a paired device the inspection of an outside provider driver folder", async () => {
    const execute = vi.fn(
      async (): Promise<ExtensionCommandResult> => ({
        kind: "extension-command-failed",
        failure: { category: "unavailable", message: "Extension source is unavailable." },
      }),
    );
    const windowAuthorityStore = new WindowAuthorityStore();
    windowAuthorityStore.register({ windowId: windowId as never, capability, now });
    const formats: Readonly<Record<string, string>> = {
      "local-driver": "outside-provider-driver",
      "local-plugin": "agent-plugins",
    };
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute },
      windowAuthorityStore,
      localPluginFolderRegistry: {
        get: (sourceRef: string) =>
          formats[sourceRef] === undefined ? undefined : { format: formats[sourceRef] },
      } as never,
      now: () => now,
    });
    const driver = { kind: "local-folder", sourceRef: "local-driver" };
    for (const [path, kind] of [
      ["/api/extensions/inspect", "inspect-package"],
      ["/api/extensions/preview", "preview-package"],
    ] as const) {
      const denied = await handler(pairedDeviceRequest(path, { kind, source: driver }));
      expect(denied?.status).toBe(401);
    }
    expect(execute).not.toHaveBeenCalled();
    // A paired device may still read a plugin folder's review, and a local
    // window may still inspect the driver.
    const plugin = { kind: "local-folder", sourceRef: "local-plugin" };
    expect(
      (
        await handler(
          pairedDeviceRequest("/api/extensions/inspect", {
            kind: "inspect-package",
            source: plugin,
          }),
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await handler(
          request("/api/extensions/inspect", { kind: "inspect-package", source: driver }),
        )
      )?.status,
    ).toBe(200);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("rejects local-folder import from a remote device before reading the host path", async () => {
    const register = vi.fn();
    const handler = createExtensionRouteHandler({
      service: {
        snapshot: setupSnapshot,
        execute: vi.fn(),
      },
      windowAuthorityStore: new WindowAuthorityStore(),
      localPluginFolderRegistry: { register } as never,
      now: () => now,
    });
    const remoteRequest = new Request("http://127.0.0.1/api/extensions/import-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ absolutePath: "/Users/private/plugin" }),
    });
    bindPrincipalRouteContext(remoteRequest, {
      principal: {
        kind: "remote-device",
        hostId: "local",
        deviceId: "55000000-0000-4000-8000-000000000001",
        credentialGeneration: 1,
        origin: "https://remote.example",
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "55000000-0000-4000-8000-000000000002",
      } as never,
      scopeId: "55000000-0000-4000-8000-000000000001" as never,
    });

    const response = await handler(remoteRequest);

    expect(response?.status).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("serves only authenticated loopback requests from allowed renderer origins", async () => {
    const handler = setup();
    expect((await handler(request("/api/extensions/snapshot")))?.status).toBe(200);
    expect(
      (await handler(new Request("http://127.0.0.1/api/extensions/snapshot", { method: "POST" })))
        ?.status,
    ).toBe(401);
    expect(
      (
        await handler(
          request("/api/extensions/snapshot", undefined, { origin: "https://attacker.example" }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await handler(
          new Request("http://192.0.2.1/api/extensions/snapshot", {
            method: "POST",
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("rejects oversized, malformed, excess-property, and unsupported commands", async () => {
    const handler = setup(undefined, 256);
    const oversized = await handler(
      request("/api/extensions/lifecycle", { value: "x".repeat(512) }),
    );
    expect(oversized?.status).toBe(413);
    expect((await handler(request("/api/extensions/lifecycle", "not-a-command")))?.status).toBe(
      400,
    );
    expect(
      (
        await handler(
          request("/api/extensions/lifecycle", {
            kind: "uninstall-package",
            extensionId,
            packageId,
            secret: "must-not-pass",
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("decodes inspection and lifecycle commands before dispatch", async () => {
    const observed: Array<ExtensionCommand> = [];
    const service: ExtensionRouteService = {
      snapshot: setupSnapshot,
      execute: async (command) => {
        observed.push(command);
        return {
          kind: "extension-command-failed",
          failure: { category: "unavailable", message: "Extension source is unavailable." },
        };
      },
    };
    const handler = setup(service);
    const inspect = await handler(
      request("/api/extensions/inspect", {
        kind: "inspect-package",
        source: { kind: "catalog", catalogId: "octant", entryId: "fixture" },
        expectedDigest: digest,
      }),
    );
    const rollback = await handler(
      request("/api/extensions/lifecycle", {
        kind: "rollback-package",
        extensionId,
        packageId,
        version: "1.0.0",
        digest,
      }),
    );
    const search = await handler(
      request("/api/extensions/catalog", {
        kind: "search-catalog",
        query: "fixture",
      }),
    );
    const preview = await handler(
      request("/api/extensions/preview", {
        kind: "preview-package",
        source: { kind: "local-folder", sourceRef: "fixture" },
      }),
    );
    const skills = await handler(
      request("/api/extensions/skills", { kind: "search-skills", query: "review" }),
    );

    expect(inspect?.status).toBe(200);
    expect(rollback?.status).toBe(200);
    expect(search?.status).toBe(200);
    expect(preview?.status).toBe(200);
    expect(observed.map((command) => command.kind)).toEqual([
      "inspect-package",
      "rollback-package",
      "search-catalog",
      "preview-package",
      "search-skills",
    ]);
    expect(skills?.status).toBe(200);
  });

  it("dispatches scoped state queries and every desired-state mutation only on authenticated routes", async () => {
    const observed: Array<ExtensionCommand> = [];
    const handler = setup({
      snapshot: setupSnapshot,
      execute: async (command) => {
        observed.push(command);
        return {
          kind: "extension-command-failed",
          failure: { category: "blocked", message: "Fixture response." },
        };
      },
    });
    const state = await handler(
      request("/api/extensions/state", {
        kind: "query-effective-state",
        commandVersion: 1,
        scope: {
          hostId: "local",
          mode: "code",
          projectId: null,
          threadId: null,
          providerFamily: "ollama",
        },
      }),
    );
    const commands = [
      {
        kind: "set-source-trust",
        commandVersion: 1,
        extensionId,
        trusted: true,
        expectedStateVersion: 2,
      },
      {
        kind: "set-plugin-desired",
        commandVersion: 1,
        extensionId,
        desired: true,
        expectedStateVersion: 3,
      },
      {
        kind: "set-component-desired",
        commandVersion: 1,
        extensionId,
        componentId: "instructions",
        desired: true,
        expectedStateVersion: 4,
      },
    ] as const;
    for (const command of commands) {
      expect((await handler(request("/api/extensions/lifecycle", command)))?.status).toBe(200);
    }

    expect(state?.status).toBe(200);
    expect(observed.map((command) => command.kind)).toEqual([
      "query-effective-state",
      "set-source-trust",
      "set-plugin-desired",
      "set-component-desired",
    ]);
    expect(
      (
        await handler(
          new Request("http://127.0.0.1/api/extensions/state", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "query-effective-state",
              commandVersion: 1,
              scope: {
                hostId: "local",
                mode: "code",
                projectId: null,
                threadId: null,
                providerFamily: "ollama",
              },
            }),
          }),
        )
      )?.status,
    ).toBe(401);
  });

  it("normalizes thrown failures without private paths, credentials, or raw content", async () => {
    const handler = setup({
      snapshot: setupSnapshot,
      execute: async () => {
        throw new Error("/Users/private/archive.zip token=secret raw package content");
      },
    });
    const response = await handler(
      request("/api/extensions/lifecycle", {
        kind: "uninstall-package",
        extensionId,
        packageId,
      }),
    );
    const text = await response!.text();
    expect(response?.status).toBe(500);
    expect(text).toBe(
      '{"kind":"extension-command-failed","failure":{"category":"failed","message":"Extension command failed."}}',
    );
    expect(text).not.toContain("private");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("content");
  });
});

describe("extension route request abort propagation", () => {
  function noopLifecycle(): ExtensionLifecycleService {
    return {
      snapshot: setupSnapshot,
      install: async () => setupSnapshot(),
      update: async () => setupSnapshot(),
      rollback: async () => setupSnapshot(),
      disable: async () => setupSnapshot(),
      uninstall: async () => setupSnapshot(),
      reconcileStartup: async () => setupSnapshot(),
      setSourceTrust: async () => setupSnapshot(),
      setPluginDesired: async () => setupSnapshot(),
      setComponentDesired: async () => setupSnapshot(),
    } as unknown as ExtensionLifecycleService;
  }

  it("forwards HTTP Request abort signal route -> service -> resolver and returns interrupted without retaining inspection", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const resolver = {
      resolve: async (_command: never, signal?: AbortSignal): Promise<ResolvedExtensionPackage> => {
        observedSignal = signal;
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        // Wait for the signal to abort — event-driven, no timers.
        await new Promise<void>((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
        throw new DOMException("Aborted", "AbortError");
      },
    };
    const service = new ExtensionApiService({ lifecycle: noopLifecycle(), resolver });
    const handler = setup(service);

    const inspectResponsePromise = handler(
      new Request("http://127.0.0.1/api/extensions/inspect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "inspect-package",
          source: { kind: "catalog", catalogId: "octant", entryId: "fixture" },
        }),
        signal: controller.signal,
      }),
    );
    controller.abort();

    const inspectResponse = await inspectResponsePromise;
    expect(inspectResponse?.status).toBe(200);
    const inspectBody = (await inspectResponse!.json()) as ExtensionCommandResult;
    expect(inspectBody).toEqual({
      kind: "extension-command-failed",
      failure: { category: "interrupted", message: "Extension inspection was interrupted." },
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(true);

    // Verify no inspection was retained: a subsequent install must require inspection.
    const installResponse = await handler(
      new Request("http://127.0.0.1/api/extensions/lifecycle", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          kind: "install-package",
          extensionId,
          packageId,
          version: "1.0.0",
          digest,
        }),
      }),
    );
    const installBody = (await installResponse!.json()) as ExtensionCommandResult;
    expect(installBody.kind).toBe("extension-command-failed");
    if (installBody.kind === "extension-command-failed") {
      expect(installBody.failure.category).toBe("stale");
    }
  });
});

describe("MCP servers added by hand", () => {
  const body = {
    name: "Docs search",
    server: { type: "stdio", command: "npx", args: ["-y", "docs-search-mcp"], env: [] },
  };

  it("refuses a paired device and a host that cannot add one", async () => {
    const add = vi.fn();
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const denied = await handler(pairedDeviceRequest("/api/extensions/user-servers", body));
    expect(denied?.status).toBe(401);
    expect(add).not.toHaveBeenCalled();

    const without = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      now: () => now,
    });
    expect((await without(request("/api/extensions/user-servers", body)))?.status).toBe(503);
  });

  it("refuses a command carrying headers or an address carrying environment variables before writing anything", async () => {
    const add = vi.fn();
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const value = [{ name: "DOCS_TOKEN", value: "local-only-value", secret: true }];
    for (const server of [
      { ...body.server, headers: value },
      { type: "streamable-http", url: "https://mcp.example/mcp", headers: [], env: value },
    ]) {
      const answered = await handler(request("/api/extensions/user-servers", { ...body, server }));
      expect(answered?.status).toBe(400);
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("writes the package, then installs, trusts and switches it on as one act", async () => {
    const source = { kind: "user-added", sourceRef: "user-docs-search" } as const;
    const add = vi.fn(async () => ({ source }));
    const observed: Array<ExtensionCommand> = [];
    let stateVersion = 1;
    const packageState = (components: ReadonlyArray<string>) => ({
      extensionId,
      packageId,
      stateVersion: stateVersion++,
      version: "1.0.0",
      digest,
      source,
      components: components.map((id) => ({
        component: { id, kind: "mcp-server", displayName: "Docs search" },
      })),
    });
    const execute = vi.fn(async (command: ExtensionCommand) => {
      observed.push(command);
      if (command.kind === "inspect-package") {
        return {
          kind: "package-inspected",
          preview: { entry: { extensionId, packageId, version: "1.0.0", digest, source } },
        } as never;
      }
      return {
        kind: "extension-state-updated",
        snapshot: { ...setupSnapshot(), packages: [packageState(["mcp-docs-search"])] },
      } as never;
    });
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const answered = await handler(request("/api/extensions/user-servers", body));
    expect(answered?.status).toBe(200);
    expect(add).toHaveBeenCalledWith(body);
    expect(observed.map((command) => command.kind)).toEqual([
      "inspect-package",
      "install-package",
      "set-source-trust",
      "set-plugin-desired",
      "set-component-desired",
    ]);
    expect(observed[2]).toMatchObject({ trusted: true, expectedStateVersion: 1 });
    expect(observed[3]).toMatchObject({ desired: true, expectedStateVersion: 2 });
    expect(observed[4]).toMatchObject({
      componentId: "mcp-docs-search",
      desired: true,
      expectedStateVersion: 3,
    });
    expect(await answered?.json()).toMatchObject({
      kind: "extension-state-updated",
      addedPackage: { extensionId, componentId: "mcp-docs-search" },
    });
  });

  it("answers a refusal from the store with its own sentence", async () => {
    const add = vi.fn(async () => {
      throw new UserAddedMcpServerError("conflict", "A server with this name is already added.");
    });
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const answered = await handler(request("/api/extensions/user-servers", body));
    expect(answered?.status).toBe(200);
    expect(await answered?.json()).toMatchObject({
      failure: { category: "invalid", message: "A server with this name is already added." },
    });
  });

  it("removes the written package again when it cannot be installed, so the name stays free", async () => {
    const source = { kind: "user-added", sourceRef: "user-docs-search" } as const;
    const add = vi.fn(async () => ({ source }));
    const remove = vi.fn(async () => undefined);
    const execute = vi.fn(async (command: ExtensionCommand) =>
      command.kind === "inspect-package"
        ? ({
            kind: "package-inspected",
            preview: { entry: { extensionId, packageId, version: "1.0.0", digest, source } },
          } as never)
        : ({
            kind: "extension-command-failed",
            failure: { category: "blocked", message: "Install refused." },
          } as never),
    );
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      userAddedMcpServers: { add, remove } as never,
      now: () => now,
    });
    const answered = await handler(request("/api/extensions/user-servers", body));
    expect(answered?.status).toBe(200);
    expect(await answered?.json()).toMatchObject({
      failure: { category: "blocked", message: "Install refused." },
    });
    expect(remove).toHaveBeenCalledWith("user-docs-search");

    execute.mockRejectedValueOnce(new Error("interrupted"));
    await handler(request("/api/extensions/user-servers", body));
    expect(remove).toHaveBeenCalledTimes(2);
  });
});

describe("servers and plugins found on this computer", () => {
  const listing = {
    servers: [
      {
        id: "claude-00000000000000000000000000000001",
        origin: "claude-code",
        scope: "user",
        name: "docs",
        transport: "stdio",
        summary: "npx -y docs-mcp",
        needsValues: [],
        unsupportedPlaceholders: [],
        secretNames: ["DOCS_TOKEN"],
      },
    ],
    plugins: [
      {
        id: "codex-00000000000000000000000000000002",
        origin: "codex",
        name: "github@openai-curated",
        version: "1.1.0",
        format: "codex-plugin",
        enabledThere: true,
      },
    ],
    notes: [],
  };
  const found = {
    list: vi.fn(async () => listing),
    server: vi.fn((id: string) =>
      id === listing.servers[0]?.id
        ? {
            name: "docs",
            server: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: [] },
          }
        : undefined,
    ),
    refusal: vi.fn((): unknown => undefined),
    pluginPath: vi.fn((id: string) =>
      id === listing.plugins[0]?.id
        ? "/Users/ada/.codex/plugins/cache/openai-curated/github/1.1.0"
        : undefined,
    ),
  };

  it("lists for a local window only, and never names a path", async () => {
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      agentToolingDiscovery: found as never,
      now: () => now,
    });
    const denied = await handler(
      pairedDeviceRequest("/api/extensions/discovered", { kind: "list" }),
    );
    expect(denied?.status).toBe(401);
    const answered = await handler(request("/api/extensions/discovered", { kind: "list" }));
    expect(answered?.status).toBe(200);
    const body = await answered?.text();
    expect(JSON.parse(body ?? "")).toEqual(listing);
    expect(body).not.toContain("/Users/ada");
  });

  it("adds a found server through the same act as adding one by hand", async () => {
    const add = vi.fn(async () => ({ source: { kind: "user-added", sourceRef: "user-docs" } }));
    const execute = vi.fn(async (command: ExtensionCommand) =>
      command.kind === "inspect-package"
        ? ({
            kind: "package-inspected",
            preview: {
              entry: {
                extensionId,
                packageId,
                version: "1.0.0",
                digest,
                source: { kind: "user-added", sourceRef: "user-docs" },
              },
            },
          } as never)
        : ({ kind: "extension-state-updated", snapshot: setupSnapshot() } as never),
    );
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      agentToolingDiscovery: found as never,
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const answered = await handler(
      request("/api/extensions/discovered", { kind: "add-server", id: listing.servers[0]?.id }),
    );
    expect(answered?.status).toBe(200);
    expect(add).toHaveBeenCalledWith({
      name: "docs",
      server: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"], env: [] },
    });
    expect(execute.mock.calls.map(([command]) => command.kind)).toEqual([
      "inspect-package",
      "install-package",
    ]);
    const stale = await handler(
      request("/api/extensions/discovered", {
        kind: "add-server",
        id: "claude-00000000000000000000000000000099",
      }),
    );
    expect(stale?.status).toBe(404);
  });

  it("refuses to add a found server that still holds a placeholder, before anything is written", async () => {
    const add = vi.fn();
    const execute = vi.fn();
    found.refusal.mockReturnValueOnce({ kind: "unsupported-placeholders", names: ["API_TOKEN"] });
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      agentToolingDiscovery: found as never,
      userAddedMcpServers: { add } as never,
      now: () => now,
    });
    const answered = await handler(
      request("/api/extensions/discovered", { kind: "add-server", id: listing.servers[0]?.id }),
    );
    expect(answered?.status).toBe(400);
    expect(await answered?.json()).toMatchObject({
      failure: { category: "invalid", message: expect.stringContaining("API_TOKEN") },
    });
    expect(add).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("shows what the loader left out of a found plugin in the review's diagnostics", async () => {
    const register = vi.fn(async () => ({
      source: { kind: "local-folder", sourceRef: "local-github" },
      notes: ["api: needs values Claude Code asks for (user_config); left out."],
    }));
    const execute = vi.fn(async () => ({
      kind: "package-inspected",
      preview: { diagnostics: [{ code: "existing", message: "Already there." }] },
    }));
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      agentToolingDiscovery: found as never,
      localPluginFolderRegistry: { register } as never,
      now: () => now,
    });
    const answered = await handler(
      request("/api/extensions/discovered", { kind: "import-plugin", id: listing.plugins[0]?.id }),
    );
    expect(await answered?.json()).toMatchObject({
      kind: "package-inspected",
      preview: {
        diagnostics: [
          { code: "existing" },
          { message: "api: needs values Claude Code asks for (user_config); left out." },
        ],
      },
    });
  });

  it("imports a found plugin for review through the folder registry", async () => {
    const register = vi.fn(async () => ({
      source: { kind: "local-folder", sourceRef: "local-github" },
      notes: [],
    }));
    const execute = vi.fn(async () => ({
      kind: "extension-command-failed",
      failure: { category: "blocked", message: "Fixture inspection." },
    }));
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute } as never,
      windowAuthorityStore: registeredWindowStore(),
      agentToolingDiscovery: found as never,
      localPluginFolderRegistry: { register } as never,
      now: () => now,
    });
    const answered = await handler(
      request("/api/extensions/discovered", { kind: "import-plugin", id: listing.plugins[0]?.id }),
    );
    expect(answered?.status).toBe(200);
    expect(register).toHaveBeenCalledWith(
      "/Users/ada/.codex/plugins/cache/openai-curated/github/1.1.0",
    );
    expect(execute).toHaveBeenCalledWith(
      { kind: "inspect-package", source: { kind: "local-folder", sourceRef: "local-github" } },
      expect.anything(),
    );
  });
});

describe("signing in to a hosted server from Settings", () => {
  const target = { extensionId, componentId: "mcp-docs" };
  const signIn = {
    status: vi.fn(async () => ({ kind: "signed-out" })),
    begin: vi.fn(async (_e: string, _c: string, principal: string) =>
      principal === "local-window"
        ? {
            kind: "awaiting-consent",
            attemptId: "55000000-0000-4000-8000-000000000001",
            authorizationUrl: "https://auth.example/authorize?x=1",
            expiresAt: "2026-10-20T12:10:00.000Z",
          }
        : {
            kind: "refused",
            reason: "local-host-required",
            message: "Sign in from the Octant window on this host.",
          },
    ),
    poll: vi.fn(async () => ({ kind: "signed-in", issuer: "auth.example" })),
    signOut: vi.fn(async () => ({ kind: "signed-out" })),
  };

  it("lets a local window begin, poll and sign out, and tells a paired device to use the host", async () => {
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      mcpServerSignIn: signIn as never,
      now: () => now,
    });
    const status = await handler(request("/api/extensions/sign-in", { kind: "status", ...target }));
    expect(await status?.json()).toEqual({ kind: "signed-out" });
    expect(signIn.status).toHaveBeenCalledWith(extensionId, "mcp-docs", "local-window");
    const begun = await handler(request("/api/extensions/sign-in", { kind: "begin", ...target }));
    expect(await begun?.json()).toMatchObject({ kind: "awaiting-consent" });
    expect(signIn.begin).toHaveBeenCalledWith(extensionId, "mcp-docs", "local-window");
    const polled = await handler(
      request("/api/extensions/sign-in", {
        kind: "poll",
        ...target,
        attemptId: "55000000-0000-4000-8000-000000000001",
      }),
    );
    expect(await polled?.json()).toEqual({ kind: "signed-in", issuer: "auth.example" });
    const out = await handler(request("/api/extensions/sign-in", { kind: "sign-out", ...target }));
    expect(await out?.json()).toEqual({ kind: "signed-out" });

    await handler(pairedDeviceRequest("/api/extensions/sign-in", { kind: "status", ...target }));
    expect(signIn.status).toHaveBeenLastCalledWith(extensionId, "mcp-docs", "remote-device");
    const remote = await handler(
      pairedDeviceRequest("/api/extensions/sign-in", { kind: "begin", ...target }),
    );
    expect(remote?.status).toBe(200);
    expect(await remote?.json()).toMatchObject({ kind: "refused", reason: "local-host-required" });
    expect(signIn.begin).toHaveBeenLastCalledWith(extensionId, "mcp-docs", "remote-device");
  });

  it("answers 503 on a host without the sign-in service and 400 for a malformed request", async () => {
    const without = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      now: () => now,
    });
    expect(
      (await without(request("/api/extensions/sign-in", { kind: "status", ...target })))?.status,
    ).toBe(503);
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      mcpServerSignIn: signIn as never,
      now: () => now,
    });
    expect(
      (await handler(request("/api/extensions/sign-in", { kind: "poll", ...target })))?.status,
    ).toBe(400);
  });
});

describe("plugins pinned to a Project", () => {
  const projectId = "72000000-0000-4000-8000-00000000000a";
  const listing = {
    projects: [{ projectId, name: "Studio", type: "code" }],
    pins: [{ projectId, extensionId }],
  };
  const pins = { list: vi.fn(() => listing), set: vi.fn(() => "recorded" as const) };

  it("lets a local window pin and unpin, lists for a paired device, and refuses its pin", async () => {
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      extensionProjectPins: pins as never,
      now: () => now,
    });
    const set = await handler(
      request("/api/extensions/project-pins", {
        kind: "set",
        projectId,
        extensionId,
        pinned: true,
      }),
    );
    expect(set?.status).toBe(200);
    expect(pins.set).toHaveBeenCalledWith(projectId, extensionId, true);
    expect(await set?.json()).toEqual(listing);
    const listed = await handler(
      pairedDeviceRequest("/api/extensions/project-pins", { kind: "list" }),
    );
    expect(listed?.status).toBe(200);
    const denied = await handler(
      pairedDeviceRequest("/api/extensions/project-pins", {
        kind: "set",
        projectId,
        extensionId,
        pinned: false,
      }),
    );
    expect(denied?.status).toBe(401);
    expect(pins.set).toHaveBeenCalledTimes(1);
  });

  it("answers 400 when the store refuses the pin", async () => {
    const handler = createExtensionRouteHandler({
      service: { snapshot: setupSnapshot, execute: vi.fn() } as never,
      windowAuthorityStore: registeredWindowStore(),
      extensionProjectPins: { ...pins, set: vi.fn(() => "refused" as const) } as never,
      now: () => now,
    });
    const refused = await handler(
      request("/api/extensions/project-pins", {
        kind: "set",
        projectId,
        extensionId,
        pinned: true,
      }),
    );
    expect(refused?.status).toBe(400);
  });
});

function registeredWindowStore(): WindowAuthorityStore {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now });
  return windowAuthorityStore;
}

function setupSnapshot(): ExtensionSnapshot {
  return {
    sequence: 0 as never,
    snapshotAt: "2026-07-28T12:00:00.000Z" as never,
    packages: [],
    collisions: [],
  };
}
