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

const now = Date.parse("2026-07-28T12:00:00.000Z");
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const windowId = "44000000-0000-4000-8000-000000000001";
const extensionId = "44000000-0000-4000-8000-000000000002";
const packageId = "44000000-0000-4000-8000-000000000003";
const digest = `sha256:${"a".repeat(64)}`;

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
    expect(list).toHaveBeenCalledWith(windowId);
    expect(decide).toHaveBeenCalledWith(windowId, {
      approvalId: "44000000-0000-4000-8000-000000000010",
      decision: "approved",
    });
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

function setupSnapshot(): ExtensionSnapshot {
  return {
    sequence: 0 as never,
    snapshotAt: "2026-07-28T12:00:00.000Z" as never,
    packages: [],
    collisions: [],
  };
}
