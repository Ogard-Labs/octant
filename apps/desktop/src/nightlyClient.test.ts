import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import type { NativeMenuOutcome } from "@octant/contracts/shell";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

class Contents extends EventEmitter {
  readonly id = 101;
  readonly mainFrame = {};
  url = "";
  readonly sent: Array<readonly [string, unknown]> = [];
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
  send(channel: string, value?: unknown) {
    this.sent.push([channel, value]);
  }
  setWindowOpenHandler() {}
}
class Window extends EventEmitter {
  static getFocusedWindow() {
    return fixture.windows[0] ?? null;
  }
  readonly webContents = new Contents();
  bounds = { x: 0, y: 0, width: 900, height: 600 };
  maximized = false;
  setVibrancy() {}
  focus() {}
  restore() {}
  setBounds(bounds: { x: number; y: number; width: number; height: number }) {
    this.bounds = bounds;
  }
  getNormalBounds() {
    return this.bounds;
  }
  isMaximized() {
    return this.maximized;
  }
  unmaximize() {
    this.maximized = false;
  }
  destroyed = false;
  constructor() {
    super();
    fixture.windows.push(this);
  }
  async loadFile(path: string) {
    this.webContents.url = pathToFileURL(path).href;
  }
  show() {
    this.emit("show");
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return true;
  }
  isMinimized() {
    return false;
  }
  isFocused() {
    return true;
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("closed");
    }
  }
}
const fixture = {
  app: Object.assign(new EventEmitter(), {
    whenReady: async () => {},
    quit: vi.fn(),
    getPath: () => join(tmpdir(), `octant-native-menu-${fixture.dataId}`),
    getVersion: () => "0.1.0-preview.20261104.1",
    isPackaged: true,
    setAsDefaultProtocolClient: vi.fn(),
    dock: { setBadge: vi.fn() },
  }),
  menus: [] as unknown[],
  openExternal: vi.fn(async (_url: string) => {}),
  dataId: randomUUID(),
  updater: new EventEmitter(),
  handlers: new Map<string, (event: unknown, ...values: unknown[]) => unknown>(),
  windows: [] as Window[],
  popup: vi.fn<(window: unknown, value: unknown) => Promise<NativeMenuOutcome>>(async () => ({
    kind: "selected",
    id: "0",
  })),
  editing: vi.fn(),
};
vi.mock("electron", () => ({
  app: fixture.app,
  autoUpdater: fixture.updater,
  BrowserWindow: Window,
  dialog: { showErrorBox: vi.fn() },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: (menu: unknown) => fixture.menus.push(menu),
  },
  Notification: Object.assign(class {}, { isSupported: () => false }),
  nativeTheme: Object.assign(new EventEmitter(), {
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
  }),
  powerMonitor: Object.assign(new EventEmitter(), { getCurrentThermalState: () => "nominal" }),
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 2000, height: 1200 } }],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  shell: { openExternal: fixture.openExternal, trashItem: vi.fn() },
  systemPreferences: {
    getMediaAccessStatus: () => "granted",
    getAnimationSettings: () => ({ shouldRenderRichAnimation: true }),
  },
  desktopCapturer: { getSources: async () => [] },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...values: unknown[]) => unknown) => {
      fixture.handlers.set(channel, handler);
    },
  },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } },
}));
vi.mock("@octant/client-runtime", () => ({
  createBrowserPresentationClient: () => ({ execute: async () => ({ status: "refused" }) }),
}));
vi.mock("./nativeContextMenus", () => ({
  popupNativeMenu: fixture.popup,
  installNativeEditingMenus: fixture.editing,
}));

