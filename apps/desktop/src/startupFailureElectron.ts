import { app, BrowserWindow, dialog } from "electron";
import { showStartupFailureWindow, type StartupFailureWindow } from "./startupFailureWindow";

// A failed launch has no renderer or host to show anything, so the failure is a
// plain window of its own: sandboxed, no script, no preload, and it loads only
// the document built in startupFailureWindow.
function createStartupFailureWindow(title: string): StartupFailureWindow {
  const window = new BrowserWindow({
    width: 520,
    height: 260,
    useContentSize: true,
    title,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return {
    load: (url) => window.loadURL(url),
    show: () => window.show(),
    onNavigate: (listener) => {
      window.webContents.on("will-navigate", (event, url) =>
        listener(url, () => event.preventDefault()),
      );
    },
    onClosed: (listener) => window.on("closed", listener),
  };
}

/**
 * Shows why the app cannot go on, in a window, and returns once it is on
 * screen. `quit` ends the app. Never an alert without a parent: on macOS that
 * runs a nested modal loop which a signal cannot interrupt.
 */
export async function showStartupFailure(options: {
  readonly title: string;
  readonly message: string;
  readonly logsDirectory: string | undefined;
  readonly quit: () => void;
}): Promise<void> {
  // A failure before ready cannot create a window yet; a quit requested
  // meanwhile still ends the app.
  await app.whenReady();
  await showStartupFailureWindow({ createWindow: createStartupFailureWindow, ...options });
}

/**
 * Tells a person something went wrong while the app keeps running. On a live
 * window it is a sheet, which leaves the main loop free; with no window the
 * reason goes to standard error, because the only native alternative is an
 * alert that no signal can interrupt.
 */
export function showNoticeWithoutBlocking(
  owner: BrowserWindow | undefined,
  title: string,
  message: string,
): void {
  if (owner !== undefined && !owner.isDestroyed()) {
    void dialog.showMessageBox(owner, { type: "error", title, message: title, detail: message });
    return;
  }
  try {
    process.stderr.write(`${title}: ${message}\n`);
  } catch {
    // Nothing is left to report to when stderr is closed.
  }
}
