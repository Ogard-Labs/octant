import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ contextBridge: {}, ipcRenderer: {} }));

import {
  HOST_BRIDGE_KEY,
  IPC_CHANNELS,
  createHostBridge,
  decodeInitialProjectTarget,
  decodeProjectWindowCapability,
  installHostBridge,
  type ContextBridgePort,
  type IpcRendererPort,
} from "./preload";

const projectWindowCapability = "C".repeat(43);
const projectId = "00000000-0000-4000-8000-000000000203";

describe("desktop preload bridge", () => {
  it("keeps the sandboxed preload free of runtime package imports", () => {
    const source = readFileSync(fileURLToPath(new URL("./preload.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*\}\s*from ["']@octant\//);
  });

  it("reports the native sidebar vibrancy capability through a fixed channel", async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ sidebarVibrancySupported: true, liveBrowserSupported: true });
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.getHostCapabilities?.()).resolves.toEqual({
      liveBrowserSupported: true,
      sidebarVibrancySupported: true,
    });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.hostCapabilities);
  });

  it("exposes only the accepted Octant host bridge", () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const ipc: IpcRendererPort = { invoke, on: vi.fn(), removeListener: vi.fn() };
    const exposeInMainWorld = vi.fn();
    const context: ContextBridgePort = { exposeInMainWorld };

    installHostBridge(context, ipc, projectWindowCapability, { kind: "project", projectId });

    expect(exposeInMainWorld).toHaveBeenCalledOnce();
    const [key, bridge] = exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toBe(HOST_BRIDGE_KEY);
    expect(Object.keys(bridge).sort()).toEqual([
      "approveRemotePairingRequest",
      "attachBrowserSurface",
      "clearProviderCredential",
      "close",
      "commandBrowserSurface",
      "denyRemotePairingRequest",
      "detachBrowserSurface",
      "disablePrivateListener",
      "enablePrivateListener",
      "getHostCapabilities",
      "getPrivateListenerStatus",
      "getRemoteDeviceInventory",
      "getRemoteHostIdentityRecovery",
      "initialProjectTarget",
      "listRemotePairingRequests",
      "maximizeOrRestore",
      "minimize",
      "notifyAttention",
      "openBrowserExternal",
      "openCodeExternalEditor",
      "openInNewWindow",
      "previewHandoff",
      "projectWindowCapability",
      "providerCredentialStatus",
      "reconcileExpiredRemoteDevices",
      "recoverRemoteHostIdentity",
      "renameRemoteDevice",
      "requestCodeOperationApproval",
      "resetBounds",
      "restartPrivateListener",
      "revokeAllRemoteDevices",
      "revokeRemoteDevice",
      "rotateRemoteHostIdentity",
      "selectLocalPluginFolder",
      "selectProjectRoot",
      "setAttentionBadge",
      "setProviderCredential",
      "setSidebarMaterialPreference",
      "setSidebarVibrancyMode",
      "subscribeBrowserSurfaceState",
      "subscribeCodeDeepLinks",
      "subscribeResolvedMaterial",
      "subscribeStartNewAgent",
      "updateBrowserSurfaceBounds",
    ]);
    expect(bridge).not.toHaveProperty("invoke");
    expect(bridge).not.toHaveProperty("send");
    expect(bridge.projectWindowCapability).toBe(projectWindowCapability);
    expect(bridge.initialProjectTarget).toEqual({ kind: "project", projectId });
    expect(Object.isFrozen(bridge.initialProjectTarget)).toBe(true);
    expect(JSON.stringify(bridge)).not.toContain("desktop-secret");
    expect(JSON.stringify(bridge)).not.toMatch(/resolve|getProviderCredential|private-value/i);
  });

  it("maps validated write-only credential operations to fixed channels", async () => {
    const providerInstanceId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
    const invoke = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("stored");
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await bridge.setProviderCredential(providerInstanceId, "private-value");
    await expect(bridge.providerCredentialStatus(providerInstanceId)).resolves.toBe("stored");
    await bridge.clearProviderCredential(providerInstanceId);

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.setProviderCredential, providerInstanceId, "private-value"],
      [IPC_CHANNELS.providerCredentialStatus, providerInstanceId],
      [IPC_CHANNELS.clearProviderCredential, providerInstanceId],
    ]);
    expect(JSON.stringify(bridge)).not.toContain("private-value");
  });

  it("rejects invalid credential requests before IPC and replaces raw failures", async () => {
    const providerInstanceId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
    const invoke = vi.fn().mockRejectedValue(new Error("private-value raw Keychain diagnostic"));
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.setProviderCredential("not-a-uuid", "value")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(bridge.setProviderCredential(providerInstanceId, "")).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(
      bridge.setProviderCredential(providerInstanceId, "x".repeat(12 * 1_024 + 1)),
    ).rejects.toBeInstanceOf(TypeError);
    expect(invoke).not.toHaveBeenCalled();

    const failure = await bridge
      .setProviderCredential(providerInstanceId, "private-value")
      .catch((error: unknown) => error);
    expect(String(failure)).not.toMatch(/private-value|Keychain/i);
  });

  it("maps every operation to a fixed allowlisted channel", async () => {
    const invoke = vi.fn(async (channel: string) =>
      channel === IPC_CHANNELS.requestCodeOperationApproval ? undefined : { kind: "cancelled" },
    );
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await bridge.minimize();
    await bridge.maximizeOrRestore();
    await bridge.close();
    await bridge.resetBounds();
    await bridge.setSidebarMaterialPreference("opaque");
    await bridge.setSidebarMaterialPreference("system");
    await bridge.setSidebarVibrancyMode("off");
    await bridge.setSidebarVibrancyMode("subtle");
    await bridge.setSidebarVibrancyMode("strong");
    await bridge.selectProjectRoot("work");
    await bridge.selectProjectRoot("code");
    await bridge.selectLocalPluginFolder();
    await bridge.openCodeExternalEditor({
      threadId: "20000000-0000-4000-8000-000000000001",
      checkoutId: "30000000-0000-4000-8000-000000000001",
      fileId: "40000000-0000-4000-8000-000000000001",
      line: 12,
      column: 4,
    });
    await bridge.openInNewWindow({ kind: "project", projectId });
    await bridge.requestCodeOperationApproval({
      effect: {
        kind: "operation",
        command: {
          kind: "start-terminal",
          threadId: "20000000-0000-4000-8000-000000000001",
          checkoutId: "30000000-0000-4000-8000-000000000001",
          operationId: "50000000-0000-4000-8000-000000000001",
          terminalId: "60000000-0000-4000-8000-000000000001",
          columns: 100,
          rows: 30,
          credentialRefs: [],
        },
      },
    } as never);

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.minimize],
      [IPC_CHANNELS.maximizeOrRestore],
      [IPC_CHANNELS.close],
      [IPC_CHANNELS.resetBounds],
      [IPC_CHANNELS.sidebarMaterialPreference, "opaque"],
      [IPC_CHANNELS.sidebarMaterialPreference, "system"],
      [IPC_CHANNELS.sidebarVibrancyMode, "off"],
      [IPC_CHANNELS.sidebarVibrancyMode, "subtle"],
      [IPC_CHANNELS.sidebarVibrancyMode, "strong"],
      [IPC_CHANNELS.selectProjectRoot, "work"],
      [IPC_CHANNELS.selectProjectRoot, "code"],
      [IPC_CHANNELS.selectLocalPluginFolder],
      [
        IPC_CHANNELS.openCodeExternalEditor,
        {
          threadId: "20000000-0000-4000-8000-000000000001",
          checkoutId: "30000000-0000-4000-8000-000000000001",
          fileId: "40000000-0000-4000-8000-000000000001",
          line: 12,
          column: 4,
        },
      ],
      [IPC_CHANNELS.openInNewWindow, { kind: "project", projectId }],
      [
        IPC_CHANNELS.requestCodeOperationApproval,
        {
          effect: {
            kind: "operation",
            command: {
              kind: "start-terminal",
              threadId: "20000000-0000-4000-8000-000000000001",
              checkoutId: "30000000-0000-4000-8000-000000000001",
              operationId: "50000000-0000-4000-8000-000000000001",
              terminalId: "60000000-0000-4000-8000-000000000001",
              columns: 100,
              rows: 30,
              credentialRefs: [],
            },
          },
        },
      ],
    ]);
  });

  it("maps attention notifications and the badge, rejecting malformed ones before IPC", async () => {
    const invoke = vi.fn(async () => undefined);
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await bridge.notifyAttention({ reason: "turn-finished", threadTitle: "Diff pane" });
    await bridge.setAttentionBadge(3);

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.attentionNotify, { reason: "turn-finished", threadTitle: "Diff pane" }],
      [IPC_CHANNELS.attentionBadge, 3],
    ]);

    invoke.mockClear();
    await expect(
      bridge.notifyAttention({ reason: "shipped" as never, threadTitle: "Diff pane" }),
    ).rejects.toThrow(TypeError);
    await expect(bridge.notifyAttention({ reason: "turn-finished", threadTitle: " " })).rejects.toThrow(
      TypeError,
    );
    await expect(bridge.setAttentionBadge(Number.NaN)).rejects.toThrow(TypeError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed Project window targets before IPC", async () => {
    const invoke = vi.fn();
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    for (const target of [
      { kind: "project", projectId: "not-a-uuid" },
      { kind: "project", projectId, extra: true },
      { kind: "thread", projectId },
      null,
    ]) {
      await expect(bridge.openInNewWindow(target as never)).rejects.toBeInstanceOf(TypeError);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects preview handoff requests that leak a path or kind before IPC", async () => {
    const invoke = vi.fn();
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );
    const target = {
      targetId: "20000000-0000-4000-8000-000000000001",
      projectId,
      hostId: "30000000-0000-4000-8000-000000000001",
      kind: "artifact-version",
      opaqueRef: "opaque-ref-token-1",
      displayName: "notes.md",
    };

    for (const request of [
      { target: { ...target, opaqueRef: "folder/notes.md" }, kind: "quick-look" },
      { target: { ...target, displayName: "../notes.md" }, kind: "quick-look" },
      { target: { ...target, targetId: "not-a-uuid" }, kind: "quick-look" },
      { target, kind: "shell-open" },
      { target, kind: "quick-look", path: "/host/secret" },
    ]) {
      expect(() => bridge.previewHandoff(request as never)).toThrow(TypeError);
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("validates Project type and strictly decodes a frozen receipt-only result", async () => {
    const receiptId = "R".repeat(43);
    const invoke = vi.fn().mockResolvedValue({ kind: "selected", receiptId, displayName: "repo" });
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    const selected = await bridge.selectProjectRoot("code");
    expect(selected).toEqual({ kind: "selected", receiptId, displayName: "repo" });
    expect(Object.isFrozen(selected)).toBe(true);

    invoke.mockResolvedValueOnce({ kind: "cancelled" });
    const cancelled = await bridge.selectProjectRoot("work");
    expect(cancelled).toEqual({ kind: "cancelled" });
    expect(Object.isFrozen(cancelled)).toBe(true);

    for (const invalidType of ["chat", "unknown", undefined]) {
      await expect(bridge.selectProjectRoot(invalidType as never)).rejects.toBeInstanceOf(
        TypeError,
      );
    }
    invoke.mockResolvedValueOnce({ kind: "selected", receiptId, path: "/private/raw" });
    await expect(bridge.selectProjectRoot("work")).rejects.toBeInstanceOf(TypeError);
  });

  it("restores allowlisted picker guidance across the IPC error boundary", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'octant:project:select-root': Error: Choose the top-level Git repository or linked-worktree folder.",
        ),
      );
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.selectProjectRoot("code")).rejects.toThrow(
      /^Choose the top-level Git repository or linked-worktree folder\.$/,
    );

    invoke.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'octant:project:select-root': Error: Choose an accessible directory.",
      ),
    );
    await expect(bridge.selectProjectRoot("work")).rejects.toThrow(
      /^Choose an accessible directory\.$/,
    );

    const unrelated = new Error("Octant could not validate the selected Project root.");
    invoke.mockRejectedValueOnce(unrelated);
    await expect(bridge.selectProjectRoot("work")).rejects.toBe(unrelated);
  });

  it("rejects arbitrary material preferences before IPC", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(
      bridge.setSidebarMaterialPreference("translucent" as never),
    ).rejects.toBeInstanceOf(TypeError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects arbitrary vibrancy modes before IPC", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.setSidebarVibrancyMode("vibrant" as never)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("strictly decodes one scoped capability from the Electron launch arguments", () => {
    expect(
      decodeProjectWindowCapability([
        "/Applications/Octant.app/Contents/MacOS/Octant",
        `--octant-project-capability=${projectWindowCapability}`,
      ]),
    ).toBe(projectWindowCapability);
    for (const args of [
      [],
      ["--octant-project-capability=short"],
      [
        `--octant-project-capability=${projectWindowCapability}`,
        `--octant-project-capability=${"D".repeat(43)}`,
      ],
    ]) {
      expect(() => decodeProjectWindowCapability(args)).toThrow(TypeError);
    }
  });

  it("strictly decodes an optional one-time Project target argument", () => {
    expect(decodeInitialProjectTarget([])).toBeUndefined();
    const target = decodeInitialProjectTarget([`--octant-initial-project-id=${projectId}`]);
    expect(target).toEqual({ kind: "project", projectId });
    expect(Object.isFrozen(target)).toBe(true);
    expect(
      decodeInitialProjectTarget([
        `--octant-initial-project-id=${projectId}`,
        "--octant-initial-thread-mode=code",
        "--octant-initial-thread-id=00000000-0000-4000-8000-000000000204",
      ]),
    ).toEqual({
      kind: "project-thread",
      projectId,
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000204",
    });

    for (const args of [
      ["--octant-initial-project-id=not-a-uuid"],
      [
        "--octant-initial-thread-mode=code",
        "--octant-initial-thread-id=00000000-0000-4000-8000-000000000204",
      ],
      [`--octant-initial-project-id=${projectId}`, `--octant-initial-project-id=${projectId}`],
    ]) {
      expect(() => decodeInitialProjectTarget(args)).toThrow(TypeError);
    }
  });

  it("rejects invalid material payloads and removes only its own subscription", () => {
    let registered: ((event: unknown, material: unknown) => void) | undefined;
    const ipc: IpcRendererPort = {
      invoke: vi.fn(),
      on: vi.fn((_channel, listener) => {
        registered = listener;
      }),
      removeListener: vi.fn(),
    };
    const listener = vi.fn();
    const unsubscribe = createHostBridge(ipc, projectWindowCapability).subscribeResolvedMaterial(
      listener,
    );

    registered?.({}, "translucent");
    registered?.({}, "glass");
    registered?.({}, { material: "opaque" });
    registered?.({}, "opaque");

    expect(listener.mock.calls).toEqual([["translucent"], ["opaque"]]);
    unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.resolvedMaterial, registered);
  });

  it("forwards menu-bar start-new-agent events without exposing IPC", () => {
    let registered: ((event: unknown) => void) | undefined;
    const ipc: IpcRendererPort = {
      invoke: vi.fn(),
      on: vi.fn((_channel, listener) => {
        registered = listener as (event: unknown) => void;
      }),
      removeListener: vi.fn(),
    };
    const listener = vi.fn();
    const unsubscribe = createHostBridge(ipc, projectWindowCapability).subscribeStartNewAgent(
      listener,
    );

    registered?.({});
    unsubscribe();

    expect(listener).toHaveBeenCalledOnce();
    expect(ipc.on).toHaveBeenCalledWith(IPC_CHANNELS.startNewAgent, registered);
    expect(ipc.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.startNewAgent, registered);
  });

  it("maps private listener status and enable/disable through fixed channels without secrets", async () => {
    const disabled = {
      enabled: false,
      state: "disabled",
      hostname: null,
      port: null,
      origin: null,
      exposureClass: null,
      certificateFingerprint: null,
      certificateReady: false,
    };
    const ready = {
      enabled: true,
      state: "ready",
      hostname: "192.168.1.20",
      port: 9443,
      origin: "https://192.168.1.20:9443",
      exposureClass: "lan-private",
      certificateFingerprint: "ab".repeat(32),
      certificateReady: true,
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(disabled);
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.getPrivateListenerStatus()).resolves.toEqual(disabled);
    await expect(
      bridge.enablePrivateListener({
        hostname: "192.168.1.20",
        port: 9443,
        origin: "https://192.168.1.20:9443",
        certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
        localConfirmation: true,
      }),
    ).resolves.toEqual(ready);
    await expect(bridge.disablePrivateListener()).resolves.toEqual(disabled);

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.privateListenerStatus],
      [
        IPC_CHANNELS.privateListenerEnable,
        {
          hostname: "192.168.1.20",
          port: 9443,
          origin: "https://192.168.1.20:9443",
          certificatePem: "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----",
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nDEF\n-----END PRIVATE KEY-----",
          localConfirmation: true,
        },
      ],
      [IPC_CHANNELS.privateListenerDisable],
    ]);
    expect(JSON.stringify(ready)).not.toMatch(/BEGIN PRIVATE KEY|private-value/i);
  });

  it("rejects invalid private listener enable requests before IPC and sanitizes failures", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("private PEM diagnostic"));
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(
      bridge.enablePrivateListener({
        hostname: "192.168.1.20",
        port: 9443,
        origin: "https://192.168.1.20:9443",
        certificatePem: "",
        privateKeyPem: "key",
        localConfirmation: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(invoke).not.toHaveBeenCalled();

    const failure = await bridge
      .enablePrivateListener({
        hostname: "192.168.1.20",
        port: 9443,
        origin: "https://192.168.1.20:9443",
        certificatePem: "cert",
        privateKeyPem: "key",
        localConfirmation: true,
      })
      .catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("could not enable the private listener");
    expect(String(failure)).not.toContain("PEM");
  });

  it("maps local pairing and device inventory controls without exposing key material", async () => {
    const ticketId = "11111111-1111-4111-8111-111111111111";
    const deviceId = "22222222-2222-4222-8222-222222222222";
    const device = {
      hostId: "33333333-3333-4333-8333-333333333333",
      deviceId,
      deviceKeyFingerprint: "a".repeat(64),
      deviceLabel: "Safari",
      origin: "https://mac.example.test",
      protocolFloor: 1,
      credentialGeneration: 1,
      createdAt: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-10-30T10:00:00.000Z",
      lastSeenAt: "2026-08-01T10:00:00.000Z",
      state: "active",
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ decision: "approved", device })
      .mockResolvedValueOnce({ decision: "denied" })
      .mockResolvedValueOnce([device])
      .mockResolvedValueOnce(device)
      .mockResolvedValue({
        commandId: "44444444-4444-4444-8444-444444444444",
        result: "applied",
        occurredAt: "2026-08-01T10:00:00.000Z",
      });
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );

    await expect(bridge.listRemotePairingRequests()).resolves.toEqual([]);
    await expect(bridge.approveRemotePairingRequest(ticketId)).resolves.toMatchObject({
      decision: "approved",
      device: { deviceId },
    });
    await expect(bridge.denyRemotePairingRequest(ticketId, "user-denied")).resolves.toEqual({
      decision: "denied",
    });
    await expect(bridge.getRemoteDeviceInventory()).resolves.toEqual([device]);
    await expect(bridge.renameRemoteDevice(deviceId, "Living Room")).resolves.toEqual(device);
    await expect(bridge.revokeRemoteDevice(deviceId)).resolves.toMatchObject({ result: "applied" });
    await expect(bridge.revokeAllRemoteDevices()).resolves.toMatchObject({ result: "applied" });
    await expect(bridge.reconcileExpiredRemoteDevices()).resolves.toMatchObject({
      result: "applied",
    });
    expect(invoke.mock.calls.slice(0, 8)).toEqual([
      [IPC_CHANNELS.remotePairingRequests],
      [IPC_CHANNELS.remotePairingApprove, ticketId],
      [IPC_CHANNELS.remotePairingDeny, ticketId, "user-denied"],
      [IPC_CHANNELS.remoteDeviceInventory],
      [IPC_CHANNELS.remoteDeviceRename, deviceId, "Living Room"],
      [IPC_CHANNELS.remoteDeviceRevoke, deviceId],
      [IPC_CHANNELS.remoteDeviceRevokeAll],
      [IPC_CHANNELS.remoteDeviceReconcileExpired],
    ]);
    expect(JSON.stringify(device)).not.toMatch(/PRIVATE KEY|cookie|session secret/i);
  });

  it("maps host-identity recovery and rotation without exposing key material", async () => {
    const recovery = {
      status: "ready",
      reason: null,
      remoteIdentityUsable: true,
      localDesktopUsable: true,
      fingerprint: "a".repeat(64),
    };
    const invoke = vi
      .fn()
      .mockResolvedValueOnce(recovery)
      .mockResolvedValueOnce({ status: "rotated", fingerprint: "b".repeat(64) })
      .mockResolvedValueOnce(recovery);
    const bridge = createHostBridge(
      { invoke, on: vi.fn(), removeListener: vi.fn() },
      projectWindowCapability,
    );
    await expect(bridge.getRemoteHostIdentityRecovery()).resolves.toEqual(recovery);
    await expect(bridge.rotateRemoteHostIdentity()).resolves.toEqual({
      status: "rotated",
      fingerprint: "b".repeat(64),
    });
    await expect(bridge.recoverRemoteHostIdentity()).resolves.toEqual(recovery);
    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.remoteHostIdentityStatus],
      [IPC_CHANNELS.remoteHostIdentityRotate],
      [IPC_CHANNELS.remoteHostIdentityRecover],
    ]);
    expect(JSON.stringify(bridge)).not.toMatch(/PRIVATE KEY|privateKey|session secret/i);
  });
});
