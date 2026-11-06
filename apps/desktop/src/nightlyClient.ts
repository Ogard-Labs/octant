import { createBrowserPresentationClient } from "@octant/client-runtime";
import { NightlyBrowserPresentation } from "./nightlyBrowserPresentation";
import {
  app,
  autoUpdater as electronAutoUpdater,
  BrowserWindow,
  screen,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopIdentity } from "@octant/host-runtime";
import { decodeAppVersion } from "@octant/contracts/app-updates";
import type { NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { createNativeMainAuthority } from "./nightlyNativeMainAuthority";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { nightlyClientChannelClass, nightlyClientRefusal } from "./nightlyClientChannels";
import {
  createMainBrowserWindowOptions,
  createTrustedRendererRequestRegistry,
  decorateTrustedRendererHeaders,
} from "./desktopWindowBootstrap";
import { createRendererNavigationPolicy } from "./rendererNavigationPolicy";
import { openNightlyClientWindow } from "./nightlyClientWindow";
import { createNightlyClientRecovery } from "./nightlyClientRecovery";
import { createNightlyAppUpdates } from "./nightlyAppUpdates";
import { resolveUpdateFeedBaseUrl } from "./appUpdateFeed";
import {
  acknowledgeWhatsNew,
  loadBundledWhatsNew,
  resolveBundledWhatsNewPath,
  resolveWhatsNewStatePath,
} from "./bundledWhatsNew";
import { desktopWindowProtocol } from "./desktopPeerWindows";
import { popupNativeMenu, installNativeEditingMenus } from "./nativeContextMenus";
import { DESKTOP_PRELOAD_FILENAME } from "./runtimePaths";
import {
  createNightlyDataControl,
  createRelaunchIntent,
  nightlyTestDataSupported,
} from "./nightlyTestData";

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
  const bootstraps = new Map<number, NightlyWindowBootstrap>();
  // Later brokered pickers and handoffs read their host headers from here.
  const nativeMain = createNativeMainAuthority();
  let updates: Awaited<ReturnType<typeof createNightlyAppUpdates>> | undefined;
  const appUpdates = () => {
    if (updates === undefined) throw new Error("Nightly updates are not ready.");
    return updates;
  };
  register(DESKTOP_IPC_CHANNELS.projectWindowCapability, (event) =>
    capabilities.get(event.sender.id),
  );
  supported.add(DESKTOP_IPC_CHANNELS.nativeMenu);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.nativeMenu, async (event, request: unknown) => {
    const window = owns(event);
    const outcome = await popupNativeMenu(window, request);
    try {
      return owns(event) === window ? outcome : { kind: "refused" };
    } catch {
      return { kind: "refused" };
    }
  });
  for (const [channel, run] of [
    [DESKTOP_IPC_CHANNELS.appUpdateState, async () => appUpdates().state()],
    [DESKTOP_IPC_CHANNELS.appUpdateCheck, async () => appUpdates().check()],
    [DESKTOP_IPC_CHANNELS.appUpdateDownload, async () => appUpdates().download()],
  ] as const)
    register(channel, run);
  supported.add(DESKTOP_IPC_CHANNELS.appUpdateAutomatic);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appUpdateAutomatic, (event, value: unknown) => {
    owns(event);
    return appUpdates().setAutomatic(value);
  });
  supported.add(DESKTOP_IPC_CHANNELS.appUpdateRing);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appUpdateRing, (event, value: unknown) => {
    owns(event);
    return appUpdates().setRing(value);
  });
  register(DESKTOP_IPC_CHANNELS.appUpdateInstall, (event) => {
    const window = owns(event);
    const bootstrap = bootstraps.get(event.sender.id);
    if (bootstrap === undefined) return { kind: "not-ready" };
    return appUpdates().install({
      bootstrap,
      current: () => {
        try {
          return owns(event) === window;
        } catch {
          return false;
        }
      },
    });
  });
  const notesOptions = () => ({
    currentVersion: app.getVersion(),
    notesPath: resolveBundledWhatsNewPath({
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      moduleUrl: import.meta.url,
    }),
    statePath: resolveWhatsNewStatePath(app.getPath("userData")),
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: async (path: string, contents: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
  });
  register(DESKTOP_IPC_CHANNELS.appUpdateWhatsNew, () => loadBundledWhatsNew(notesOptions()));
  register(DESKTOP_IPC_CHANNELS.appUpdateWhatsNewAck, () => acknowledgeWhatsNew(notesOptions()));
  // The client's quit always completes once asked, so the relaunch is armed
  // only when its cleanup finishes and the quit is accepted.
  const relaunch = createRelaunchIntent({
    quit: () => app.quit(),
    relaunch: () => app.relaunch(),
  });
  const offersTestData = nightlyTestDataSupported(identity, process.platform);
  if (offersTestData) {
    const data = createNightlyDataControl({
      identity,
      role: { kind: "octant-client" },
      platform: process.platform,
      appDataDirectory: app.getPath("appData"),
      windowStorageDirectory: app.getPath("userData"),
      env: process.env,
      trashItem: (path) => shell.trashItem(path),
      requestRelaunch: () => relaunch.request(),
    });
    register(DESKTOP_IPC_CHANNELS.nightlyDataState, () => data.state());
    register(DESKTOP_IPC_CHANNELS.nightlyDataRemove, () => data.remove());
    register(DESKTOP_IPC_CHANNELS.nightlyDataRelaunch, () => data.relaunch());
    supported.add(DESKTOP_IPC_CHANNELS.nightlyDataChoose);
    ipcMain.handle(DESKTOP_IPC_CHANNELS.nightlyDataChoose, (event, value: unknown) => {
      owns(event);
      return data.choose(value);
    });
  }
  // Every other channel refuses by its class in the closed table: Octant-only
  // administration says where it lives, and a feature awaiting its broker says
  // it is not here yet. No arbitrary channel is proxied.
  for (const channel of Object.values(DESKTOP_IPC_CHANNELS)) {
    const channelClass = nightlyClientChannelClass(channel);
    if (supported.has(channel)) {
      if (channelClass !== "local")
        throw new Error("Octant Nightly answers a channel its table does not mark local.");
      continue;
    }
    const message = nightlyClientRefusal(channelClass);
    ipcMain.handle(channel, (event) => {
      owns(event);
      throw new Error(message);
    });
  }
  let acceptedQuit = false;
  let quitRequested = false;
  let updating = false;
  let cleanupFailed = false;
  let opening = true;
  const closeClientResources = async () => {
    const closing = [
      ...closingPresentations,
      ...[...presentations.values()].map((presentation) => presentation.close()),
    ];
    const observed = Promise.allSettled(closing);
    const nativeClosed = recovery.stop().then(
      (result) => result.kind === "closed",
      () => false,
    );
    const outcomes = await observed;
    const closed = await nativeClosed;
    cleanupFailed ||= !closed || outcomes.some((outcome) => outcome.status === "rejected");
    return { kind: cleanupFailed ? ("failed" as const) : ("closed" as const) };
  };
  app.on("before-quit", (event) => {
    if (acceptedQuit) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    updates?.dispose();
    void (async () => {
      const result = await closeClientResources();
      if (result.kind !== "closed")
        dialog.showErrorBox(
          identity.productName,
          "Octant Nightly closed its window, but could not confirm immediate lease cleanup. The host expires the short lease automatically.",
        );
      acceptedQuit = true;
      relaunch.quitAccepted();
      app.quit();
    })();
  });
  app.on("second-instance", () => {
    const window = [...windows.values()].find((candidate) => !candidate.isDestroyed());
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  app.on("window-all-closed", () => {
    if (!recovery.recovering() && !updating) app.quit();
  });
  let bounds = { x: 100, y: 100, width: 1200, height: 800 };
  const createRecovery = () =>
    createNightlyClientRecovery({
      exhausted: () => {
        dialog.showErrorBox(
          identity.productName,
          "Octant Nightly could not reconnect to its matching signed Octant host. Reopen Nightly after Octant is available. Unsaved window layout and drafts were not transferred.",
        );
        app.quit();
      },
      open: (signal, onLeaseLost) =>
        openNightlyClientWindow({
          native: protocol,
          signal,
          onLeaseLost,
          isClosing: () => quitRequested,
          createWindow: (bootstrap) => {
            const window = new BrowserWindow(
              createMainBrowserWindowOptions({
                bounds,
                localUpdatePreferences: true,
                nightlyClient: true,
                applicationFlavor: identity.flavor,
                ...(offersTestData ? { applicationData: "octant" as const } : {}),
                productName: identity.productName,
                capability: bootstrap.capability,
                windowId: bootstrap.windowId,
                preloadPath: resolve(
                  dirname(fileURLToPath(import.meta.url)),
                  DESKTOP_PRELOAD_FILENAME,
                ),
                browserWindow: { backgroundColor: "#101013", frame: true },
              }),
            );
            const id = window.webContents.id;
            installNativeEditingMenus(window);
            const rememberBounds = () => {
              if (!window.isDestroyed()) bounds = window.getNormalBounds();
            };
            window.on("resize", rememberBounds);
            window.on("move", rememberBounds);
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
              popupMenu: (request, signal) => {
                if (window.isDestroyed()) return Promise.resolve({ kind: "refused" });
                const point = screen.getCursorScreenPoint();
                const bounds = window.getContentBounds();
                return popupNativeMenu(
                  window,
                  {
                    ...request,
                    x: (point.x - bounds.x) / window.webContents.getZoomFactor(),
                    y: (point.y - bounds.y) / window.webContents.getZoomFactor(),
                  },
                  signal,
                );
              },
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
            bootstraps.set(id, bootstrap);
            nativeMain.remember(id, bootstrap);
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
              void closing.then(
                () => closingPresentations.delete(closing),
                () => {
                  cleanupFailed = true;
                  closingPresentations.delete(closing);
                },
              );
              capabilities.delete(id);
              bootstraps.delete(id);
              nativeMain.forget(id);
              trusted.remove(id);
            });
            return {
              load: async () => {
                await window.loadFile(rendererPath, { query: { serverUrl: bootstrap.hostOrigin } });
              },
              show: () => window.show(),
              destroy: () => window.destroy(),
              isDestroyed: () => window.isDestroyed(),
              onClosed: (listener) => window.once("closed", listener),
            };
          },
        }),
    });
  let recovery = createRecovery();
  const reopenClient = async () => {
    try {
      const closed = await recovery.stop();
      cleanupFailed ||= closed.kind !== "closed";
    } catch {
      cleanupFailed = true;
    }
    if (quitRequested) return;
    recovery = createRecovery();
    await recovery.start();
  };
  updates = await createNightlyAppUpdates({
    userDataDirectory: app.getPath("userData"),
    service: {
      updater: {
        setFeedURL: (options) => electronAutoUpdater.setFeedURL(options),
        checkForUpdates: () => electronAutoUpdater.checkForUpdates(),
        on: (event, listener) => {
          if (event === "error") electronAutoUpdater.on("error", listener);
          else if (event === "update-downloaded")
            electronAutoUpdater.on("update-downloaded", listener);
          else electronAutoUpdater.on("update-not-available", listener);
        },
        quitAndInstall: () => {
          if (quitRequested || !updating)
            throw new Error("The Nightly update request is no longer current.");
          acceptedQuit = true;
          try {
            electronAutoUpdater.quitAndInstall();
            updates?.dispose();
          } catch (error) {
            acceptedQuit = false;
            throw error;
          }
        },
      },
      feedBaseUrl: resolveUpdateFeedBaseUrl(process.env),
      app: {
        version: decodeAppVersion(app.getVersion()),
        platform: process.platform,
        arch: process.arch,
      },
      onState: (state) => {
        for (const window of windows.values())
          if (!window.isDestroyed())
            window.webContents.send(DESKTOP_IPC_CHANNELS.appUpdateState, state);
      },
    },
    prepare: async () => {
      updating = true;
      return closeClientResources();
    },
    canApply: () => updating && !quitRequested,
    recover: async (message) => {
      if (quitRequested) return;
      acceptedQuit = false;
      if (updating) {
        opening = true;
        try {
          await reopenClient();
        } finally {
          opening = false;
          updating = false;
        }
      }
      dialog.showErrorBox(identity.productName, message);
    },
  });
  app.on("activate", () => {
    if (quitRequested || updating || opening || windows.size !== 0 || recovery.recovering()) return;
    opening = true;
    void reopenClient().finally(() => {
      opening = false;
    });
  });
  if (quitRequested) {
    updates.dispose();
    return { kind: "refused", message: "Nightly startup was cancelled." };
  }
  const client = await recovery.start();
  opening = false;
  if (client.kind !== "opened")
    return {
      kind: "refused",
      message: "Octant Nightly could not register its window with the matching signed Octant host.",
    };
  return { kind: "started" };
}
