import { expect, it, vi } from "vitest";
import {
  decodeBrowserContextId,
  decodeBrowserContextPolicy,
  decodePersistentBrowserLeaseBinding,
} from "@octant/contracts";
import {
  createBrowserSurfaceHost,
  type BrowserSurfaceViewPort,
} from "../../../desktop/src/browserSurfaceHost";
import { startBrowserRuntimeBroker } from "../../../desktop/src/browserRuntimeBroker";
import { DesktopBrowserRuntime } from "./desktopBrowserRuntime";
import { shutDownForQuit } from "../../../desktop/src/quitShutdown";

/** Native-view fixture only: the production host, HTTP broker and adapter are real. */
function fixtureView(): BrowserSurfaceViewPort {
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents: {
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        toJPEG: () => Uint8Array.from([1, 2, 3]),
      })),
      close: vi.fn(),
      executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined),
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: () => false,
        sendCommand: vi.fn(async () => undefined),
      },
      getTitle: () => "Synthetic page",
      getURL: () => "https://example.com/",
      isDestroyed: () => false,
      isLoading: () => false,
      loadURL: vi.fn(async () => undefined),
      mainFrame: { framesInSubtree: [] },
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
      on: vi.fn(),
      reload: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
      session: {
        on: vi.fn(),
        setCertificateVerifyProc: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        setDisplayMediaRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onErrorOccurred: vi.fn(), onCompleted: vi.fn() },
      },
    },
  };
}

it("keeps a native execution lease after its review window closes and invalidates it on generation rotation and quit", async () => {
  let windowPresent = true;
  const views: BrowserSurfaceViewPort[] = [];
  const host = createBrowserSurfaceHost({
    isOwnerWindowAvailable: () => windowPresent,
    createView: () => {
      const view = fixtureView();
      views.push(view);
      return view;
    },
  });
  const broker = await startBrowserRuntimeBroker(host);
  const runtime = new DesktopBrowserRuntime({ brokerUrl: broker.url, token: broker.token });
  const contextId = decodeBrowserContextId("60000000-0000-4000-8000-000000000001");
  const policy = decodeBrowserContextPolicy({
    profileMode: "isolated",
    profile: { kind: "personal" },
    allowedOrigins: ["https://example.com"],
    credentialFieldProtection: true,
    maxConcurrentTabs: 1,
    sessionTimeoutMs: 300000,
  });
  try {
    expect(await runtime.persistentOwner.status()).toEqual({ status: "disabled" });
    const ready = await runtime.persistentOwner.configure(true);
    if (ready.status !== "ready") throw Error("Expected native owner");
    const binding = decodePersistentBrowserLeaseBinding({
      ownerId: ready.ownerId,
      grantId: "10000000-0000-4000-8000-000000000002",
      executionId: "host-run",
      threadId: "10000000-0000-4000-8000-000000000003",
      mode: "work",
      projectId: "10000000-0000-4000-8000-000000000004",
      providerId: "provider",
      modelId: "model",
      authorityRevision: "reviewed-task",
      profile: policy.profile,
      origins: policy.allowedOrigins,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const created = await runtime.persistentOwner.createContext(
      contextId,
      policy,
      new AbortController().signal,
      binding,
    );
    expect(created.status).toBe("created");
    windowPresent = false;
    await host.closeOwnerContexts("actual-review-window");
    await expect(
      runtime.act(contextId, { kind: "observe-diagnostics" }, new AbortController().signal),
    ).resolves.toBeDefined();
    expect(await runtime.peek(contextId, new AbortController().signal)).toMatchObject({
      title: "Synthetic page",
    });
    expect(views[0]?.webContents.close).not.toHaveBeenCalled();
    await runtime.persistentOwner.configure(false);
    expect(views[0]?.webContents.close).toHaveBeenCalledOnce();
    const replacement = await runtime.persistentOwner.configure(true);
    expect(replacement).not.toEqual(ready);
    expect(
      await runtime.persistentOwner.createContext(
        contextId,
        policy,
        new AbortController().signal,
        binding,
      ),
    ).toEqual({ status: "unavailable" });
    await expect(
      runtime.act(contextId, { kind: "snapshot" }, new AbortController().signal),
    ).rejects.toThrow();
    expect(views).toHaveLength(1);
    if (replacement.status !== "ready") throw Error("Expected replacement owner");
    expect(
      (
        await runtime.persistentOwner.createContext(
          contextId,
          policy,
          new AbortController().signal,
          { ...binding, ownerId: replacement.ownerId, executionId: "separately-reviewed-new-run" },
        )
      ).status,
    ).toBe("created");
    const flush = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let nativeClose: Promise<"closed" | "unconfirmed"> | undefined;
    const quitting = shutDownForQuit({
      closeAdmission: () => {
        nativeClose = host.persistentOwner.close();
      },
      flushWindowState: () => {
        entered.resolve();
        return flush.promise;
      },
      stopHost: async () => {
        expect(await nativeClose).toBe("closed");
      },
      log: vi.fn(),
    });
    try {
      await entered.promise;
      expect(
        await runtime.persistentOwner.createContext(
          decodeBrowserContextId("60000000-0000-4000-8000-000000000002"),
          policy,
          new AbortController().signal,
          { ...binding, ownerId: replacement.ownerId, executionId: "new-after-accepted-quit" },
        ),
      ).toEqual({ status: "unavailable" });
      await expect(
        runtime.act(contextId, { kind: "observe-diagnostics" }, new AbortController().signal),
      ).rejects.toThrow();
    } finally {
      flush.resolve();
      await quitting;
    }
    expect(views[1]?.webContents.close).toHaveBeenCalledOnce();
    expect(await runtime.persistentOwner.configure(true)).toEqual({ status: "unavailable" });
  } finally {
    await runtime.closeAll();
    await broker.close();
  }
});
