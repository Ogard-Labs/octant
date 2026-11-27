import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserWindow, session } from "electron";

/**
 * Renderer storage through a hidden window that loads a blank `file://` page
 * in the chosen session. Every `file://` page shares one storage origin, so
 * the page reads and writes the same `localStorage` the packaged windows use.
 * The main process decides every key; the page only runs fixed scripts.
 */
async function withStoragePage<T>(
  pageDirectory: string,
  chosen: Electron.Session,
  run: (window: BrowserWindow) => Promise<T>,
): Promise<T> {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      session: chosen,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadFile(join(pageDirectory, "blank.html"));
    return await run(window);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

/** Reads every key of Octant's copied `Local Storage` folder; the caller filters. */
export async function readCopiedLocalStorage(
  userDataCopy: string,
): Promise<Readonly<Record<string, unknown>>> {
  const copied = session.fromPath(userDataCopy);
  try {
    return await withStoragePage(userDataCopy, copied, async (window) => {
      const json: unknown = await window.webContents.executeJavaScript(
        "JSON.stringify(Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])))",
      );
      const parsed: unknown = typeof json === "string" ? JSON.parse(json) : {};
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    });
  } finally {
    await copied.flushStorageData();
  }
}

/** Writes the entries into Nightly's own storage; returns how many it wrote. */
export async function writeNightlyLocalStorage(
  entries: ReadonlyArray<readonly [string, string]>,
  overwrite: boolean,
): Promise<number> {
  const page = await mkdtemp(join(tmpdir(), "octant-nightly-storage-"));
  try {
    await writeFile(join(page, "blank.html"), "<!doctype html><title>Octant</title>");
    return await withStoragePage(page, session.defaultSession, async (window) => {
      const written: unknown = await window.webContents.executeJavaScript(
        `((entries, overwrite) => {
          let written = 0;
          for (const [key, value] of entries) {
            if (!overwrite && localStorage.getItem(key) !== null) continue;
            localStorage.setItem(key, value);
            written += 1;
          }
          return written;
        })(${JSON.stringify(entries)}, ${overwrite ? "true" : "false"})`,
      );
      await session.defaultSession.flushStorageData();
      return typeof written === "number" ? written : 0;
    });
  } finally {
    await rm(page, { recursive: true, force: true });
  }
}
