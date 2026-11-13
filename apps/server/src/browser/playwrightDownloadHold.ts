import { open, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  BROWSER_DOWNLOAD_SNIFF_BYTES,
  safeBrowserDownloadName,
  sniffBrowserDownload,
  type BrowserTransferLimits,
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

interface PendingDownload extends WatchedDownload {
  readonly download: PlaywrightDownloadPort;
  cancelledFor: "too-large" | "unfinished" | undefined;
}

/** How long an action waits for a download it started to finish. */
const FINISH_WAIT_MS = 10_000;
const WATCH_INTERVAL_MS = 50;
const DEFAULT_LIMITS: BrowserTransferLimits = {
  maxFileBytes: MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  maxHeldDownloads: MAX_BROWSER_HELD_DOWNLOADS,
};

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
  readonly #watch: DownloadFolderWatch;
  readonly #pending = new Map<PendingDownload, Promise<void>>();
  readonly #held: HeldDownload[] = [];
  #reports: BrowserDownloadReport[] = [];
  #holding = false;
  #limits: BrowserTransferLimits = DEFAULT_LIMITS;
  #nextOrdinal = 1;

  /** `watch` measures the browser's download folder; absent, only a finished file is measured. */
  constructor(watch: DownloadFolderWatch = new DownloadFolderWatch()) {
    this.#watch = watch;
  }

  /**
   * Start holding the downloads the page starts, for the length of one agent
   * action, under the person's limits (the defaults when none are passed).
   */
  begin(limits: BrowserTransferLimits = DEFAULT_LIMITS): void {
    this.#holding = true;
    this.#limits = limits;
  }

  onDownload(download: PlaywrightDownloadPort): void {
    if (!this.#holding) {
      void download.cancel().catch(() => undefined);
      return;
    }
    const entry: PendingDownload = {
      download,
      cancelledFor: undefined,
      file: undefined,
      maxFileBytes: this.#limits.maxFileBytes,
      cancelForSize: () => this.#cancel(entry, "too-large"),
    };
    const task = this.#hold(entry).finally(() => {
      this.#pending.delete(entry);
      this.#watch.remove(entry);
    });
    this.#pending.set(entry, task);
    this.#watch.add(entry);
  }

  /**
   * Wait (a bounded time) for the downloads this action started, stop holding,
   * and say what became of each. A download still running is cancelled.
   */
  async finish(): Promise<void> {
    // No new download is accepted from here on, so the snapshot below is every
    // download the wait has to cover.
    this.#holding = false;
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
    this.#watch.finished(path);
    // A native cancellation can race a completed path. The refusal already
    // won; completing afterward must not turn that file into a held download.
    if (entry.cancelledFor !== undefined) {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: entry.cancelledFor });
      return;
    }
    let sizeBytes: number;
    let head: Uint8Array;
    try {
      sizeBytes = (await stat(path)).size;
      head = sizeBytes > entry.maxFileBytes ? new Uint8Array() : await readHead(path);
    } catch {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: "failed" });
      return;
    }
    if (sizeBytes > entry.maxFileBytes) {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: "too-large" });
      return;
    }
    // The watcher can cancel while stat or the header read awaits I/O. Check
    // again at publication, with no asynchronous gap before committing the hold.
    if (entry.cancelledFor !== undefined) {
      await entry.download.delete().catch(() => undefined);
      this.#reports.push({ state: "refused", name, reason: entry.cancelledFor });
      return;
    }
    const id = `d${String(this.#nextOrdinal)}`;
    this.#nextOrdinal += 1;
    this.#held.push({ id, download: entry.download, path });
    while (this.#held.length > this.#limits.maxHeldDownloads) {
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
}

/** One running download as the folder watch sees it. */
interface WatchedDownload {
  /** The folder entry this download writes, once the watch could tell it was this one's. */
  file: string | undefined;
  /** The cap this download was started under. */
  readonly maxFileBytes: number;
  readonly cancelForSize: () => void;
}

/**
 * Watches the browser's one download folder, shared by every headless context,
 * so a file is stopped at the cap while it is still arriving.
 *
 * A uniquely attributable file is measured against its own download. When
 * concurrent arrivals cannot be attributed and any candidate file exceeds
 * the cap, all still-running candidates are cancelled: waiting until their
 * completion would leave that entire transfer unbounded. Already attributed
 * downloads are not part of that ambiguous set.
 */
export class DownloadFolderWatch {
  readonly #folder: string | undefined;
  readonly #running = new Set<WatchedDownload>();
  /** Finished files, which belong to nobody who is running. */
  readonly #finished = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #reading = false;

  /** `folder` is where the browser writes downloads; absent, nothing is watched. */
  constructor(folder?: string) {
    this.#folder = folder;
  }

  add(download: WatchedDownload): void {
    this.#running.add(download);
    if (this.#timer !== undefined || this.#folder === undefined) return;
    this.#timer = setInterval(() => void this.#look(), WATCH_INTERVAL_MS);
    this.#timer.unref?.();
  }

  remove(download: WatchedDownload): void {
    this.#running.delete(download);
    if (this.#running.size > 0 || this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** A download finished at this path; its file is no one's running download. */
  finished(path: string): void {
    this.#finished.add(stripPartial(basename(path)));
  }

  async #look(): Promise<void> {
    const folder = this.#folder;
    if (this.#reading || folder === undefined) return;
    this.#reading = true;
    const observed = [...this.#running];
    try {
      const sizes = new Map<string, { readonly entry: string; readonly size: number }>();
      for (const entry of await readdir(folder)) {
        const size = await stat(join(folder, entry)).then(
          (stats) => stats.size,
          () => 0,
        );
        const name = stripPartial(entry);
        if (size > (sizes.get(name)?.size ?? -1)) sizes.set(name, { entry, size });
      }
      const claimed = new Set<string>();
      for (const download of this.#running) {
        if (download.file !== undefined) claimed.add(download.file);
      }
      const unattributed = observed.filter(
        (download) => this.#running.has(download) && download.file === undefined,
      );
      const fresh = [...sizes.keys()].filter(
        (name) => !claimed.has(name) && !this.#finished.has(name),
      );
      const only = unattributed[0];
      const file = fresh[0];
      if (
        unattributed.length === 1 &&
        fresh.length === 1 &&
        only !== undefined &&
        file !== undefined
      ) {
        only.file = file;
      }
      const largestFresh = Math.max(0, ...fresh.map((name) => sizes.get(name)?.size ?? 0));
      for (const download of unattributed) {
        if (largestFresh > download.maxFileBytes) download.cancelForSize();
      }
      for (const download of observed) {
        if (!this.#running.has(download) || download.file === undefined) continue;
        const seen = sizes.get(download.file);
        if (seen !== undefined && seen.size > download.maxFileBytes) {
          download.cancelForSize();
        }
      }
    } catch {
      // The folder may be gone with its browser; nothing to measure.
    } finally {
      this.#reading = false;
    }
  }
}

function stripPartial(entry: string): string {
  return entry.endsWith(".crdownload") ? entry.slice(0, -".crdownload".length) : entry;
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
