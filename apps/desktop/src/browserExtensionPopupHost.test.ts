import { describe, expect, it, vi } from "vitest";
import {
  createExtensionPopupHost,
  type ExtensionPopupShellWindow,
  type ExtensionPopupView,
} from "./browserExtensionPopupHost";
import { fitPopupBounds, validateExtensionPopupRequest } from "./browserExtensionPopupRequest";

const projectId = "40000000-0000-4000-8000-000000000001";
const extensionId = "a".repeat(32);

function fakeView() {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  let permissionCheck: (() => boolean) | undefined;
  let permissionRequest:
    | ((contents: unknown, permission: string, callback: (allowed: boolean) => void) => void)
    | undefined;
  let openHandler: (() => { action: "deny" }) | undefined;
  const view: ExtensionPopupView = {
    native: { name: "view" },
    setBounds: vi.fn(),
    webContents: {
      loadURL: vi.fn(async () => undefined),
      close: vi.fn(),
      isDestroyed: () => false,
      on: (event, listener) => void listeners.set(event, listener),
      setWindowOpenHandler: (handler) => {
        openHandler = handler;
      },
      session: {
        setPermissionCheckHandler: (handler) => {
          permissionCheck = handler;
        },
        setPermissionRequestHandler: (handler) => {
          permissionRequest = handler;
        },
      },
    },
  };
  return {
    view,
    listeners,
    permissionCheck: () => permissionCheck?.(),
    permissionRequest: (permission: string) => {
      const answer = vi.fn();
      permissionRequest?.({}, permission, answer);
      return answer;
    },
    openHandler: () => openHandler?.(),
  };
}

function shellWindow() {
  const window: ExtensionPopupShellWindow = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  };
  return window;
}

