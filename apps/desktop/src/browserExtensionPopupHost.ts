import type { StoredBrowserProfile } from "@octant/contracts";
import { browserProfilePartition } from "@octant/domain";
import type { BrowserProfileStore } from "./browserProfileStore";

export interface ExtensionPopupBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The window a popup is shown in; the part of Electron's window the host uses. */
export interface ExtensionPopupShellWindow {
  isDestroyed(): boolean;
  readonly contentView: {
    addChildView(view: unknown): void;
    removeChildView(view: unknown): void;
  };
}

/** One popup page's view, a native view loaded in the extension's profile session. */
export interface ExtensionPopupView {
  /** The native view itself, which the window's content view adds and removes. */
  readonly native: unknown;
  setBounds(bounds: ExtensionPopupBounds): void;
  readonly webContents: {
    readonly id: number;
    loadURL(url: string): Promise<unknown>;
    close(): void;
    isDestroyed(): boolean;
    on(event: string, listener: (...args: readonly unknown[]) => void): void;
    setWindowOpenHandler(handler: () => { action: "deny" }): void;
    readonly session: {
      setPermissionCheckHandler(handler: () => boolean): void;
      setPermissionRequestHandler(
        handler: (
          contents: unknown,
          permission: string,
          callback: (allowed: boolean) => void,
        ) => void,
      ): void;
    };
  };
}

/** Which window and profile an open popup page belongs to, for the calls it makes. */
export interface ExtensionPopupContext {
  readonly windowId: string;
  readonly profile: StoredBrowserProfile;
  readonly extensionId: string;
}

export interface ExtensionPopupHostOptions {
  readonly store: Pick<BrowserProfileStore, "extensionPage">;
  /** The preload that gives the page `chrome.tabs`; absent where none was built. */
  readonly preloadPath?: string;
  readonly createView: (options: {
    readonly partition: string;
    readonly webPreferences: {
      readonly preload?: string;
      readonly contextIsolation: true;
      readonly nodeIntegration: false;
      readonly sandbox: true;
      readonly webSecurity: true;
    };
  }) => ExtensionPopupView;
}

const MIN_SIZE = 120;
const MAX_WIDTH = 800;
const MAX_HEIGHT = 600;

/**
 * An extension's popup or options page in a small native view anchored to the
 * Browser toolbar's extensions button.
 *
 * The view lives in the extension's own profile session, so the page sees the
 * profile's storage and no other. It is sandboxed, may not open windows, is
 * refused every permission, and cannot navigate away from its extension: this is
 * the extension's page, not a way for it to reach the web. At most one popup is
 * open per window, and opening another, pressing Escape, clicking outside, or the
 * window going away closes it. Only an extension the profile's session has
 * loaded can be shown, so a disabled or removed one has no page to open.
 */
export function createExtensionPopupHost(options: ExtensionPopupHostOptions) {
  const open = new Map<
    string,
    {
      readonly view: ExtensionPopupView;
      readonly window: ExtensionPopupShellWindow;
      readonly context: ExtensionPopupContext;
    }
  >();

  const close = (windowId: string): void => {
    const current = open.get(windowId);
    if (current === undefined) return;
    open.delete(windowId);
    if (!current.window.isDestroyed())
      current.window.contentView.removeChildView(current.view.native);
    if (!current.view.webContents.isDestroyed()) current.view.webContents.close();
  };

  return Object.freeze({
    async open(input: {
      readonly windowId: string;
      readonly window: ExtensionPopupShellWindow;
      readonly profile: StoredBrowserProfile;
      readonly extensionId: string;
      readonly kind: "popup" | "options";
      readonly bounds: ExtensionPopupBounds;
    }): Promise<{ readonly opened: boolean }> {
      close(input.windowId);
      const url = options.store.extensionPage(input.profile, input.extensionId, input.kind);
      if (url === undefined) return { opened: false };
      const view = options.createView({
        partition: browserProfilePartition(input.profile, ""),
        webPreferences: {
          ...(options.preloadPath === undefined ? {} : { preload: options.preloadPath }),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      // Compared by protocol and host, never by origin: the origin of an extension
      // or file address is the string "null", which would equal every other one.
      const home = new URL(url);
      view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      view.webContents.session.setPermissionCheckHandler(() => false);
      view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      const keepInside = (event: unknown, ...details: readonly unknown[]) => {
        const target = details.find((detail): detail is string => typeof detail === "string");
        let inside = false;
        try {
          if (target !== undefined) {
            const next = new URL(target);
            inside = next.protocol === home.protocol && next.hostname === home.hostname;
          }
        } catch {
          inside = false;
        }
        if (!inside) (event as { preventDefault?: () => void }).preventDefault?.();
      };
      view.webContents.on("will-navigate", keepInside);
      view.webContents.on("will-redirect", keepInside);
      view.webContents.on(
        "before-input-event",
        (event: unknown, ...details: readonly unknown[]) => {
          const key = details[0] as { readonly type?: string; readonly key?: string } | undefined;
          if (key?.type === "keyDown" && key.key === "Escape") {
            (event as { preventDefault?: () => void }).preventDefault?.();
            close(input.windowId);
          }
        },
      );
      view.webContents.on("destroyed", () => open.delete(input.windowId));
      view.setBounds(clamp(input.bounds));
      input.window.contentView.addChildView(view.native);
      open.set(input.windowId, {
        view,
        window: input.window,
        context: {
          windowId: input.windowId,
          profile: input.profile,
          extensionId: input.extensionId,
        },
      });
      try {
        await view.webContents.loadURL(url);
      } catch {
        close(input.windowId);
        return { opened: false };
      }
      return { opened: true };
    },
    close,
    /** The popup page a web contents is, or nothing for a page that is not an open popup. */
    contextOf(webContentsId: number): ExtensionPopupContext | undefined {
      for (const entry of open.values()) {
        if (!entry.view.webContents.isDestroyed() && entry.view.webContents.id === webContentsId) {
          return entry.context;
        }
      }
      return undefined;
    },
    closeAll(): void {
      for (const windowId of open.keys()) close(windowId);
    },
  });
}

function clamp(bounds: ExtensionPopupBounds): ExtensionPopupBounds {
  return {
    x: Math.max(0, Math.round(bounds.x)),
    y: Math.max(0, Math.round(bounds.y)),
    width: Math.min(MAX_WIDTH, Math.max(MIN_SIZE, Math.round(bounds.width))),
    height: Math.min(MAX_HEIGHT, Math.max(MIN_SIZE, Math.round(bounds.height))),
  };
}
