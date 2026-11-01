import { constants } from "node:fs";
import { access, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export type BrowserProofSaverResult =
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "saved"; count: number; folderName: string }>;

export class BrowserProofSaverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserProofSaverError";
  }
}

/** The most pictures a thread keeps, and the most one save may write. */
const MAX_FILES = 32;
/** A kept capture is the small picture the model received; this is far above it. */
const MAX_BASE64_CHARACTERS = 256 * 1024;
const DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/;
const EXTENSIONS = { png: "png", jpeg: "jpg", webp: "webp", gif: "gif" } as const;

interface OwnedWindowPort {
  readonly isDestroyed: () => boolean;
}

interface DialogPort<TWindow extends OwnedWindowPort> {
  readonly showOpenDialog: (
    window: TWindow,
    options: {
      readonly title: string;
      readonly buttonLabel: string;
      readonly defaultPath: string;
      readonly properties: readonly ["openDirectory", "createDirectory", "dontAddToRecent"];
    },
  ) => Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface BrowserProofSaverOptions<TWindow extends OwnedWindowPort> {
  readonly dialog: DialogPort<TWindow>;
  /** The folder the dialog opens in, usually the person's Downloads. */
  readonly defaultDirectory: string;
  readonly resolveOwnedWindow: (sender: unknown) => TWindow | undefined;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly write?: (path: string, bytes: Uint8Array) => Promise<void>;
}

interface PictureToSave {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

/**
 * Native folder picker for saving a thread's Browser proof screenshots.
 * The person picks the folder here, in the main process. The renderer sends
 * only the kept pictures and each one's place in the proof; the file names
 * are made here from that place and the picture's media type, so the renderer
 * names no path and no file. Nothing is overwritten, and nothing is written
 * until the person has chosen.
 *
 * Rationale: GitHub offers no way to put pictures into a pull request body,
 * and sending them to another host would send a page's picture off this
 * computer. Saving to a folder of the person's choosing lets them drag the
 * files in themselves.
 */
export function createBrowserProofSaver<TWindow extends OwnedWindowPort>(
  options: BrowserProofSaverOptions<TWindow>,
) {
  const exists =
    options.exists ??
    (async (path: string) => {
      try {
        await access(path, constants.F_OK);
        return true;
      } catch {
        return false;
      }
    });
  const write =
    options.write ??
    (async (path: string, bytes: Uint8Array) => {
      // "wx": a file that appeared since the check is never replaced.
      await writeFile(path, bytes, { flag: "wx" });
    });
  return async (
    event: { readonly sender: unknown },
    pictures: unknown,
  ): Promise<BrowserProofSaverResult> => {
    const window = options.resolveOwnedWindow(event.sender);
    if (window === undefined || window.isDestroyed()) {
      throw new BrowserProofSaverError("Octant rejected an unauthorized screenshot save request.");
    }
    const files = decodePictures(pictures);

    let selection: { readonly canceled: boolean; readonly filePaths: readonly string[] };
    try {
      selection = await options.dialog.showOpenDialog(window, {
        title: "Save Browser screenshots",
        buttonLabel: "Save here",
        defaultPath: options.defaultDirectory,
        properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
      });
    } catch {
      throw new BrowserProofSaverError("Octant could not open the folder picker.");
    }
    if (selection.canceled) return Object.freeze({ kind: "cancelled" });
    const folder = selection.filePaths.length === 1 ? selection.filePaths[0] : undefined;
    if (folder === undefined || folder.length === 0) {
      throw new BrowserProofSaverError("Octant did not receive a valid folder.");
    }

    // Check every name first so a clash leaves the folder as it was.
    for (const file of files) {
      if (await exists(join(folder, file.fileName))) {
        throw new BrowserProofSaverError(
          `A file named ${file.fileName} is already in that folder. Nothing was written.`,
        );
      }
    }
    try {
      for (const file of files) await write(join(folder, file.fileName), file.bytes);
    } catch {
      throw new BrowserProofSaverError("Octant could not write the screenshots.");
    }
    return Object.freeze({ kind: "saved", count: files.length, folderName: basename(folder) });
  };
}

function decodePictures(value: unknown): ReadonlyArray<PictureToSave> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
    throw new BrowserProofSaverError("Octant rejected an invalid screenshot save request.");
  }
  const seen = new Set<number>();
  return value.map((entry: unknown): PictureToSave => {
    if (typeof entry !== "object" || entry === null) {
      throw new BrowserProofSaverError("Octant rejected an invalid screenshot save request.");
    }
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const number = record.fileNumber;
    const match = typeof record.dataUrl === "string" ? DATA_URL.exec(record.dataUrl) : null;
    const kind = match?.[1];
    const encoded = match?.[2];
    if (
      keys.length !== 2 ||
      keys[0] !== "dataUrl" ||
      keys[1] !== "fileNumber" ||
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > 99 ||
      seen.has(number) ||
      kind === undefined ||
      encoded === undefined ||
      encoded.length > MAX_BASE64_CHARACTERS ||
      !(kind in EXTENSIONS)
    ) {
      throw new BrowserProofSaverError("Octant rejected an invalid screenshot save request.");
    }
    seen.add(number);
    const extension = EXTENSIONS[kind as keyof typeof EXTENSIONS];
    return {
      fileName: `browser-check-${String(number).padStart(2, "0")}.${extension}`,
      bytes: Uint8Array.from(Buffer.from(encoded, "base64")),
    };
  });
}