describe("extension popup host", () => {
  it("shows a loaded extension's page in the profile's own session, sandboxed and refused every permission", async () => {
    const fake = fakeView();
    const createView = vi.fn(() => fake.view);
    const host = createExtensionPopupHost({
      store: { extensionPage: () => "chrome-extension://abc/popup.html" },
      createView,
    });

    const result = await host.open({
      windowId: "w1",
      window: shellWindow(),
      profile: { kind: "personal" },
      extensionId,
      kind: "popup",
      bounds: { x: 10.4, y: 20, width: 5000, height: 10 },
    });

    expect(result).toEqual({ opened: true });
    expect(createView).toHaveBeenCalledWith({
      partition: "persist:octant-profile-personal",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(fake.view.setBounds).toHaveBeenCalledWith({ x: 10, y: 20, width: 800, height: 120 });
    expect(fake.view.webContents.loadURL).toHaveBeenCalledWith("chrome-extension://abc/popup.html");
    expect(fake.openHandler()).toEqual({ action: "deny" });
    expect(fake.permissionCheck()).toBe(false);
    expect(fake.permissionRequest("geolocation")).toHaveBeenCalledWith(false);
  });

  it("opens nothing for an extension the profile has not loaded", async () => {
    const createView = vi.fn();
    const host = createExtensionPopupHost({
      store: { extensionPage: () => undefined },
      createView,
    });

    const result = await host.open({
      windowId: "w1",
      window: shellWindow(),
      profile: { kind: "personal" },
      extensionId,
      kind: "popup",
      bounds: { x: 0, y: 0, width: 300, height: 300 },
    });

    expect(result).toEqual({ opened: false });
    expect(createView).not.toHaveBeenCalled();
  });

  it("keeps the page inside its extension and closes on Escape or when another opens", async () => {
    const first = fakeView();
    const second = fakeView();
    const views = [first, second];
    const host = createExtensionPopupHost({
      store: { extensionPage: () => "chrome-extension://abc/popup.html" },
      createView: () => (views.shift() as ReturnType<typeof fakeView>).view,
    });
    const window = shellWindow();
    const input = {
      windowId: "w1",
      window,
      profile: { kind: "project", projectId } as never,
      extensionId,
      kind: "popup" as const,
      bounds: { x: 0, y: 0, width: 300, height: 300 },
    };
    await host.open(input);

    const away = { preventDefault: vi.fn() };
    first.listeners.get("will-navigate")?.(away, "https://example.com/");
    expect(away.preventDefault).toHaveBeenCalled();
    const within = { preventDefault: vi.fn() };
    first.listeners.get("will-navigate")?.(within, "chrome-extension://abc/other.html");
    expect(within.preventDefault).not.toHaveBeenCalled();

    await host.open(input);
    expect(first.view.webContents.close).toHaveBeenCalled();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(first.view.native);

    second.listeners.get("before-input-event")?.(
      { preventDefault: vi.fn() },
      { type: "keyDown", key: "Escape" },
    );
    expect(second.view.webContents.close).toHaveBeenCalled();
  });

  it("closes the page and reports it did not open when it fails to load", async () => {
    const fake = fakeView();
    vi.mocked(fake.view.webContents.loadURL).mockRejectedValueOnce(new Error("blocked"));
    const host = createExtensionPopupHost({
      store: { extensionPage: () => "chrome-extension://abc/popup.html" },
      createView: () => fake.view,
    });

    const result = await host.open({
      windowId: "w1",
      window: shellWindow(),
      profile: { kind: "personal" },
      extensionId,
      kind: "options",
      bounds: { x: 0, y: 0, width: 300, height: 300 },
    });

    expect(result).toEqual({ opened: false });
    expect(fake.view.webContents.close).toHaveBeenCalled();
  });
});

describe("extension popup navigation", () => {
  async function opened(url: string) {
    const fake = fakeView();
    const host = createExtensionPopupHost({
      store: { extensionPage: () => url },
      createView: () => fake.view,
    });
    await host.open({
      windowId: "w1",
      window: shellWindow(),
      profile: { kind: "personal" },
      extensionId,
      kind: "popup",
      bounds: { x: 0, y: 0, width: 300, height: 300 },
    });
    const refused = (target: string) => {
      const event = { preventDefault: vi.fn() };
      fake.listeners.get("will-navigate")?.(event, target);
      return event.preventDefault.mock.calls.length > 0;
    };
    return refused;
  }

  it("will not leave for another extension, a file address, or the web", async () => {
    const refused = await opened("chrome-extension://abc/popup.html");

    expect(refused("chrome-extension://other/popup.html")).toBe(true);
    expect(refused("file:///etc/hosts")).toBe(true);
    expect(refused("https://example.com/")).toBe(true);
    expect(refused("chrome-extension://abc/elsewhere.html")).toBe(false);
  });
});

describe("extension popup placement", () => {
  const content = { width: 1000, height: 700 };
  const size = { width: 360, height: 480 };

  it("sits below the button when it fits", () => {
    expect(fitPopupBounds({ x: 100, y: 40, width: 30, height: 30 }, size, content)).toEqual({
      x: 100,
      y: 74,
      width: 360,
      height: 480,
    });
  });

  it("shifts left from the right edge so it stays inside the window", () => {
    const placed = fitPopupBounds({ x: 980, y: 40, width: 30, height: 30 }, size, content);
    expect(placed.x + placed.width).toBeLessThanOrEqual(content.width);
    expect(placed.x).toBe(640);
  });

  it("flips above the button near the bottom when there is more room there", () => {
    const placed = fitPopupBounds({ x: 100, y: 650, width: 30, height: 30 }, size, content);
    expect(placed.y + placed.height).toBeLessThanOrEqual(650);
    expect(placed.y).toBeGreaterThanOrEqual(36);
  });

  it("shrinks to the space a small window has and stays inside it", () => {
    const small = { width: 300, height: 260 };
    const placed = fitPopupBounds({ x: 250, y: 50, width: 30, height: 30 }, size, small);
    expect(placed.x).toBeGreaterThanOrEqual(0);
    expect(placed.y).toBeGreaterThanOrEqual(36);
    expect(placed.x + placed.width).toBeLessThanOrEqual(small.width);
    expect(placed.y + placed.height).toBeLessThanOrEqual(small.height);
    expect(placed.width).toBe(300);
  });
});

describe("extension popup request", () => {
  const valid = {
    profile: { kind: "project", projectId },
    extensionId,
    kind: "options",
    anchor: { x: 1, y: 2, width: 30, height: 30 },
    size: { width: 300, height: 400 },
  };

  it("accepts exactly the shapes the renderer may send", () => {
    expect(validateExtensionPopupRequest(valid)).toEqual(valid);
    expect(
      validateExtensionPopupRequest({ ...valid, profile: { kind: "personal" }, kind: "popup" }),
    ).toMatchObject({ profile: { kind: "personal" }, kind: "popup" });
  });

  it("refuses a private profile, a folder path, a stray key, and bounds that are not plain numbers", () => {
    for (const bad of [
      { ...valid, profile: { kind: "private" } },
      { ...valid, profile: { kind: "personal", projectId } },
      { ...valid, profile: { kind: "project", projectId: "../../etc" } },
      { ...valid, extensionId: "/Users/x/ext" },
      { ...valid, kind: "background" },
      { ...valid, path: "/Users/x/ext" },
      { ...valid, anchor: { ...valid.anchor, x: Number.NaN } },
      { ...valid, anchor: { ...valid.anchor, width: 1e9 } },
      { ...valid, size: { width: 0, height: 400 } },
      { ...valid, size: "wide" },
      null,
      "popup",
    ]) {
      expect(() => validateExtensionPopupRequest(bad)).toThrow(TypeError);
    }
  });
});