const menu = {
  x: 40,
  y: 60,
  items: [{ kind: "item", id: "0", label: "Synthetic choice", enabled: true }],
};
async function open(platform: NodeJS.Platform = process.platform) {
  Object.defineProperty(process, "platform", { value: platform });
  const { runNightlyClient } = await import("./nightlyClient");
  const result = await runNightlyClient(desktopIdentity("nightly"), {
    listenWindows: async () => ({ kind: "started" }),
    replyWindow: () => false,
    stopWindows: async () => ({ kind: "closed" }),
    openWindow: async () => ({
      kind: "registered",
      protocol: 1,
      windowId: "00000000-0000-4000-8000-000000000936",
      generation: 1,
      hostOrigin: "http://127.0.0.1:13773",
      hostInstance: "00000000-0000-4000-8000-000000000937",
      capability: "A".repeat(43),
      rendererIdentity: "B".repeat(42) + "A",
      leaseMs: 15_000,
    }),
    renewWindow: async () => ({ kind: "renewed", leaseMs: 15_000 }),
    revokeWindow: async () => ({ kind: "revoked" }),
  });
  expect(result).toEqual({ kind: "started" });
  const window = fixture.windows[0],
    handler = fixture.handlers.get(DESKTOP_IPC_CHANNELS.nativeMenu);
  if (window === undefined || handler === undefined)
    throw new Error("Native window consumer unavailable");
  const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  return { window, event, invoke: (target: unknown = event) => handler(target, menu) };
}
// The client's module graph is large; transforming it once up front keeps the
// first test inside its time limit when the whole suite runs in parallel.
beforeAll(async () => {
  await import("./nightlyClient");
}, 60_000);
beforeEach(() => {
  vi.resetModules();
  fixture.handlers.clear();
  fixture.windows.length = 0;
  fixture.app.removeAllListeners();
  fixture.updater.removeAllListeners();
  fixture.dataId = randomUUID();
  fixture.popup.mockReset().mockResolvedValue({ kind: "selected", id: "0" });
  fixture.editing.mockClear();
  fixture.menus.length = 0;
  fixture.openExternal.mockClear();
  fixture.app.dock.setBadge.mockClear();
});
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  for (const window of fixture.windows) window.destroy();
  fixture.app.removeAllListeners();
});

it("opens the existing local native menu for the owned Nightly renderer", async () => {
  const f = await open();
  expect(await f.invoke()).toEqual({ kind: "selected", id: "0" });
  expect(fixture.popup).toHaveBeenCalledExactlyOnceWith(f.window, menu);
  expect(fixture.editing).toHaveBeenCalledExactlyOnceWith(f.window);
});
it("refuses unowned frames and renderer navigation before a popup has any effect", async () => {
  const f = await open();
  await expect(
    Promise.resolve().then(() => f.invoke({ ...f.event, senderFrame: {} })),
  ).rejects.toThrow(/unauthorized/);
  f.window.webContents.url = "https://untrusted.invalid/";
  await expect(Promise.resolve().then(() => f.invoke())).rejects.toThrow(/unauthorized/);
  expect(fixture.popup).not.toHaveBeenCalled();
});
it("refuses a late selected item after its owning window has retired", async () => {
  let finish: ((value: NativeMenuOutcome) => void) | undefined;
  fixture.popup.mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  const f = await open();
  const selected = f.invoke();
  expect(fixture.popup).toHaveBeenCalledOnce();
  f.window.destroy();
  finish?.({ kind: "selected", id: "0" });
  expect(await selected).toEqual({ kind: "refused" });
});
it("refuses unanswered channels by their class instead of asking for a newer Octant", async () => {
  const f = await open();
  const refusal = async (channel: string) => {
    const handler = fixture.handlers.get(channel);
    if (handler === undefined) throw new Error(`No handler for ${channel}`);
    return Promise.resolve()
      .then(() => handler(f.event))
      .then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
  };
  expect(await refusal(DESKTOP_IPC_CHANNELS.hubAdministrationRequest)).toMatch(
    /^Managed in Octant\./,
  );
  expect(await refusal(DESKTOP_IPC_CHANNELS.pairedComputerPair)).toMatch(/^Managed in Octant\./);
  expect(await refusal(DESKTOP_IPC_CHANNELS.listProviderApiKeys)).toBe(
    "Not available in Octant Nightly yet.",
  );
  expect(await refusal(DESKTOP_IPC_CHANNELS.browserSurfaceAttach)).toMatch(/Browser presentation/);
  for (const channel of Object.values(DESKTOP_IPC_CHANNELS))
    expect(fixture.handlers.has(channel)).toBe(true);
  for (const channel of [
    DESKTOP_IPC_CHANNELS.hubAdministrationRequest,
    DESKTOP_IPC_CHANNELS.listProviderApiKeys,
    DESKTOP_IPC_CHANNELS.browserSurfaceAttach,
  ])
    expect(await refusal(channel)).not.toMatch(/newer Octant/);
});

