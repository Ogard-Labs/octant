import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  nativeTheme,
  Notification,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import type { DesktopIdentity } from "@octant/host-runtime";
import { buildApplicationMenuTemplate } from "./applicationMenu";
import {
  attentionBadgeLabel,
  attentionNotificationPresentation,
  decodeAttentionBadgeCount,
  decodeAttentionNotificationRequest,
} from "./attentionNotifications";
import { createBrowserProofSaver } from "./browserProofSaver";
import { parseCodeDeepLink, type CodeDeepLink } from "./codeDeepLinks";
import { validateExternalBrowserUrl } from "./externalBrowserUrl";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { centeredNativeWindowState } from "./nativeWindowState";
import { detectOpenInApplications } from "./openInApplications";
import { createQuitShortcutGuard } from "./quitShortcutGuard";
import { createWindowCapture } from "./windowCapture";
import { grabWindowFrame } from "./windowFrameGrab";
import {
  createWindowPresentationController,
  INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
  observeThermalPerformance,
  resolveWindowPresentation,
  type ResolvedSidebarMaterial,
  type WindowPresentation,
  type WindowPresentationController,
} from "./windowPresentation";

type Handler = (event: IpcMainInvokeEvent, ...values: unknown[]) => unknown;

/**
 * Holds `octant-nightly://` Code links until a Nightly window has loaded a
 * renderer that can open them. A link that does not parse, or that names
 * anything beyond a Project, thread, file, diff, test or new thread, is
 * dropped without changing any state, as it is in Octant.
 */
export function createCodeDeepLinkInbox(options: {
  readonly scheme: string;
  /** Hands the link to a loaded window; false when none can take it yet. */
  readonly deliver: (link: CodeDeepLink) => boolean;
}): {
  readonly accept: (url: string) => void;
  readonly flush: (send: (link: CodeDeepLink) => void) => void;
} {
  const pending: CodeDeepLink[] = [];
  return {
    accept: (url) => {
      let link: CodeDeepLink;
      try {
        link = parseCodeDeepLink(url, options.scheme);
      } catch {
        return;
      }
      if (!options.deliver(link)) pending.push(link);
    },
    flush: (send) => {
      for (const link of pending.splice(0)) send(link);
    },
  };
}

interface ClientWindow {
  readonly window: BrowserWindow;
  readonly windowId: string;
  readonly presentation: WindowPresentationController;
  /** What the renderer was last told, repeated when it loads again. */
  readonly shown: { material: ResolvedSidebarMaterial; vibrancy: "sidebar" | null };
  loaded: boolean;
}

/**
 * The native surfaces an Octant Nightly client window gets from Nightly's own
 * main process, none of which needs Octant's host: the application menu,
 * external links, notifications and the Dock badge, Code links, window
 * placement and sidebar material, window capture under Nightly's own Screen
 * Recording grant, the Open in list and saving Browser proof pictures.
 *
 * It never imports the host-owning main; each handler is registered through
 * the caller's ownership check, so only a current Nightly window reaches it.
 */
