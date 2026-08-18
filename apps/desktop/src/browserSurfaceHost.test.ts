import { describe, expect, it, vi } from "vitest";
import { createBrowserSurfaceHost, type BrowserSurfaceViewPort } from "./browserSurfaceHost";

const contextId = "60000000-0000-4000-8000-000000000001";
const threadId = "10000000-0000-4000-8000-000000000001";

function view(): BrowserSurfaceViewPort {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  let debuggerAttached = false;
  return {
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    webContents: {
      capturePage: vi.fn(async () => ({ toJPEG: () => Uint8Array.from([1, 2, 3]) })),
      close: vi.fn(),
      debugger: {
        attach: vi.fn(() => {
          debuggerAttached = true;
        }),
        detach: vi.fn(() => {
          debuggerAttached = false;
        }),
        isAttached: vi.fn(() => debuggerAttached),
        sendCommand: vi.fn(async () => undefined),
      },
      executeJavaScriptInIsolatedWorld: vi.fn(async () => undefined),
      getTitle: vi.fn(() => "Example"),
      getURL: vi.fn(() => "https://example.com/"),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      mainFrame: { framesInSubtree: [] },
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => true),
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      reload: vi.fn(),
      session: {
        on: vi.fn(),
        setCertificateVerifyProc: vi.fn(),
        setDevicePermissionHandler: vi.fn(),
        setDisplayMediaRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
      },
      setWindowOpenHandler: vi.fn(),
      stop: vi.fn(),
    },
  };
}

