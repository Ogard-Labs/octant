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
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        toJPEG: () => Uint8Array.from([1, 2, 3]),
      })),
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
        webRequest: { onErrorOccurred: vi.fn() },
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
      // A site's own www host is the same place; a different site is not.
      redirectGuard?.({ preventDefault: vi.fn() }, { url: "https://login.example.net/" });
      throw new Error("ERR_ABORTED (-3) loading 'https://example.com/'");
    });
    await expect(
      host.act(contextId, { kind: "navigate", target: "https://example.com/" }),
    ).rejects.toMatchObject({
      name: "BrowserNavigationBlockedError",
      url: "https://login.example.net/",
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

  it("shrinks a picture too large for the observation instead of dropping it", async () => {
    // A busy page at full Retina size is several times the observation's
    // limit; the preview then showed only the title over an empty frame.
    const created = view();
    const small = {
      isEmpty: () => false,
      toJPEG: () => Uint8Array.from([1, 2, 3]),
      getSize: () => ({ width: 1_280, height: 800 }),
    };
    const resize = vi.fn(() => small);
    vi.mocked(created.webContents.capturePage).mockResolvedValue({
      isEmpty: () => false,
      toJPEG: () => new Uint8Array(80 * 1_024),
      getSize: () => ({ width: 2_560, height: 1_600 }),
      resize,
    });
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

    expect(resize).toHaveBeenCalledWith({ width: 1_280 });
    expect(observation.screenshotDataUrl).toBe("data:image/jpeg;base64,AQID");
  });

  it("captures a detached surface's page through the renderer when compositing paints nothing", async () => {
    // A surface that is not in a window produces an empty capturePage image;
    // the renderer itself still holds the page, so the debugger takes the
    // picture directly.
    const created = view();
    vi.mocked(created.webContents.capturePage).mockResolvedValue({
      isEmpty: () => true,
      toJPEG: () => new Uint8Array(0),
    });
    vi.mocked(created.webContents.debugger.sendCommand).mockImplementation(async (method) =>
      method === "Page.captureScreenshot" ? { data: "aGk=" } : undefined,
    );
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

    expect(created.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.captureScreenshot",
      expect.objectContaining({ fromSurface: false }),
    );
    expect(observation.screenshotDataUrl).toBe("data:image/jpeg;base64,aGk=");
    expect(created.webContents.debugger.isAttached()).toBe(false);
  });

  it("answers a peek for a context whose page has not committed a document", async () => {
    // A fresh surface has no committed document, and Chromium never settles a
    // script evaluation queued against it: the probe would wait forever while
    // the renderer's poll repeats, so peek reports the empty page instead.
    const created = view();
    vi.mocked(created.webContents.getURL).mockReturnValue("");
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockReturnValue(
      new Promise(() => undefined),
    );
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

    await expect(host.peek(contextId)).resolves.toEqual({});
    expect(created.webContents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(created.webContents.capturePage).not.toHaveBeenCalled();
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

  it("lists a tab the person took to an unapproved site without its address or title", async () => {
    const views = [view(), view()];
    let opened = 0;
    const host = createBrowserSurfaceHost({ createView: () => views[opened++] ?? view() });
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
    await host.tabCommand(contextId, { windowId: "window-a", threadId }, { kind: "open" });
    vi.mocked(views[1]!.webContents.getURL).mockReturnValue("https://mail.example.org/inbox");
    vi.mocked(views[1]!.webContents.getTitle).mockReturnValue("Inbox (3)");
    await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: `${contextId}:1` },
    );

    const listed = await host.act(contextId, { kind: "tab-list" });

    expect(listed.tabs).toEqual([
      { tabId: "t1", url: "https://example.com/", title: "Example", active: true },
      { tabId: "t2", active: false },
    ]);
    await expect(host.act(contextId, { kind: "tab-select", tabId: "t2" })).rejects.toThrow(
      /outside this context's allowed origins/,
    );
    // With the person's tab in front, the agent can still list and move.
    await host.tabCommand(
      contextId,
      { windowId: "window-a", threadId },
      { kind: "select", tabId: `${contextId}:2` },
    );
    expect((await host.act(contextId, { kind: "tab-list" })).tabs).toHaveLength(2);
    expect(
      (await host.act(contextId, { kind: "tab-select", tabId: "t1" })).tabs?.[0],
    ).toMatchObject({
      active: true,
    });
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

  it("reports console errors and failed requests since the last read, then clears them", async () => {
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
    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    const onConsole = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "console-message")?.[1];
    const onFailed = vi.mocked(created.webContents.session.webRequest!.onErrorOccurred).mock
      .calls[0]?.[0];
    expect(onConsole).toBeDefined();
    expect(onFailed).toBeDefined();

    onConsole!({ level: "info", message: "ready" });
    onConsole!({ level: "warning", message: "careful" });
    onConsole!({ level: "error", message: "  boom  " });
    onFailed!({ url: "https://example.com/missing.js", method: "GET", error: "net::ERR_FAILED" });

    const first = await host.act(contextId, { kind: "observe-diagnostics" });
    expect(first.consoleErrors).toEqual([{ text: "boom", url: "https://example.com/" }]);
    expect(first.failedRequests).toEqual([
      { url: "https://example.com/missing.js", method: "GET", failure: "net::ERR_FAILED" },
    ]);

    const second = await host.act(contextId, { kind: "observe-diagnostics" });
    expect(second.consoleErrors).toEqual([]);
    expect(second.failedRequests).toEqual([]);

    const navigated = await host.act(contextId, { kind: "screenshot" });
    expect(navigated.consoleErrors).toBeUndefined();
    expect(navigated.failedRequests).toBeUndefined();
  });

  it("reports a failed first navigation's request even though no document committed", async () => {
    const created = view();
    vi.mocked(created.webContents.getURL).mockReturnValue("");
    vi.mocked(created.webContents.executeJavaScriptInIsolatedWorld).mockRejectedValue(
      new Error("No document."),
    );
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
    const onFailed = vi.mocked(created.webContents.session.webRequest!.onErrorOccurred).mock
      .calls[0]?.[0];
    onFailed!({ url: "https://example.com/", method: "GET", error: "net::ERR_CONNECTION_REFUSED" });

    const read = await host.act(contextId, { kind: "observe-diagnostics" });

    expect(read.failedRequests).toEqual([
      { url: "https://example.com/", method: "GET", failure: "net::ERR_CONNECTION_REFUSED" },
    ]);
    expect(read.consoleErrors).toEqual([]);
  });

  it("keeps the newest diagnostics when a page reports more than the bound", async () => {
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
    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    const onConsole = vi
      .mocked(created.webContents.on)
      .mock.calls.find(([event]) => event === "console-message")?.[1];
    for (let index = 0; index < 40; index += 1) {
      onConsole!({ level: "error", message: `error ${String(index)}` });
    }

    const read = await host.act(contextId, { kind: "observe-diagnostics" });
    expect(read.consoleErrors).toHaveLength(32);
    expect(read.consoleErrors?.[0]?.text).toBe("error 8");
    expect(read.consoleErrors?.at(-1)?.text).toBe("error 39");
  });
});

describe("BrowserSurfaceHost stored profiles", () => {
  const projectId = "40000000-0000-4000-8000-000000000001";
  const policyIn = (profile?: { kind: "personal" } | { kind: "project"; projectId: string }) =>
    ({
      profileMode: "isolated",
      ...(profile === undefined ? {} : { profile }),
      allowedOrigins: ["https://example.com"],
      credentialFieldProtection: true,
      maxConcurrentTabs: 2,
      sessionTimeoutMs: 300_000,
    }) as never;

  it("keeps a profile page in the profile's persistent partition, not one of its own", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "personal" }),
    });
    await host.createContext({
      contextId: "60000000-0000-4000-8000-000000000002",
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "project", projectId }),
    });

    expect(createView.mock.calls.map(([options]) => options.partition)).toEqual([
      "persist:octant-profile-personal",
      `persist:octant-profile-project-${projectId}`,
    ]);
  });

  it("shares one partition between two contexts of a profile so a sign-in carries over", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });
    for (const id of [contextId, "60000000-0000-4000-8000-000000000002"]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }

    const partitions = createView.mock.calls.map(([options]) => options.partition);
    expect(new Set(partitions).size).toBe(1);
  });

  it("installs the download block once on a session two contexts share", async () => {
    const shared = view();
    const sharedSession = shared.webContents.session;
    const second = view();
    Object.assign(second.webContents, { session: sharedSession });
    const views = [shared, second];
    const host = createBrowserSurfaceHost({ createView: () => views.shift() ?? view() });
    for (const id of [contextId, "60000000-0000-4000-8000-000000000002"]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }

    const downloads = vi
      .mocked(sharedSession.on)
      .mock.calls.filter(([event]) => event === "will-download");
    expect(downloads).toHaveLength(1);
  });

  it("keeps the Private partition for a policy with no profile", async () => {
    const createView = vi.fn((_options: { readonly partition: string }) => view());
    const host = createBrowserSurfaceHost({ createView });

    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn(),
    });

    expect(createView.mock.calls[0]?.[0].partition).toBe(`octant-browser-${contextId}`);
  });

  it("reports a failed request to the context whose page failed, even on a shared session", async () => {
    const first = view();
    const second = view();
    Object.assign(first.webContents, { id: 11 });
    Object.assign(second.webContents, { id: 22 });
    const sharedSession = first.webContents.session;
    Object.assign(second.webContents, { session: sharedSession });
    const views = [first, second];
    const host = createBrowserSurfaceHost({ createView: () => views.shift() ?? view() });
    const other = "60000000-0000-4000-8000-000000000002";
    for (const id of [contextId, other]) {
      await host.createContext({
        contextId: id,
        owner: { windowId: "window-a", threadId },
        policy: policyIn({ kind: "personal" }),
      });
    }
    // Electron keeps one listener per session: the last tab to register wins.
    const listener = vi.mocked(sharedSession.webRequest!.onErrorOccurred).mock.calls.at(-1)?.[0];

    listener?.({ url: "https://example.com/a.js", error: "net::ERR_FAILED", webContentsId: 11 });

    await host.act(contextId, { kind: "navigate", target: "https://example.com/" });
    await host.act(other, { kind: "navigate", target: "https://example.com/" });
    const firstRead = await host.act(contextId, { kind: "observe-diagnostics" });
    const secondRead = await host.act(other, { kind: "observe-diagnostics" });
    expect(firstRead.failedRequests).toEqual([
      { url: "https://example.com/a.js", failure: "net::ERR_FAILED" },
    ]);
    expect(secondRead.failedRequests ?? []).toEqual([]);
  });

  it("closes every page of one profile, tells the server each is gone, and leaves other profiles open", async () => {
    const closed: string[] = [];
    const host = createBrowserSurfaceHost({ createView: () => view() });
    host.onContextGone((id) => closed.push(id));
    const personal = "60000000-0000-4000-8000-000000000002";
    const privatePage = "60000000-0000-4000-8000-000000000003";
    await host.createContext({
      contextId,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "project", projectId }),
    });
    await host.createContext({
      contextId: personal,
      owner: { windowId: "window-a", threadId },
      policy: policyIn({ kind: "personal" }),
    });
    await host.createContext({
      contextId: privatePage,
      owner: { windowId: "window-a", threadId },
      policy: policyIn(),
    });

    await host.closeProfileContexts({ kind: "personal" });

    expect(closed).toEqual([personal]);
    expect(() => host.state(personal)).toThrow(/unknown/);
    expect(host.state(contextId)).toBeDefined();
    expect(host.state(privatePage)).toBeDefined();
  });

  describe("pages offered to an extension of the same profile", () => {
    let nextId = 100;
    const identified = () => {
      const base = view();
      return { ...base, webContents: { ...base.webContents, id: (nextId += 1) } };
    };
    const shellWindow = () => ({
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    });
    const bounds = { x: 0, y: 0, width: 400, height: 300 };

    async function setup() {
      const host = createBrowserSurfaceHost({ createView: () => identified() });
      const owner = { windowId: "window-a", threadId };
      const personalPage = contextId;
      const privatePage = "60000000-0000-4000-8000-000000000003";
      const otherWindow = "60000000-0000-4000-8000-000000000004";
      await host.createContext({
        contextId: personalPage,
        owner,
        policy: policyIn({ kind: "personal" }),
      });
      await host.createContext({ contextId: privatePage, owner, policy: policyIn() });
      await host.createContext({
        contextId: otherWindow,
        owner: { windowId: "window-b", threadId },
        policy: policyIn({ kind: "personal" }),
      });
      host.attach(personalPage, owner, shellWindow(), bounds);
      return host;
    }

    it("lists the profile's own pages in the window and never a Private page or another window's", async () => {
      const host = await setup();
      const tabs = host.profileTabs({ kind: "personal" }, "window-a");
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toMatchObject({ url: "https://example.com/", active: true });
      expect(
        host.profileTabs({ kind: "project", projectId: projectId as never }, "window-a"),
      ).toEqual([]);
      expect(host.profileTabs({ kind: "personal" }, "window-c")).toEqual([]);
    });

    it("opens a page for an extension only at an origin the page already admits", async () => {
      const host = await setup();
      const refused = await host.openProfileTab(
        { kind: "personal" },
        "window-a",
        "https://elsewhere.test/",
      );
      expect(refused).toEqual({ status: "origin-refused" });
      const opened = await host.openProfileTab(
        { kind: "personal" },
        "window-a",
        "https://example.com/next",
      );
      expect(opened.status).toBe("tab");
      expect(host.profileTabs({ kind: "personal" }, "window-a")).toHaveLength(2);
      expect(await host.openProfileTab({ kind: "personal" }, "window-a", undefined)).toEqual({
        status: "tab-limit",
      });
    });

    it("does not let a redirect from an extension's navigation grant the destination origin", async () => {
      const views: ReturnType<typeof identified>[] = [];
      const host = createBrowserSurfaceHost({
        createView: () => {
          const next = identified();
          views.push(next);
          return next;
        },
      });
      const owner = { windowId: "window-a", threadId };
      await host.createContext({ contextId, owner, policy: policyIn({ kind: "personal" }) });
      host.attach(contextId, owner, shellWindow(), bounds);
      const page = views[0];
      if (page === undefined) throw new Error("no page");
      const listener = (name: string) =>
        vi.mocked(page.webContents.on).mock.calls.find((call) => call[0] === name)?.[1];
      // The person has been browsing, so the surface is theirs.
      listener("focus")?.();
      const redirect = () => {
        const preventDefault = vi.fn();
        listener("will-redirect")?.({ url: "https://redirected.test/", preventDefault });
        return preventDefault;
      };
      let refusedDuringLoad = false;
      vi.mocked(page.webContents.loadURL).mockImplementationOnce(async () => {
        refusedDuringLoad = redirect().mock.calls.length > 0;
      });
      const [tab] = host.profileTabs({ kind: "personal" }, "window-a");

      await host.updateProfileTab({ kind: "personal" }, "window-a", tab?.id ?? -1, {
        url: "https://example.com/next",
      });

      expect(refusedDuringLoad).toBe(true);
      // Once the extension's load is over, the person's own redirect grants again.
      expect(redirect()).not.toHaveBeenCalled();
    });

    it("has no page to open into when the profile is not on screen in that window", async () => {
      const host = await setup();
      expect(
        await host.openProfileTab({ kind: "personal" }, "window-b", "https://example.com/"),
      ).toEqual({
        status: "no-page",
      });
    });

    it("navigates and selects only a page of that profile and window", async () => {
      const host = await setup();
      const [page] = host.profileTabs({ kind: "personal" }, "window-a");
      const moved = await host.updateProfileTab({ kind: "personal" }, "window-a", page?.id ?? -1, {
        url: "https://example.com/other",
      });
      expect(moved.status).toBe("tab");
      expect(
        await host.updateProfileTab({ kind: "personal" }, "window-a", page?.id ?? -1, {
          url: "https://elsewhere.test/",
        }),
      ).toEqual({ status: "origin-refused" });
      expect(
        await host.updateProfileTab(
          { kind: "project", projectId: projectId as never },
          "window-a",
          page?.id ?? -1,
          {},
        ),
      ).toEqual({
        status: "no-page",
      });
    });
  });
});