export function installNightlyClientSurfaces(options: {
  readonly identity: DesktopIdentity;
  readonly platform: NodeJS.Platform;
  readonly register: (channel: string, handler: Handler) => void;
  readonly owns: (event: IpcMainInvokeEvent) => BrowserWindow;
  readonly quit: () => void;
}): {
  /** Window options a new client window is built with, matching Octant's. */
  readonly presentation: () => WindowPresentation;
  readonly attach: (window: BrowserWindow, windowId: string) => void;
  /** Accepts a launch argument or `open-url` value; anything else is ignored. */
  readonly acceptCodeLink: (url: string) => void;
} {
  const { identity, platform, register, owns } = options;
  const clients = new Map<number, ClientWindow>();
  const live = () => [...clients.values()].filter((client) => !client.window.isDestroyed());
  const frontWindow = (): BrowserWindow | undefined => {
    const focused = BrowserWindow.getFocusedWindow();
    const candidates = live();
    return candidates.find((client) => client.window === focused)?.window ?? candidates[0]?.window;
  };
  const clientFor = (event: IpcMainInvokeEvent): ClientWindow => {
    const window = owns(event);
    const client = clients.get(event.sender.id);
    if (client === undefined || client.window !== window)
      throw new Error("Octant rejected an unauthorized Nightly window request.");
    return client;
  };

  const quitShortcut = createQuitShortcutGuard({
    now: () => performance.now(),
    showNotice: () => {
      const window = frontWindow();
      if (window === undefined) return false;
      window.webContents.send(DESKTOP_IPC_CHANNELS.quitShortcutHint);
      return true;
    },
    quit: options.quit,
  });
  if (platform === "darwin")
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildApplicationMenuTemplate({
          appName: identity.productName,
          developerTools: !app.isPackaged,
          onOpenSettings: () => frontWindow()?.webContents.send(DESKTOP_IPC_CHANNELS.openSettings),
          onQuit: (request) => quitShortcut.request(request),
        }),
      ),
    );
  // Elsewhere a packaged client shows no menu bar at all rather than
  // Electron's default one, which carries Reload and developer tools.
  else if (app.isPackaged) Menu.setApplicationMenu(null);

  const codeLinks = createCodeDeepLinkInbox({
    scheme: identity.scheme,
    deliver: (link) => {
      const client = live().find((candidate) => candidate.loaded);
      if (client === undefined) return false;
      client.window.webContents.send(DESKTOP_IPC_CHANNELS.codeDeepLink, link);
      return true;
    },
  });

  register(DESKTOP_IPC_CHANNELS.browserSurfaceOpenExternal, async (_event, value) => {
    await shell.openExternal(validateExternalBrowserUrl(value));
  });

  register(DESKTOP_IPC_CHANNELS.attentionNotify, (event, request) => {
    const window = owns(event);
    // A focused window already shows the thread; a banner would repeat it.
    if (window.isFocused() || !Notification.isSupported()) return;
    const presentation = attentionNotificationPresentation(
      decodeAttentionNotificationRequest(request),
    );
    const notification = new Notification({
      title: presentation.title,
      body: presentation.body,
      silent: presentation.silent,
    });
    notification.on("click", () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    });
    notification.show();
  });
  // The Dock badge belongs to the app, so each window's count is summed.
  const badgeCounts = new Map<number, number>();
  const applyBadge = () => {
    let total = 0;
    for (const count of badgeCounts.values()) total += count;
    app.dock?.setBadge(attentionBadgeLabel(total));
  };
  register(DESKTOP_IPC_CHANNELS.attentionBadge, (event, value) => {
    owns(event);
    const count = decodeAttentionBadgeCount(value);
    if (count === 0) badgeCounts.delete(event.sender.id);
    else badgeCounts.set(event.sender.id, count);
    applyBadge();
  });
  // Octant's menu bar lists the host's threads; Nightly has no menu-bar item
  // of its own, so the open-thread report has nowhere to go.
  register(DESKTOP_IPC_CHANNELS.menuBarOpenThread, () => undefined);

  register(DESKTOP_IPC_CHANNELS.listOpenInApplications, () =>
    detectOpenInApplications({
      exists: existsSync,
      homeDirectory: homedir(),
      platform,
      ...(process.env.PATH === undefined ? {} : { pathEnv: process.env.PATH }),
    }),
  );

  register(DESKTOP_IPC_CHANNELS.resetBounds, (event) => {
    const client = clientFor(event);
    const state = centeredNativeWindowState(
      screen.getAllDisplays().map(({ workArea }) => workArea),
      client.windowId,
    );
    if (client.window.isMaximized()) client.window.unmaximize();
    client.window.setBounds(state.bounds);
  });
  register(DESKTOP_IPC_CHANNELS.sidebarMaterialPreference, (event, preference) => {
    const client = clientFor(event);
    if (preference !== "opaque" && preference !== "system")
      throw new Error("Octant rejected an invalid sidebar material preference.");
    client.presentation.update({ sidebarMaterial: preference });
  });
  register(DESKTOP_IPC_CHANNELS.sidebarVibrancyMode, (event, mode) => {
    const client = clientFor(event);
    if (mode !== "off" && mode !== "subtle" && mode !== "strong")
      throw new Error("Octant rejected an invalid sidebar vibrancy mode.");
    client.presentation.update({ sidebarVibrancyMode: mode });
  });

  // Window capture runs under Nightly's own Screen Recording grant. Listing
  // reads only titles; a capture reads only the one window the person picked.
  const windowCapture = createWindowCapture({
    platform,
    screenAccess: () => systemPreferences.getMediaAccessStatus("screen"),
    // Zero-size thumbnails: a non-zero size would read every window's pixels.
    windowSources: async () =>
      await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }),
    grabFrame: grabWindowFrame,
    openScreenRecordingSettings: () =>
      shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ),
  });
  register(DESKTOP_IPC_CHANNELS.windowCaptureList, async () => await windowCapture.list());
  register(
    DESKTOP_IPC_CHANNELS.windowCapturePermission,
    async () => await windowCapture.requestPermission(),
  );
  register(DESKTOP_IPC_CHANNELS.windowCaptureTake, async (_event, windowId) => {
    if (typeof windowId !== "string" || windowId.length === 0 || windowId.length > 256)
      throw new Error("Octant rejected an invalid window to capture.");
    return await windowCapture.capture(windowId);
  });

  const saveProof = createBrowserProofSaver<BrowserWindow>({
    dialog: {
      showOpenDialog: async (owner, request) => {
        const chosen = await dialog.showOpenDialog(owner, {
          title: request.title,
          buttonLabel: request.buttonLabel,
          defaultPath: request.defaultPath,
          properties: [...request.properties],
        });
        return { canceled: chosen.canceled, filePaths: chosen.filePaths };
      },
    },
    defaultDirectory: app.getPath("downloads"),
    resolveOwnedWindow: (sender) =>
      live().find((client) => client.window.webContents === sender)?.window,
  });
  register(
    DESKTOP_IPC_CHANNELS.saveBrowserProofScreenshots,
    async (event, pictures) => await saveProof(event, pictures),
  );

  const presentationInput = () => ({
    platform,
    sidebarMaterial: INITIAL_SIDEBAR_MATERIAL_PREFERENCE,
    sidebarVibrancyMode: "off" as const,
    compositionSupported: platform === "darwin",
    performanceSafe: false,
  });

  return {
    presentation: () =>
      resolveWindowPresentation({
        ...presentationInput(),
        prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
        highContrast: nativeTheme.shouldUseHighContrastColors,
      }),
    attach: (window, windowId) => {
      const id = window.webContents.id;
      const shown: ClientWindow["shown"] = { material: "opaque", vibrancy: null };
      const publish = (channel: string, value: unknown) => {
        if (!window.webContents.isDestroyed()) window.webContents.send(channel, value);
      };
      const presentation = createWindowPresentationController({
        ...presentationInput(),
        nativeTheme,
        window: {
          setVibrancy: (value) => window.setVibrancy(value),
          publishResolvedMaterial: (value) => {
            shown.material = value;
            publish(DESKTOP_IPC_CHANNELS.resolvedMaterial, value);
          },
          publishSidebarVibrancy: (value) => {
            shown.vibrancy = value;
            publish(DESKTOP_IPC_CHANNELS.resolvedSidebarVibrancy, value);
          },
        },
      });
      const client: ClientWindow = { window, windowId, presentation, shown, loaded: false };
      clients.set(id, client);
      const stopThermal = observeThermalPerformance({
        platform,
        powerMonitor,
        richEffectsAllowed: systemPreferences.getAnimationSettings().shouldRenderRichAnimation,
        updatePerformanceSafe: (performanceSafe) => presentation.update({ performanceSafe }),
      });
      window.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) client.loaded = false;
      });
      window.webContents.on("did-finish-load", () => {
        publish(DESKTOP_IPC_CHANNELS.resolvedMaterial, shown.material);
        publish(DESKTOP_IPC_CHANNELS.resolvedSidebarVibrancy, shown.vibrancy);
        client.loaded = true;
        codeLinks.flush((link) => publish(DESKTOP_IPC_CHANNELS.codeDeepLink, link));
      });
      window.once("closed", () => {
        presentation.dispose();
        stopThermal();
        clients.delete(id);
        if (badgeCounts.delete(id)) applyBadge();
      });
    },
    acceptCodeLink: (url) => {
      codeLinks.accept(url);
      const window = frontWindow();
      if (window === undefined) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    },
  };
}