describe("BrowserSurfaceHost", () => {
  it("refuses certificate acceptance it cannot bind to this surface's one origin", async () => {
    // Local-certificate acceptance is bounded to the exact origin this tab was
    // opened for.
    // Electron's certificate verify proc reports only `request.hostname` — no
    // scheme, no port, no URL — because Chromium verifies a certificate against
    // a host, and the result is cached by the network service. A second
    // self-signed service on another port of the same loopback host is
    // therefore indistinguishable from the allowed origin, and subresource
    // requests never reach the navigation guard. Fail closed: install no
    // acceptance override at all and leave Chromium's verdict in force.
    const accepting = view();
    const acceptingHost = createBrowserSurfaceHost({ createView: vi.fn(() => accepting) });
    await acceptingHost.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://127.0.0.1:8443"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
        acceptsLocalCertificate: true,
      },
    });

    expect(accepting.webContents.session.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it("creates one sandboxed isolated surface and denies permissions and popups", async () => {
    const created = view();
    const createView = vi.fn(() => created);
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    expect(createView).toHaveBeenCalledWith({
      partition: `octant-browser-${contextId}`,
      webPreferences: {
        allowRunningInsecureContent: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(created.webContents.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setDevicePermissionHandler).toHaveBeenCalledOnce();
    expect(created.webContents.session.setDisplayMediaRequestHandler).toHaveBeenCalledOnce();
    const permissionHandler = vi.mocked(created.webContents.session.setPermissionRequestHandler)
      .mock.calls[0]?.[0];
    const permissionDecision = vi.fn();
    permissionHandler?.(created.webContents, "geolocation", permissionDecision);
    expect(permissionDecision).toHaveBeenCalledWith(false);
    const downloadHandler = vi
      .mocked(created.webContents.session.on)
      .mock.calls.find(([event]) => event === "will-download")?.[1];
    const preventDownload = vi.fn();
    downloadHandler?.({ preventDefault: preventDownload });
    expect(preventDownload).toHaveBeenCalledOnce();
    const popupHandler = vi.mocked(created.webContents.setWindowOpenHandler).mock.calls[0]?.[0];
    expect(popupHandler?.({ url: "https://example.com/popup" })).toEqual({ action: "deny" });

    const redirectGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-redirect")?.[1];
    const preventRedirect = vi.fn();
    redirectGuard?.({ preventDefault: preventRedirect }, { url: "https://attacker.invalid/" });
    expect(preventRedirect).toHaveBeenCalledOnce();
    const allowRedirect = vi.fn();
    redirectGuard?.({ preventDefault: allowRedirect }, { url: "https://example.com/next" });
    expect(allowRedirect).not.toHaveBeenCalled();
    const frameNavigationGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-frame-navigate")?.[1];
    const allowFrameNavigation = vi.fn();
    frameNavigationGuard?.({
      url: "https://example.com/account",
      isMainFrame: true,
      preventDefault: allowFrameNavigation,
    });
    expect(allowFrameNavigation).not.toHaveBeenCalled();
    const loginHandler = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "login")?.[1];
    const preventLogin = vi.fn();
    const cancelLogin = vi.fn();
    loginHandler?.({ preventDefault: preventLogin }, {}, {}, cancelLogin);
    expect(preventLogin).toHaveBeenCalledOnce();
    expect(cancelLogin).toHaveBeenCalledWith();
    const certificateHandler = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "select-client-certificate")?.[1];
    const preventCertificate = vi.fn();
    const rejectCertificate = vi.fn();
    certificateHandler?.({ preventDefault: preventCertificate }, {}, rejectCertificate);
    expect(preventCertificate).toHaveBeenCalledOnce();
    expect(rejectCertificate).toHaveBeenCalledWith();
  });

  it("attaches only to its owning Project window and hides on detach", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const window = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };

    expect(() =>
      host.attach(contextId, { windowId: "window-b", threadId }, window, {
        x: 10,
        y: 20,
        width: 640,
        height: 480,
      }),
    ).toThrow("owning Project window");

    host.attach(contextId, { windowId: "window-a", threadId }, window, {
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });
    expect(window.contentView.addChildView).toHaveBeenCalledWith(created);
    expect(created.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 640, height: 480 });
    expect(created.setVisible).toHaveBeenLastCalledWith(true);

    expect(() =>
      host.updateBounds(
        contextId,
        { windowId: "window-a", threadId },
        {
          x: Number.NaN,
          y: 20,
          width: 640,
          height: 480,
        },
      ),
    ).toThrow("invalid Browser surface bounds");
    await expect(
      host.command(contextId, { windowId: "window-b", threadId }, "reload"),
    ).rejects.toThrow("does not own this context");

    host.detach(contextId, { windowId: "window-a", threadId });
    expect(created.setVisible).toHaveBeenLastCalledWith(false);
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(created);
  });

  it("rejects navigation outside the server-owned allowlist and destroys closed contents", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await expect(
      host.act(contextId, { kind: "navigate", target: "https://attacker.invalid/" }),
    ).rejects.toThrow("allowlist");
    await host.act(contextId, { kind: "navigate", target: "https://example.com/docs" });
    expect(created.webContents.loadURL).toHaveBeenCalledWith("https://example.com/docs");

    await host.closeContext(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
    await expect(host.act(contextId, { kind: "screenshot" })).rejects.toThrow("unknown");
  });

  it("names the refused redirect target when an allowed navigation moves off-origin", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const redirectGuard = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "will-redirect")?.[1];
    // Chromium cancels the load when the guard refuses the redirect, so
    // loadURL rejects with an opaque ERR_ABORTED after the guard has run.
    vi.mocked(created.webContents.loadURL).mockImplementationOnce(async () => {
      redirectGuard?.({ preventDefault: vi.fn() }, { url: "https://www.example.com/" });
      throw new Error("ERR_ABORTED (-3) loading 'https://example.com/'");
    });
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/" }),
    ).rejects.toMatchObject({
      name: "BrowserNavigationBlockedError",
      url: "https://www.example.com/",
    });
    // The refusal is per action: an unrelated later failure keeps its own cause.
    vi.mocked(created.webContents.loadURL).mockRejectedValueOnce(new Error("ERR_TIMED_OUT"));
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/" }),
    ).rejects.toThrow("ERR_TIMED_OUT");
  });

  it("serializes user chrome commands behind an in-flight agent action", async () => {
    const created = view();
    let releaseAction!: () => void;
    const action = new Promise<{ x: number; y: number }>((resolve) => {
      releaseAction = () => resolve({ x: 20, y: 30 });
    });
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockImplementationOnce(async () => action)
      .mockResolvedValue(undefined);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const window = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    host.attach(contextId, { windowId: "window-a", threadId }, window, {
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });

    const agentAction = host.act(contextId, { kind: "click", target: "#continue" });
    await vi.waitFor(() =>
      expect(window.webContents.send).toHaveBeenCalledWith(
        "octant:browser-surface:state",
        expect.objectContaining({ control: "agent" }),
      ),
    );
    const mouseGate = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "before-mouse-event")?.[1];
    const preventMouseRace = vi.fn();
    mouseGate?.({ preventDefault: preventMouseRace }, { type: "mouseDown" });
    expect(preventMouseRace).toHaveBeenCalledOnce();
    const userCommand = Promise.resolve(
      host.command(contextId, { windowId: "window-a", threadId }, "reload"),
    );
    expect(created.webContents.reload).not.toHaveBeenCalled();

    releaseAction();
    await agentAction;
    await userCommand;
    expect(created.webContents.reload).toHaveBeenCalledOnce();
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      "octant:browser-surface:state",
      expect.objectContaining({ control: "user" }),
    );
  });

  it("omits sensitive document text, hashes, and screenshots from observations", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockResolvedValueOnce("one-time code 123456")
      .mockResolvedValueOnce({ width: 1280, height: 720 })
      .mockResolvedValueOnce(true);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    const observation = await host.act(contextId, { kind: "screenshot" });
    expect(observation.extractedText).toBeUndefined();
    expect(observation.contentHash).toBeUndefined();
    expect(observation.screenshotDataUrl).toBeUndefined();
  });

  it("keeps the native context reusable after an agent closes its current tab", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.act(contextId, { kind: "close-tab" });
    expect(created.webContents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(created.webContents.close).not.toHaveBeenCalled();
    await host.act(contextId, { kind: "navigate", target: "https://example.com/next" });
    expect(created.webContents.loadURL).toHaveBeenLastCalledWith("https://example.com/next");
  });

  it("reports a crashed native page so only that server context becomes stale", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const crashed = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "render-process-gone")?.[1];

    crashed?.();

    expect(gone).toHaveBeenCalledWith(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
    await expect(host.act(contextId, { kind: "extract-text" })).rejects.toThrow("unknown");
  });

  it("reports owner cleanup so the server does not retain an active native context", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.closeOwnerContexts("window-a");

    expect(gone).toHaveBeenCalledWith(contextId);
    expect(created.webContents.close).toHaveBeenCalledOnce();
  });

  it("does not execute a native action after its broker request is cancelled", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(host.act(contextId, { kind: "extract-text" }, abort.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(created.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("drives page controls through trusted Chromium input instead of synthetic DOM events", async () => {
    const created = view();
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld)
      .mockResolvedValueOnce({ x: 24, y: 36 })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce(false);
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });

    await host.act(contextId, { kind: "click", target: "#continue" });

    expect(created.webContents.debugger.attach).toHaveBeenCalledWith("1.3");
    expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Input.dispatchMouseEvent",
      expect.objectContaining({ type: "mousePressed", x: 24, y: 36 }),
    );
    expect(created.webContents.debugger.detach).toHaveBeenCalledOnce();
  });
  it("lets the person reach a new origin without handing the agent that page", async () => {
    // Browsing is the person's own action, so a link they follow may leave the
    // origins approval granted. What must not follow is the agent inheriting
    // it: the page they reached is theirs to read, not the agent's.
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });
    const listener = (event: string) =>
      vi.mocked(created.webContents.on).mock.calls.find(([name]) => name === event)?.[1];

    listener("focus")?.();
    const followed = vi.fn();
    listener("will-navigate")?.({ preventDefault: followed }, { url: "https://research.test/a" });
    expect(followed).not.toHaveBeenCalled();
    const again = vi.fn();
    listener("will-navigate")?.({ preventDefault: again }, { url: "https://research.test/b" });
    expect(again).not.toHaveBeenCalled();

    vi.mocked(created.webContents.getURL).mockReturnValue("https://research.test/a");
    await expect(host.act(contextId, { kind: "extract-text" })).rejects.toThrow("allowed origins");
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://research.test/a" }),
    ).rejects.toThrow("allowlist");
  });

  it("refuses a page the agent could not manage to leave", async () => {
    const created = view();
    const host = createBrowserSurfaceHost({ createView: () => created });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
    });
    vi.mocked(created.webContents.getURL).mockReturnValue("https://research.test/a");

    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/next" }),
    ).rejects.toThrow("allowed origins");
  });

  it("opens a second page in the same session and shows one tab at a time", async () => {
    const views = [view(), view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({
      createView: () => views[opened++] ?? view(),
    });
    const shellWindow = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    };
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 2,
        sessionTimeoutMs: 300_000,
      },
    });
    host.attach(contextId, { windowId: "window-a", threadId }, shellWindow, {
      x: 10,
      y: 20,
      width: 400,
      height: 300,
    });

    const twoTabs = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "open" },
    );

    // One partition, so a sign-in in the first tab is a sign-in in the second.
    expect(opened).toBe(2);
    expect(views[1]?.webContents.loadURL).toHaveBeenCalledWith("about:blank");
    expect(twoTabs.tabs).toHaveLength(2);
    expect(twoTabs.activeTabId).toBe(twoTabs.tabs[1]?.tabId);
    // The outgoing tab leaves the window rather than merely turning invisible:
    // a hidden child view still holds the same rectangle.
    expect(shellWindow.contentView.removeChildView).toHaveBeenCalledWith(views[0]);
    expect(views[1]?.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 400, height: 300 });
    await expect(
      host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" }),
    ).rejects.toThrow("tab limit");

    const back = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: twoTabs.tabs[0]!.tabId },
    );
    expect(back.activeTabId).toBe(twoTabs.tabs[0]?.tabId);

    const closed = await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "close", tabId: twoTabs.tabs[0]!.tabId },
    );
    expect(closed.tabs).toHaveLength(1);
    expect(closed.activeTabId).toBe(twoTabs.tabs[1]?.tabId);
    expect(views[0]?.webContents.close).toHaveBeenCalledOnce();
    await expect(
      host.tabCommand(
        contextId,
        { windowId: "window-a", threadId },
        { kind: "close", tabId: closed.tabs[0]!.tabId },
      ),
    ).rejects.toThrow("only tab");
  });

  it("keeps a research session when one of its tabs goes away on its own", async () => {
    const views = [view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({ createView: () => views[opened++] ?? view() });
    const gone = vi.fn();
    host.onContextGone(gone);
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });
    await host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" });

    vi.mocked(views[1]!.webContents.on).mock.calls.find(
      ([event]) => event === "render-process-gone",
    )?.[1]?.();

    expect(gone).not.toHaveBeenCalled();
    const state = host.state(contextId);
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe(state.tabs[0]?.tabId);
  });

  it("refuses a tab command from a window that does not own the context", async () => {
    const host = createBrowserSurfaceHost({ createView: () => view() });
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: {
        profileMode: "isolated",
        allowedOrigins: ["https://example.com"],
        credentialFieldProtection: true,
        maxConcurrentTabs: 4,
        sessionTimeoutMs: 300_000,
      },
    });

    await expect(
      host.tabCommand(contextId, { windowId: "window-b", threadId }, { kind: "open" }),
    ).rejects.toThrow("does not own");
  });
});