const invoke = (channel: string, event: unknown, ...values: unknown[]) => {
  const handler = fixture.handlers.get(channel);
  if (handler === undefined) throw new Error(`No handler for ${channel}`);
  return Promise.resolve().then(() => handler(event, ...values));
};
type MenuItem = {
  readonly label?: string;
  readonly role?: string;
  readonly accelerator?: string;
  readonly click?: (...args: unknown[]) => void;
  readonly submenu?: ReadonlyArray<MenuItem>;
};

it("names the app, opens Settings with ⌘, and offers no developer tools when packaged", async () => {
  const f = await open("darwin");
  const template = fixture.menus.at(-1) as ReadonlyArray<MenuItem>;
  expect(template[0]?.label).toBe("Octant Nightly");
  const items = template.flatMap((item) => [item, ...(item.submenu ?? [])]);
  expect(items.map((item) => item.role)).not.toContain("toggleDevTools");
  expect(items.map((item) => item.role)).not.toContain("reload");
  expect(items.map((item) => item.role)).not.toContain("viewMenu");
  const settings = items.find((item) => item.accelerator === "CommandOrControl+,");
  settings?.click?.();
  expect(f.window.webContents.sent).toContainEqual([DESKTOP_IPC_CHANNELS.openSettings, undefined]);
  expect(items.find((item) => item.label === "Quit Octant Nightly")?.accelerator).toBe(
    "CmdOrCtrl+Q",
  );
});

it("opens only plain web pages in the default browser", async () => {
  const f = await open();
  await invoke(
    DESKTOP_IPC_CHANNELS.browserSurfaceOpenExternal,
    f.event,
    "https://accounts.example.test/authorize?state=1",
  );
  expect(fixture.openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://accounts.example.test/authorize?state=1",
  );
  for (const url of ["file:///etc/hosts", "javascript:alert(1)", "octant-nightly://code/x"])
    await expect(
      invoke(DESKTOP_IPC_CHANNELS.browserSurfaceOpenExternal, f.event, url),
    ).rejects.toThrow("Octant rejected an invalid external Browser URL.");
  expect(fixture.openExternal).toHaveBeenCalledOnce();
});

it("claims its own link scheme and hands a Code link to the loaded window", async () => {
  const f = await open();
  expect(fixture.app.setAsDefaultProtocolClient).toHaveBeenCalledWith("octant-nightly");
  const thread = "00000000-0000-4000-8000-000000000123";
  const link = (url: string) => fixture.app.emit("open-url", { preventDefault() {} }, url);
  link(`octant-nightly://code/thread/${thread}`);
  link(`octant://code/thread/${thread}`);
  const delivered = () =>
    f.window.webContents.sent.filter(([channel]) => channel === DESKTOP_IPC_CHANNELS.codeDeepLink);
  expect(delivered()).toEqual([]);
  f.window.webContents.emit("did-finish-load");
  expect(delivered()).toEqual([
    [DESKTOP_IPC_CHANNELS.codeDeepLink, { kind: "thread", threadId: thread }],
  ]);
  link(`octant-nightly://code/project/${thread}`);
  expect(delivered()).toHaveLength(2);
});

it("sums the Dock badge across windows and clears a closed window's count", async () => {
  const f = await open();
  await invoke(DESKTOP_IPC_CHANNELS.attentionBadge, f.event, 3);
  expect(fixture.app.dock.setBadge).toHaveBeenLastCalledWith("3");
  f.window.destroy();
  expect(fixture.app.dock.setBadge).toHaveBeenLastCalledWith("");
});

it("centres the window again when its bounds are reset", async () => {
  const f = await open();
  f.window.maximized = true;
  await invoke(DESKTOP_IPC_CHANNELS.resetBounds, f.event);
  expect(f.window.maximized).toBe(false);
  expect(f.window.bounds).toEqual({ x: 280, y: 150, width: 1440, height: 900 });
});
