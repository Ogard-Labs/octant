import { basename, join } from "node:path";

export type SupportBundleSaverResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "saved"; fileName: string }>;

export class SupportBundleSaverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupportBundleSaverError";
  }
}

interface OwnedWindowPort {
  readonly isDestroyed: () => boolean;
}

interface SaverEventPort {
  readonly sender: unknown;
}

interface DialogPort<TWindow extends OwnedWindowPort> {
  readonly showSaveDialog: (
    window: TWindow,
    options: {
      readonly title: string;
      readonly defaultPath: string;
      readonly buttonLabel: string;
      readonly filters: ReadonlyArray<{ readonly name: string; readonly extensions: string[] }>;
      readonly properties: readonly ["createDirectory", "showOverwriteConfirmation"];
    },
  ) => Promise<{ readonly canceled: boolean; readonly filePath: string }>;
}

interface SupportBundleSaverOptions<TWindow extends OwnedWindowPort> {
  readonly desktopBridgeSecret: string;
  readonly dialog: DialogPort<TWindow>;
  /** The folder the dialog opens in, usually the person's Downloads. */
  readonly defaultDirectory: string;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly resolveOwnedWindow: (sender: unknown) => TWindow | undefined;
  readonly serverUrl: string;
}

/** `octant-diagnostics-20261031.zip`: the name the save dialog offers. */
export function defaultSupportBundleFileName(now: Date): string {
  return `octant-diagnostics-${now.toISOString().slice(0, 10).replaceAll("-", "")}.zip`;
}

/**
 * Native save dialog for the support bundle. The person chooses the file here,
 * in the main process; the host then builds the bundle and writes it to that
 * path, so the renderer never holds the path, the bundle, or a way to name a
 * file of its own. It learns only the file name that was saved.
 */
export function createSupportBundleSaver<TWindow extends OwnedWindowPort>(
  options: SupportBundleSaverOptions<TWindow>,
) {
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return async (event: SaverEventPort): Promise<SupportBundleSaverResult> => {
    const window = options.resolveOwnedWindow(event.sender);
    if (window === undefined || window.isDestroyed()) {
      throw new SupportBundleSaverError(
        "Octant rejected an unauthorized diagnostics save request.",
      );
    }

    let selection: { readonly canceled: boolean; readonly filePath: string };
    try {
      selection = await options.dialog.showSaveDialog(window, {
        title: "Save diagnostics",
        defaultPath: join(options.defaultDirectory, defaultSupportBundleFileName(now())),
        buttonLabel: "Save",
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
        properties: ["createDirectory", "showOverwriteConfirmation"],
      });
    } catch {
      throw new SupportBundleSaverError("Octant could not open the save dialog.");
    }
    if (selection.canceled || selection.filePath === "")
      return Object.freeze({ kind: "cancelled" });
    const path = /\.zip$/i.test(selection.filePath)
      ? selection.filePath
      : `${selection.filePath}.zip`;

    let response: Response;
    try {
      response = await fetch(
        new URL("/api/diagnostics/bundle/save", options.serverUrl).toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-desktop-secret": options.desktopBridgeSecret,
          },
          body: JSON.stringify({ absolutePath: path }),
        },
      );
    } catch {
      throw new SupportBundleSaverError("Octant could not reach its host to save the diagnostics.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SupportBundleSaverError("Octant returned an unreadable diagnostics save answer.");
    }
    const record =
      typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (response.status === 200 && record.kind === "saved") {
      return Object.freeze({ kind: "saved", fileName: basename(path) });
    }
    // The host's own sentence names what failed and never carries a path.
    throw new SupportBundleSaverError(
      response.status === 422 && typeof record.message === "string" && record.message !== ""
        ? record.message
        : "Octant could not save the diagnostics. Nothing was written.",
    );
  };
}
