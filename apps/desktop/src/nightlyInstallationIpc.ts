import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import type { createNightlyInstallation } from "./nightlyInstallation";
import { DESKTOP_IPC_CHANNELS as CHANNELS } from "./ipcChannels";

type Installation = ReturnType<typeof createNightlyInstallation>;

/** A local window owns its request through confirmation and native preparation. */
export function registerNightlyInstallationIpc(options: {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown,
  ) => void;
  readonly installation: () => Installation;
  readonly resolveWindow: (event: IpcMainInvokeEvent) => BrowserWindow;
  readonly confirmRemoval: (window: BrowserWindow) => Promise<boolean>;
}) {
  const windowFor = (event: IpcMainInvokeEvent, args: ReadonlyArray<unknown>) => {
    if (args.length !== 0) throw new TypeError("Nightly installation requests take no arguments.");
    return options.resolveWindow(event);
  };
  options.handle(CHANNELS.nightlyInstallationState, (event, ...args) => {
    const window = windowFor(event, args);
    return options.installation().snapshot(window);
  });
  options.handle(CHANNELS.nightlyInstallationRefresh, async (event, ...args) => {
    const window = windowFor(event, args);
    const installation = options.installation();
    await installation.refresh();
    if (window.isDestroyed() || options.resolveWindow(event) !== window)
      throw new Error("The requesting window is no longer current.");
    return installation.snapshot(window);
  });
  for (const [channel, action] of [
    [CHANNELS.nightlyInstallationInstall, "install"],
    [CHANNELS.nightlyInstallationOpen, "open"],
    [CHANNELS.nightlyInstallationRemove, "remove"],
    [CHANNELS.nightlyInstallationCancel, "cancel"],
  ] as const) {
    options.handle(channel, async (event, ...args) => {
      const window = windowFor(event, args);
      const abort = new AbortController();
      const closed = () => abort.abort();
      const owner = {
        key: window,
        signal: abort.signal,
        current: () => {
          try {
            return !window.isDestroyed() && options.resolveWindow(event) === window;
          } catch {
            return false;
          }
        },
      };
      window.once("closed", closed);
      try {
        const installation = options.installation();
        // The main process asks on this actual owned window; a renderer flag
        // can never stand in for a person's decision to move an app to Trash.
        if (action === "remove" && (!(await options.confirmRemoval(window)) || !owner.current()))
          return installation.snapshot(window);
        return await installation[action](owner);
      } finally {
        window.removeListener("closed", closed);
      }
    });
  }
}

/** A failed installer drain must not skip the already accepted host shutdown. */
export async function closeNightlyInstallationForQuit(
  installation: Installation | undefined,
  shutDown: () => Promise<unknown>,
): Promise<void> {
  try {
    const receipt = await installation?.close();
    if (receipt?.kind === "failed")
      throw new Error(`Nightly installation did not drain: ${receipt.reason}`);
  } finally {
    await shutDown();
  }
}
