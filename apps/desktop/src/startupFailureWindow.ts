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

const escapeHtml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** The page: what happened, the reason, where the log is, and one Quit button. */
export function startupFailureDocument(input: {
  readonly title: string;
  readonly message: string;
  readonly logsDirectory: string | undefined;
}): string {
  const where =
    input.logsDirectory === undefined
      ? "The reason is also written to Octant's standard error."
      : `The reason is also in the log folder: ${escapeHtml(input.logsDirectory)}`;
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
  p { margin: 0 0 10px; }
  .reason { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .where { opacity: 0.7; overflow-wrap: anywhere; user-select: text; }
  a.quit { display: inline-block; margin-top: 6px; padding: 5px 16px; border: 1px solid currentColor;
    border-radius: 6px; color: inherit; text-decoration: none; }
</style>
</head>
<body>
<h1>${escapeHtml(input.title)}</h1>
<p class="reason">${escapeHtml(input.message)}</p>
<p class="where">${where}</p>
<a class="quit" href="${STARTUP_FAILURE_QUIT_URL}" autofocus>Quit</a>
</body>
</html>`;
}

/** The slice of a window the failure view needs; main.ts adapts a BrowserWindow to it. */
export interface StartupFailureWindow {
  /** Loads the document. Only the first load is allowed; anything else is refused. */
  readonly load: (url: string) => Promise<void>;
  readonly show: () => void;
  /** Called for every navigation the page starts; `preventDefault` refuses it. */
  readonly onNavigate: (listener: (url: string, preventDefault: () => void) => void) => void;
  readonly onClosed: (listener: () => void) => void;
}

/**
 * Shows the failure in a window and returns once it is on screen. `quit` runs
 * for the Quit button and for closing the window; the caller makes it end the
 * app once. Nothing else the page does navigates anywhere.
 */
export async function showStartupFailureWindow(options: {
  readonly createWindow: (title: string) => StartupFailureWindow;
  readonly title: string;
  readonly message: string;
  readonly logsDirectory: string | undefined;
  readonly quit: () => void;
}): Promise<void> {
  const window = options.createWindow(options.title);
  window.onNavigate((url, preventDefault) => {
    preventDefault();
    if (url === STARTUP_FAILURE_QUIT_URL) options.quit();
  });
  window.onClosed(options.quit);
  const document = startupFailureDocument({
    title: options.title,
    message: options.message,
    logsDirectory: options.logsDirectory,
  });
  await window.load(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  window.show();
}
