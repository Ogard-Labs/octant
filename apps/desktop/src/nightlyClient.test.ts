import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { desktopIdentity } from "@octant/host-runtime";
import type { NativeMenuOutcome } from "@octant/contracts/shell";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

class Contents extends EventEmitter {
  readonly id = 101;
  readonly mainFrame = {};
  url = "";
  getURL() {
    return this.url;
  }
  setWindowOpenHandler() {}
}
class Window extends EventEmitter {
  readonly webContents = new Contents();
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
  }),
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
async function open() {
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
beforeEach(() => {
  vi.resetModules();
  fixture.handlers.clear();
  fixture.windows.length = 0;
  fixture.app.removeAllListeners();
  fixture.updater.removeAllListeners();
  fixture.dataId = randomUUID();
  fixture.popup.mockReset().mockResolvedValue({ kind: "selected", id: "0" });
  fixture.editing.mockClear();
});
afterEach(() => {
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
