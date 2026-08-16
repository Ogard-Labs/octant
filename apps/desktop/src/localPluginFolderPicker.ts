import { basename } from "node:path";

export type LocalPluginFolderPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;

export class LocalPluginFolderPickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalPluginFolderPickerError";
  }
}

interface OwnedWindowPort {
  readonly isDestroyed: () => boolean;
}

interface PickerEventPort {
  readonly sender: unknown;
}

interface DialogPort<TWindow extends OwnedWindowPort> {
  readonly showOpenDialog: (
    window: TWindow,
    options: { readonly properties: readonly ["openDirectory", "dontAddToRecent"] },
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface LocalPluginFolderPickerOptions<TWindow extends OwnedWindowPort> {
  readonly desktopBridgeSecret: string;
  readonly dialog: DialogPort<TWindow>;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly resolveOwnedWindow: (sender: unknown) => TWindow | undefined;
  readonly serverUrl: string;
  readonly windowId: string;
}

/**
 * Native directory picker for Agent Plugins local import.
 * Exchanges the native filesystem selection for a short-lived server receipt.
 * The renderer receives only the opaque window-bound receipt and display name.
 */
export function createLocalPluginFolderPicker<TWindow extends OwnedWindowPort>(
  options: LocalPluginFolderPickerOptions<TWindow>,
) {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (event: PickerEventPort): Promise<LocalPluginFolderPickerResult> => {
    const window = options.resolveOwnedWindow(event.sender);
    if (window === undefined || window.isDestroyed()) {
      throw new LocalPluginFolderPickerError(
        "Octant rejected an unauthorized local plugin folder request.",
      );
    }

    let selection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
    try {
      selection = await options.dialog.showOpenDialog(window, {
        properties: ["openDirectory", "dontAddToRecent"],
      });
    } catch {
      throw new LocalPluginFolderPickerError(
        "Octant could not open the local plugin folder picker.",
      );
    }
    if (selection.canceled) return Object.freeze({ kind: "cancelled" });
    const path = selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
    if (path === undefined || path.length === 0) {
      throw new LocalPluginFolderPickerError(
        "Octant did not receive a valid local plugin folder selection.",
      );
    }
    let response: Response;
    try {
      response = await fetch(
        new URL("/api/extensions/import-local-receipts", options.serverUrl).toString(),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-desktop-secret": options.desktopBridgeSecret,
          },
          body: JSON.stringify({ windowId: options.windowId, absolutePath: path }),
        },
      );
    } catch {
      throw new LocalPluginFolderPickerError(
        "Octant could not reach its local plugin import service.",
      );
    }
    if (response.status !== 201) {
      throw new LocalPluginFolderPickerError(
        "Octant could not authorize the selected local plugin folder.",
      );
    }
    const receiptId = await decodeReceiptId(response);
    return Object.freeze({ kind: "selected", receiptId, displayName: basename(path) });
  };
}

async function decodeReceiptId(response: Response): Promise<string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new LocalPluginFolderPickerError("Octant returned an invalid local plugin receipt.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "expiresAt,receiptId" ||
    typeof (value as { receiptId?: unknown }).receiptId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test((value as { receiptId: string }).receiptId) ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== "number" ||
    !Number.isSafeInteger((value as { expiresAt: number }).expiresAt)
  ) {
    throw new LocalPluginFolderPickerError("Octant returned an invalid local plugin receipt.");
  }
  return (value as { receiptId: string }).receiptId;
}
