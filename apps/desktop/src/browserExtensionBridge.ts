import type { StoredBrowserProfile } from "@octant/contracts";
import { browserProfileKey } from "@octant/domain";
import type { ExtensionTabsAnswer, ExtensionTabsCaller } from "./browserExtensionTabs";
import type { ExtensionPopupContext } from "./browserExtensionPopupHost";
import type { LoadedExtensionIdentity } from "./browserProfileStore";

/** A background worker as the bridge uses it; the part of Electron's worker object. */
export interface ExtensionWorkerPort {
  readonly scope: string;
  readonly ipc: {
    handle(channel: string, listener: (event: unknown, request: unknown) => unknown): void;
  };
  send(channel: string, ...args: unknown[]): void;
}

/** A profile's session as the bridge uses it. */
export interface ExtensionBridgeSessionPort {
  registerPreloadScript(script: { type: "service-worker"; filePath: string }): string;
  readonly serviceWorkers: {
    on(
      event: "running-status-changed",
      listener: (details: { versionId: number }) => void,
    ): unknown;
    getWorkerFromVersionID(versionId: number): ExtensionWorkerPort | undefined;
    startWorkerForScope(scope: string): Promise<ExtensionWorkerPort>;
  };
}

export interface ExtensionBridgeOptions {
  readonly preloadPath: string;
  readonly tabsChannel: string;
  readonly actionChannel: string;
  readonly sessionFor: (profile: StoredBrowserProfile) => ExtensionBridgeSessionPort;
  readonly store: {
    extensionOfElectronId(
      profile: StoredBrowserProfile,
      electronId: string,
    ): LoadedExtensionIdentity | undefined;
    extensionActionScope(profile: StoredBrowserProfile, extensionId: string): string | undefined;
  };
  readonly tabs: {
    handle(caller: ExtensionTabsCaller, request: unknown): Promise<ExtensionTabsAnswer>;
  };
}

const NO_WINDOW = "";
const EXTENSION_SCHEME = "chrome-extension:";

/**
 * What connects an extension's popup and background worker to the desktop app's
 * `chrome.tabs` and its `chrome.action.onClicked` event.
 *
 * A call is answered only for an extension that is loaded in the profile the
 * caller's session belongs to, and only for the profile's own pages: the popup
 * is identified by the popup host, the worker by the profile whose session it
 * runs in, and both by the address they run at. A website's worker in the same
 * session has no extension address and gets no handler.
 *
 * A worker serves a whole profile, not one window, so it acts in the window the
 * person last used that profile's extensions button in; with none, it sees no
 * pages.
 */
export function createExtensionBridge(options: ExtensionBridgeOptions) {
  const attached = new Set<string>();
  const wired = new WeakSet<object>();
  const lastWindow = new Map<string, string>();

  const callerOf = (
    profile: StoredBrowserProfile,
    electronId: string,
    windowId: string,
  ): ExtensionTabsCaller | undefined => {
    const identity = options.store.extensionOfElectronId(profile, electronId);
    if (identity === undefined) return undefined;
    return { profile, windowId, seesTabAddresses: identity.seesTabAddresses };
  };

  const wire = (profile: StoredBrowserProfile, worker: ExtensionWorkerPort): void => {
    if (wired.has(worker)) return;
    const electronId = extensionHost(worker.scope);
    if (electronId === undefined) return;
    wired.add(worker);
    worker.ipc.handle(options.tabsChannel, async (_event, request) => {
      const caller = callerOf(
        profile,
        electronId,
        lastWindow.get(browserProfileKey(profile)) ?? NO_WINDOW,
      );
      return caller === undefined
        ? { ok: false, error: "This extension is not enabled in this profile." }
        : await options.tabs.handle(caller, request);
    });
  };

  const attachProfile = (profile: StoredBrowserProfile): void => {
    const key = browserProfileKey(profile);
    if (attached.has(key)) return;
    attached.add(key);
    const session = options.sessionFor(profile);
    session.registerPreloadScript({ type: "service-worker", filePath: options.preloadPath });
    session.serviceWorkers.on("running-status-changed", ({ versionId }) => {
      const worker = session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (worker !== undefined) wire(profile, worker);
    });
  };
  const useWindow = (profile: StoredBrowserProfile, windowId: string): void => {
    lastWindow.set(browserProfileKey(profile), windowId);
  };

  return Object.freeze({
    /** Attach what extension workers of one profile need; safe to call again. */
    attachProfile,
    /** Answer a call from an open popup or options page. */
    async answerPopup(
      popup: ExtensionPopupContext | undefined,
      senderUrl: string,
      request: unknown,
    ): Promise<ExtensionTabsAnswer> {
      const electronId = extensionHost(senderUrl);
      const caller =
        popup === undefined || electronId === undefined
          ? undefined
          : callerOf(popup.profile, electronId, popup.windowId);
      const identity =
        popup === undefined || electronId === undefined
          ? undefined
          : options.store.extensionOfElectronId(popup.profile, electronId);
      if (caller === undefined || identity?.extensionId !== popup?.extensionId) {
        return { ok: false, error: "This page is not an open extension popup." };
      }
      return await options.tabs.handle(caller, request);
    },
    /** The person used a profile's extensions button in a window. */
    useWindow,
    /**
     * Fire `chrome.action.onClicked` in an extension that has no popup page, with
     * the profile's active page as the tab. False when the extension has no
     * action to click or the profile has no page to act on.
     */
    async clickAction(
      profile: StoredBrowserProfile,
      windowId: string,
      extensionId: string,
    ): Promise<boolean> {
      const scope = options.store.extensionActionScope(profile, extensionId);
      const electronId = scope === undefined ? undefined : extensionHost(scope);
      if (scope === undefined || electronId === undefined) return false;
      const caller = callerOf(profile, electronId, windowId);
      if (caller === undefined) return false;
      const active = await options.tabs.handle(caller, {
        method: "query",
        args: [{ active: true }],
      });
      const tab = active.ok && Array.isArray(active.value) ? active.value[0] : undefined;
      if (tab === undefined) return false;
      useWindow(profile, windowId);
      attachProfile(profile);
      const worker = await options.sessionFor(profile).serviceWorkers.startWorkerForScope(scope);
      wire(profile, worker);
      worker.send(options.actionChannel, tab);
      return true;
    },
  });
}

/** The extension an address belongs to, from `chrome-extension://<id>/…`. */
function extensionHost(address: string): string | undefined {
  try {
    const url = new URL(address);
    return url.protocol === EXTENSION_SCHEME && url.hostname !== "" ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}
