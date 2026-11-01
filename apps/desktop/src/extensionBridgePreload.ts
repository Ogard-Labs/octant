import { contextBridge, ipcRenderer, webFrame } from "electron";
import { installExtensionBridge } from "./extensionBridgeShim";

/**
 * The preload of an extension's popup, options page and background worker. It
 * gives them `chrome.tabs` and `chrome.action.onClicked` from the desktop app.
 *
 * The strings repeat `IPC_CHANNELS.browserExtensionTabs` and
 * `IPC_CHANNELS.browserExtensionActionClicked`: a sandboxed preload cannot load
 * the rest of the app for two constants, and a test holds them equal.
 *
 * Only an extension's own address gets anything. The worker preload is
 * registered on the profile's whole session, which also serves websites'
 * workers, and those must not receive a bridge to the app.
 */
const TABS_CHANNEL = "octant:browser-extension-tabs";
const ACTION_CHANNEL = "octant:browser-extension-action-clicked";

type Answer =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

const call = async (method: string, args: ReadonlyArray<unknown>): Promise<unknown> => {
  const answer = (await ipcRenderer.invoke(TABS_CHANNEL, { method, args })) as Answer;
  if (answer.ok) return answer.value;
  throw new Error(answer.error);
};

if (globalThis.location?.protocol === "chrome-extension:") {
  if (typeof window === "undefined") {
    // The background worker shares one global with the extension's script.
    installExtensionBridge(globalThis, call, {
      on: (listener) => {
        ipcRenderer.on(ACTION_CHANNEL, (_event, tab: unknown) => listener(tab));
      },
    });
  } else {
    // A page reaches its main world through a script, since the preload's own
    // world is a separate copy of `chrome`. The bridge is taken off the page's
    // global before the shim runs, so no later script can find it by name.
    const name = `octantBridge${Math.random().toString(36).slice(2)}`;
    contextBridge.exposeInMainWorld(name, {
      call: (method: string, args: ReadonlyArray<unknown>) => call(method, args),
    });
    void webFrame.executeJavaScript(
      `(() => {
        const bridge = globalThis[${JSON.stringify(name)}];
        delete globalThis[${JSON.stringify(name)}];
        (${installExtensionBridge.toString()})(globalThis, (method, args) => bridge.call(method, args), undefined);
      })()`,
    );
  }
}
