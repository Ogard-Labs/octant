/**
 * The window that says why Octant did not start. It replaces the error box:
 * every native alert that has no parent window runs a nested modal loop on
 * macOS (`-[NSAlert runModal]`, which Electron's `showErrorBox`, the sync
 * message box and the async message box without a window all end in), and a
 * packaged launch sat in that loop with a SIGTERM waiting behind it. An
 * ordinary window leaves the main loop running, so a signal, the Quit menu
 * item or closing the window all still end the app.
 *
 * The page is a static document built here: it needs no renderer bundle, no
 * host and no network, runs no script, and its one button is a link the window
 * intercepts.
 */

/** Navigating here is the Quit button; the window intercepts it and loads nothing. */
export const STARTUP_FAILURE_QUIT_URL = "octant-startup-failure://quit";
/** Navigating here is a notice's Close button; it closes that window only. */
export const NOTICE_CLOSE_URL = "octant-startup-failure://close";

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * The page: a heading, the reason in its own scrolling block, and one button.
 * The window cannot be resized, so the reason is bounded: however long it is,
 * the heading and the button stay in view.
 */
export function startupFailureDocument(input: {
  readonly title: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly url: string };
}): string {
  const action = input.action ?? { label: "Quit", url: STARTUP_FAILURE_QUIT_URL };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(input.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; margin: 0; padding: 20px 24px; }
  h1 { font-size: 15px; margin: 0 0 10px; }
  .reason { margin: 0 0 12px; max-height: 120px; overflow-y: auto; white-space: pre-wrap;
    overflow-wrap: anywhere; user-select: text; }
  a.action { display: inline-block; padding: 5px 16px; border: 1px solid currentColor;
    border-radius: 6px; color: inherit; text-decoration: none; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<div class="reason">${escapeHtml(input.message)}</div>
<a class="action" href="${action.url}" autofocus>${escapeHtml(action.label)}</a>
</body>
</html>`;
}

const documentUrl = (document: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;

/** The slice of a window these views need; startupFailureElectron adapts a BrowserWindow to it. */
export interface StartupFailureWindow {
  /** Loads the document. Only programmatic loads are allowed; page navigations are refused. */
  readonly load: (url: string) => Promise<void>;
  readonly show: () => void;
  /** Called for every navigation the page starts; `preventDefault` refuses it. */
  readonly onNavigate: (listener: (url: string, preventDefault: () => void) => void) => void;
  readonly onClosed: (listener: () => void) => void;
  readonly close: () => void;
  /** Removes the window at once, without waiting for it to agree to close. */
  readonly destroy: () => void;
}

/**
 * Shows the failure in a window and returns once it is on screen. `quit` runs
 * for the Quit button and for closing the window; the caller makes it end the
 * app once. A quit requested while the app was becoming ready creates no window.
 */
export async function showStartupFailureWindow(options: {
  readonly ready: () => Promise<void>;
  readonly quitRequested: () => boolean;
  readonly createWindow: (title: string) => StartupFailureWindow;
  readonly title: string;
  readonly message: string;
  readonly quit: () => void;
  /** Receives the window as soon as it exists, so a quit can remove it. */
  readonly onCreated?: (window: StartupFailureWindow) => void;
}): Promise<void> {
  await options.ready();
  if (options.quitRequested()) return;
  const window = options.createWindow(options.title);
  window.onNavigate((url, preventDefault) => {
    preventDefault();
    if (url === STARTUP_FAILURE_QUIT_URL) options.quit();
  });
  let closed = false;
  window.onClosed(() => {
    closed = true;
    options.quit();
  });
  options.onCreated?.(window);
  try {
    await window.load(
      documentUrl(startupFailureDocument({ title: options.title, message: options.message })),
    );
  } catch (error) {
    // A quit removes a window that is still loading, which rejects the load:
    // that is the app leaving, not a failure to show.
    if (closed || options.quitRequested()) return;
    throw error;
  }
  if (closed || options.quitRequested()) return;
  window.show();
}

/** What a notice needs to know about the window that might carry its sheet. */
export interface NoticeOwner {
  readonly isDestroyed: () => boolean;
  readonly isVisible: () => boolean;
  readonly isMinimized: () => boolean;
}

/**
 * Tells a person something went wrong while the app keeps running, without a
 * blocking call. A sheet needs a window the person can see: Electron's async
 * message box attaches a sheet to whatever parent it is given with no
 * visibility check, and a sheet on a hidden or minimised window waits for that
 * window to come back. Otherwise the notice is a small window of its own, at
 * most one at a time (a newer notice replaces its text), whose Close button
 * closes that window and never quits the app.
 */
export function createNotices<Owner extends NoticeOwner>(options: {
  readonly createWindow: (title: string) => StartupFailureWindow;
  readonly showSheet: (owner: Owner, title: string, message: string) => void;
}) {
  let current: StartupFailureWindow | undefined;
  const showWindow = async (title: string, message: string): Promise<void> => {
    if (current === undefined) {
      const window = options.createWindow(title);
      current = window;
      window.onNavigate((url, preventDefault) => {
        preventDefault();
        if (url === NOTICE_CLOSE_URL) window.close();
      });
      window.onClosed(() => {
        if (current === window) current = undefined;
      });
    }
    await current.load(
      documentUrl(
        startupFailureDocument({
          title,
          message,
          action: { label: "Close", url: NOTICE_CLOSE_URL },
        }),
      ),
    );
    current.show();
  };
  return {
    notify: async (owner: Owner | undefined, title: string, message: string): Promise<void> => {
      if (
        owner !== undefined &&
        !owner.isDestroyed() &&
        owner.isVisible() &&
        !owner.isMinimized()
      ) {
        options.showSheet(owner, title, message);
        return;
      }
      await showWindow(title, message);
    },
  };
}
