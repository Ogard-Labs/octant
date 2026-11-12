import { app, BrowserWindow, dialog } from "electron";
import { writeDiagnostic } from "./diagnosticLog";
import {
  createNotices,
  showStartupFailureWindow,
  type StartupFailureWindow,
} from "./startupFailureWindow";

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
    close: () => window.close(),
  };
}

/**
 * Shows why the app cannot go on, in a window, and returns once it is on
 * screen. `quit` ends the app. Never an alert without a parent: on macOS that
 * runs a nested modal loop which a signal cannot interrupt. A quit requested
 * before the app is ready creates no window.
 */
export async function showStartupFailure(options: {
  readonly title: string;
  readonly message: string;
  readonly quit: () => void;
  readonly quitRequested: () => boolean;
}): Promise<void> {
  await showStartupFailureWindow({
    ready: () => app.whenReady(),
    createWindow: createStartupFailureWindow,
    ...options,
  });
}

let nightlyFailureShown = false;

/**
 * The failure view for the Nightly launch paths, which have no quit
 * bookkeeping of their own: Quit or closing the window calls `app.quit()`. At
 * most one window is ever shown, however many times a path reports.
 */
export async function showStartupFailureAndQuit(options: {
  readonly title: string;
  readonly message: string;
}): Promise<void> {
  if (nightlyFailureShown) return;
  nightlyFailureShown = true;
  let leaving = false;
  app.once("before-quit", () => {
    leaving = true;
  });
  await showStartupFailure({
    ...options,
    quit: () => {
      leaving = true;
      app.quit();
    },
    quitRequested: () => leaving,
  });
}

// A closing notice must not read as "the last window closed" to the
// window-all-closed rule that quits a windowless Windows or Linux app.
let noticeClosing = false;
export const noticeWindowIsClosing = (): boolean => noticeClosing;

function createNoticeWindow(title: string): StartupFailureWindow {
  const window = createStartupFailureWindow(title);
  return {
    ...window,
    onClosed: (listener) => {
      window.onClosed(() => {
        // The flag stays up through the tick that emits window-all-closed.
        noticeClosing = true;
        setTimeout(() => (noticeClosing = false), 0);
        listener();
      });
    },
  };
}

const notices = createNotices<BrowserWindow>({
  createWindow: createNoticeWindow,
  showSheet: (owner, title, message) => {
    void dialog.showMessageBox(owner, { type: "error", title, message: title, detail: message });
  },
});

/**
 * Tells a person something went wrong while the app keeps running: a sheet on
 * a visible window, otherwise a small window of its own (see `createNotices`).
 * Never an alert without a parent.
 */
export function showNoticeWithoutBlocking(
  owner: BrowserWindow | undefined,
  title: string,
  message: string,
): void {
  void notices.notify(owner, title, message).catch(() => {
    writeDiagnostic(`${title}: ${message}`);
  });
}
