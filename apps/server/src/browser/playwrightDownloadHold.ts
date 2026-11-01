import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_DOWNLOAD_SNIFF_BYTES,
  safeBrowserDownloadName,
  sniffBrowserDownload,
} from "@octant/domain";
import type { BrowserDownloadReport } from "@octant/contracts/browser-automation";
import { MAX_BROWSER_HELD_DOWNLOADS } from "@octant/contracts/browser-automation";
import { MAX_BROWSER_DOWNLOAD_FILE_BYTES } from "@octant/contracts/browser-download";

/** The part of Playwright's download the hold uses. */
export interface PlaywrightDownloadPort {
  suggestedFilename(): string;
  /** Resolves with the file once the download has finished; rejects if it was cancelled. */
  path(): Promise<string>;
  cancel(): Promise<void>;
  delete(): Promise<void>;
}

interface HeldDownload {
  readonly id: string;
  readonly download: PlaywrightDownloadPort;
  readonly path: string;
}

interface PendingDownload {
  readonly download: PlaywrightDownloadPort;
  cancelledFor: "too-large" | "unfinished" | undefined;
}

/** How long an action waits for a download it started to finish. */
const FINISH_WAIT_MS = 10_000;
const WATCH_INTERVAL_MS = 50;

/**
 * The files one headless browsing context holds for the agent.
 *
 * A download is held only while an agent action runs ({@link begin} to
 * {@link finish}); at any other time it is cancelled, which is how a download
 * the page starts on its own, or one the person starts, stays blocked. A held
 * file stays in the browser's private download folder, never the workspace.
 * It is cancelled the moment the folder shows a file past the cap, so a large
 * file never finishes.
 */
export class PlaywrightDownloadHold {
  readonly #folder: string | undefined;
  readonly #pending = new Map<PendingDownload, Promise<void>>();
  readonly #held: HeldDownload[] = [];
  #reports: BrowserDownloadReport[] = [];
  #holding = false;
  #nextOrdinal = 1;
  #watch: ReturnType<typeof setInterval> | undefined;

  /** `folder` is where the browser writes unfinished downloads; absent, only a finished file is measured. */
  constructor(folder?: string) {
    this.#folder = folder;
  }

  /** Start holding the downloads the page starts, for the length of one agent action. */
  begin(): void {
    this.#holding = true;
  }

  onDownload(download: PlaywrightDownloadPort): void {
    if (!this.#holding) {
      void download.cancel().catch(() => undefined);
      return;
    }
    const entry: PendingDownload = { download, cancelledFor: undefined };
    const task = this.#hold(entry).finally(() => {
      this.#pending.delete(entry);
      if (this.#pending.size === 0) this.#stopWatching();
    });
    this.#pending.set(entry, task);
    this.#startWatching();
  }

  /**
   * Wait (a bounded time) for the downloads this action started, stop holding,
   * and say what became of each. A download still running is cancelled.
   */
  async finish(): Promise<void> {
    if (this.#pending.size > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), FINISH_WAIT_MS);
        timer.unref?.();
      });
      const settled = Promise.allSettled(this.#pending.values());
      const outcome = await Promise.race([settled.then(() => "done" as const), timeout]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === "timeout") {
        for (const entry of this.#pending.keys()) this.#cancel(entry, "unfinished");
        await settled;
      }
    }
    this.#holding = false;
  }

  /** What became of the downloads since the last answer; each is reported once. */
  takeReports(): ReadonlyArray<BrowserDownloadReport> {
    return this.#reports.splice(0);
  }

  claim(downloadId: string): string | undefined {
    return this.#held.find((held) => held.id === downloadId)?.path;
  }

  async discard(downloadId: string): Promise<void> {
    const index = this.#held.findIndex((held) => held.id === downloadId);
    const [removed] = index === -1 ? [] : this.#held.splice(index, 1);
    await removed?.download.delete().catch(() => undefined);
  }

  /** Delete everything held and cancel what is running; the context is closing. */
  async dispose(): Promise<void> {
    this.#holding = false;
    this.#stopWatching();
    for (const entry of this.#pending.keys()) this.#cancel(entry, "unfinished");
    // A cancelled download that never reports back must not hold a close open.
    await Promise.race([
      Promise.allSettled(this.#pending.values()),
      new Promise((resolve) => {
        setTimeout(resolve, 2_000).unref?.();
      }),
    ]);
    const held = this.#held.splice(0);
    await Promise.allSettled(held.map((entry) => entry.download.delete()));
  }

  async #hold(entry: PendingDownload): Promise<void> {
    const name = safeBrowserDownloadName(entry.download.suggestedFilename());
    let path: string;
    try {
      path = await entry.download.path();
    } catch {
      this.#reports.push({
        state: "refused",
        name,
        reason: entry.cancelledFor ?? "failed",
      });
      return;
    }
    let sizeBytes: number;
    let head: Uint8Array;
    try {
      sizeBytes = (await stat(path)).size;
      head = sizeBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES ? new Uint8Array() : await readHead(path);
    } catch {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: "failed" });
      return;
    }
    if (sizeBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: "too-large" });
      return;
    }
    const id = `d${String(this.#nextOrdinal)}`;
    this.#nextOrdinal += 1;
    this.#held.push({ id, download: entry.download, path });
    while (this.#held.length > MAX_BROWSER_HELD_DOWNLOADS) {
      void this.#held
        .shift()
        ?.download.delete()
        .catch(() => undefined);
    }
    this.#reports.push({
      state: "held",
      downloadId: id,
      name,
      sizeBytes,
      mediaType: sniffBrowserDownload(head).mediaType,
    });
  }

  #cancel(entry: PendingDownload, reason: "too-large" | "unfinished"): void {
    entry.cancelledFor ??= reason;
    void entry.download.cancel().catch(() => undefined);
  }

  /**
   * The browser writes a download into its folder as it arrives. Watching the
   * folder is how a file is stopped at the cap instead of after it has
   * finished. The folder cannot say which download a file belongs to, so when
   * any file is past the cap, every running download of this context is
   * cancelled.
   */
  #startWatching(): void {
    if (this.#watch !== undefined || this.#folder === undefined) return;
    const folder = this.#folder;
    let reading = false;
    this.#watch = setInterval(() => {
      if (reading) return;
      reading = true;
      void largestFile(folder)
        .then((largest) => {
          if (largest > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
            for (const entry of this.#pending.keys()) this.#cancel(entry, "too-large");
          }
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false;
        });
    }, WATCH_INTERVAL_MS);
    this.#watch.unref?.();
  }

  #stopWatching(): void {
    if (this.#watch !== undefined) clearInterval(this.#watch);
    this.#watch = undefined;
  }
}

async function largestFile(folder: string): Promise<number> {
  let largest = 0;
  for (const name of await readdir(folder)) {
    const size = await stat(join(folder, name)).then(
      (stats) => stats.size,
      () => 0,
    );
    if (size > largest) largest = size;
  }
  return largest;
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(BROWSER_DOWNLOAD_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
