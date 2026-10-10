import { basename } from "node:path";

export type RuntimeBinaryPickerResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "selected"; receiptId: string; displayName: string }>;

export class RuntimeBinaryPickerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBinaryPickerError";
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
    options: { readonly properties: readonly ["openFile", "dontAddToRecent"] },
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface RuntimeBinaryPickerOptions<TWindow extends OwnedWindowPort> {
  readonly desktopBridgeSecret: string;
  readonly dialog: DialogPort<TWindow>;
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
  readonly resolveOwnedWindow: (sender: unknown) => TWindow | undefined;
  readonly serverUrl: string;
  readonly windowId: string;
}

/**
 * Native file picker for "Locate binary" on a runtime card in Settings ›
 * Providers & Models. Like the local plugin folder picker, it exchanges the
 * selection for a short-lived, window-bound server receipt; the renderer gets
 * only that receipt and the file's name, never the path, so it can only ask the
 * host to use a file the person actually chose here.
 */
export function createRuntimeBinaryPicker<TWindow extends OwnedWindowPort>(
  options: RuntimeBinaryPickerOptions<TWindow>,
) {
  const fetch = options.fetch ?? globalThis.fetch;
  return async (event: PickerEventPort): Promise<RuntimeBinaryPickerResult> => {
    const window = options.resolveOwnedWindow(event.sender);
    if (window === undefined || window.isDestroyed()) {
      throw new RuntimeBinaryPickerError("Octant rejected an unauthorized binary picker request.");
    }

    let selection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
    try {
      selection = await options.dialog.showOpenDialog(window, {
        properties: ["openFile", "dontAddToRecent"],
      });
    } catch {
      throw new RuntimeBinaryPickerError("Octant could not open the binary picker.");
    }
    if (selection.canceled) return Object.freeze({ kind: "cancelled" });
    const path = selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
    if (path === undefined || path.length === 0) {
      throw new RuntimeBinaryPickerError("Octant did not receive a valid binary selection.");
    }
    let response: Response;
    try {
      response = await fetch(
        new URL("/api/providers/discovery/binary-receipts", options.serverUrl).toString(),
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
      throw new RuntimeBinaryPickerError("Octant could not reach its provider service.");
    }
    if (response.status !== 201) {
      throw new RuntimeBinaryPickerError("Octant could not authorize the selected binary.");
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
    throw new RuntimeBinaryPickerError("Octant returned an invalid binary receipt.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "expiresAt,receiptId" ||
    !("receiptId" in value) ||
    typeof value.receiptId !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.receiptId)
  ) {
    throw new RuntimeBinaryPickerError("Octant returned an invalid binary receipt.");
  }
  return value.receiptId;
}
