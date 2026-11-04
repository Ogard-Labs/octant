import { createBrowserPresentationClient } from "@octant/client-runtime";
import { NightlyBrowserPresentation } from "./nightlyBrowserPresentation";
import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopIdentity } from "@octant/host-runtime";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import {
  createMainBrowserWindowOptions,
  createTrustedRendererRequestRegistry,
  decorateTrustedRendererHeaders,
} from "./desktopWindowBootstrap";
import { createRendererNavigationPolicy } from "./rendererNavigationPolicy";
import { openNightlyClientWindow } from "./nightlyClientWindow";
import { desktopWindowProtocol } from "./desktopPeerWindows";
import { DESKTOP_PRELOAD_FILENAME } from "./runtimePaths";

/** Ordinary client entry: this module never imports the host-owning main. */
export async function runNightlyClient(
  identity: DesktopIdentity,
  native: unknown,
): Promise<{ readonly kind: "started" } | { readonly kind: "refused"; readonly message: string }> {
  const protocol = desktopWindowProtocol(native);
  if (protocol === undefined)
    return {
      kind: "refused",
      message: "Needs a newer Octant. Native window registration is unavailable.",
    };
  await app.whenReady();
  const windows = new Map<number, BrowserWindow>();
  const trusted = createTrustedRendererRequestRegistry();
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const rendererPath = resolve(root, "apps/web/dist/index.html");
  const allowed = createRendererNavigationPolicy({ packagedRendererPath: rendererPath });
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      const context =
        details.webContentsId === undefined ? undefined : trusted.get(details.webContentsId);
      const frameUrl = details.frame?.url ?? details.webContents?.getURL();
      callback({
        requestHeaders: decorateTrustedRendererHeaders({
          requestHeaders: details.requestHeaders,
          requestUrl: details.url,
          ...(frameUrl === undefined ? {} : { frameUrl }),
          ...(context === undefined ? {} : { context }),
        }),
      });
    },
  );
  const owns = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const window = windows.get(event.sender.id);
    if (
      window === undefined ||
      window.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      !allowed.allows(event.sender.getURL())
    )
      throw new Error("Octant rejected an unauthorized Nightly window request.");
    return window;
  };
  const supported = new Set<string>();
  const register = (channel: string, handler: (event: Electron.IpcMainInvokeEvent) => unknown) => {
    supported.add(channel);
    ipcMain.handle(channel, (event) => {
      owns(event);
      return handler(event);
    });
  };
  register(DESKTOP_IPC_CHANNELS.minimize, (event) => owns(event).minimize());
  register(DESKTOP_IPC_CHANNELS.maximizeOrRestore, (event) => {
    const window = owns(event);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  register(DESKTOP_IPC_CHANNELS.close, (event) => owns(event).close());
  register(DESKTOP_IPC_CHANNELS.hostCapabilities, () => ({
    sidebarVibrancySupported: false,
    liveBrowserSupported: true,
    embeddedBrowserSupported: true,
    liveSimulatorFrameSupported: false,
    liveAndroidFrameSupported: false,
  }));
  const presentations = new Map<number, NightlyBrowserPresentation>();
  const closingPresentations = new Set<Promise<void>>();
  supported.add(DESKTOP_IPC_CHANNELS.browserHumanPresentation);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.browserHumanPresentation, (event, request: unknown) => {
    owns(event);
    return presentations.get(event.sender.id)?.invoke(request) ?? { status: "refused" };
  });
  for (const [channel, kind] of [
    [DESKTOP_IPC_CHANNELS.browserSurfaceCommand, "command"],
    [DESKTOP_IPC_CHANNELS.browserSurfaceTab, "tab"],
  ] as const) {
    supported.add(channel);
    ipcMain.handle(channel, async (event, request: unknown) => {
      owns(event);
      const result = await presentations.get(event.sender.id)?.surfaceCommand(request, kind);
      if (result?.status !== "state")
        throw new Error("Octant refused this Browser presentation command.");
      return result.state;
    });
  }
  const capabilities = new Map<number, string>();
  register(DESKTOP_IPC_CHANNELS.projectWindowCapability, (event) =>
    capabilities.get(event.sender.id),
  );
  // The shared renderer's other native contributions are still awaiting their
  // typed owning broker. Refusal is explicit; no arbitrary channel is proxied.
  for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
    if (supported.has(channel)) continue;
    ipcMain.handle(channel, (event) => {
      owns(event);
      throw new Error(
        "Needs a newer Octant. This Nightly native feature is not available in this build.",
      );
    });
  }
  let acceptedQuit = false;
  let quitRequested = false;
  let clientPromise: ReturnType<typeof openNightlyClientWindow> | undefined;
  app.on("before-quit", (event) => {
    if (acceptedQuit) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    void (async () => {
      const client = await clientPromise;
      const result = client?.kind === "opened" ? await client.close() : { kind: "closed" };
      if (result.kind !== "closed")
        dialog.showErrorBox(
          identity.productName,
          "Octant Nightly closed its window, but could not confirm immediate lease cleanup. The host expires the short lease automatically.",
        );
      await Promise.allSettled([
        ...closingPresentations,
        ...[...presentations.values()].map((presentation) => presentation.close()),
      ]);
      acceptedQuit = true;
      app.quit();
    })();
  });
  app.on("window-all-closed", () => app.quit());
  clientPromise = openNightlyClientWindow({
    native: protocol,
    isClosing: () => quitRequested,
    createWindow: (bootstrap) => {
      const window = new BrowserWindow(
        createMainBrowserWindowOptions({
          bounds: { x: 100, y: 100, width: 1200, height: 800 },
          productName: identity.productName,
          capability: bootstrap.capability,
          windowId: bootstrap.windowId,
          preloadPath: resolve(dirname(fileURLToPath(import.meta.url)), DESKTOP_PRELOAD_FILENAME),
          browserWindow: { backgroundColor: "#101013", frame: true },
        }),
      );
      const id = window.webContents.id;
      const browserClient = createBrowserPresentationClient({
        baseUrl: bootstrap.hostOrigin,
        windowCapability: bootstrap.capability,
        rendererIdentity: bootstrap.rendererIdentity,
        fetch: globalThis.fetch,
      });
      const presentation = new NightlyBrowserPresentation({
        current: () => windows.get(id) === window && !window.isDestroyed(),
        visible: () => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
        focused: () => !window.isDestroyed() && window.isFocused(),
        execute: browserClient.execute,
      });
      presentations.set(id, presentation);
      window.on("blur", () => {
        void presentation.releaseInputs();
      });
      window.on("focus", () => {
        void presentation.releaseInputs();
      });
      window.on("show", () => presentation.show());
      window.on("restore", () => presentation.show());
      window.on("hide", () => {
        void presentation.hide();
      });
      window.on("minimize", () => {
        void presentation.hide();
      });
      windows.set(id, window);
      capabilities.set(id, bootstrap.capability);
      trusted.set(id, {
        serverOrigin: bootstrap.hostOrigin,
        rendererIdentity: bootstrap.rendererIdentity,
      });
      const guard = (event: { preventDefault(): void }, url: string) => {
        if (!allowed.allows(url)) event.preventDefault();
      };
      window.webContents.on("will-navigate", (event, url) => guard(event, url));
      window.webContents.on("will-redirect", (event, url) => guard(event, url));
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.once("render-process-gone", () => {
        if (!window.isDestroyed()) window.destroy();
      });
      window.once("closed", () => {
        windows.delete(id);
        presentations.delete(id);
        const closing = presentation.close();
        closingPresentations.add(closing);
        void closing.finally(() => closingPresentations.delete(closing));
        capabilities.delete(id);
        trusted.remove(id);
      });
      return {
        load: async () => {
          await window.loadFile(rendererPath, { query: { serverUrl: bootstrap.hostOrigin } });
          if (!window.isDestroyed()) window.show();
        },
        destroy: () => window.destroy(),
        isDestroyed: () => window.isDestroyed(),
        onClosed: (listener) => window.once("closed", listener),
      };
    },
  });
  const client = await clientPromise;
  if (client.kind !== "opened")
    return {
      kind: "refused",
      message: "Octant Nightly could not register its window with the matching signed Octant host.",
    };
  return { kind: "started" };
}
