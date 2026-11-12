import { existsSync, mkdtempSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_DOWNLOAD_SNIFF_BYTES,
  browserDownloadSource,
  numberedBrowserDownloadName,
  safeBrowserDownloadName,
  sniffBrowserDownload,
  type BrowserTransferLimits,
} from "@octant/domain";
import {
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  MAX_BROWSER_HELD_DOWNLOADS,
  type BrowserDownloadReport,
} from "@octant/contracts";

/** The part of Electron's `DownloadItem` the hold uses. */
export interface DesktopDownloadItemPort {
  getFilename(): string;
  /** Complete native chain including every redirect; absent on an older port. */
  getURLChain?(): ReadonlyArray<string>;
  /** 0 when the page did not say how large the file is. */
  getTotalBytes(): number;
  getReceivedBytes(): number;
  setSavePath(path: string): void;
  cancel(): void;
  on(event: "updated", listener: (event: unknown, state: string) => void): void;
  on(event: "done", listener: (event: unknown, state: string) => void): void;
}

interface Held {
  readonly id: string;
  readonly folder: string;
  readonly path: string;
}

interface Pending {
  readonly item: DesktopDownloadItemPort;
  /** The cap this download was started under. */
  readonly maxFileBytes: number;
  cancelledFor: "too-large" | "unfinished" | undefined;
}

/** How long an action waits for a download it started to finish. */
const FINISH_WAIT_MS = 10_000;
const DEFAULT_LIMITS: BrowserTransferLimits = {
  maxFileBytes: MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  maxHeldDownloads: MAX_BROWSER_HELD_DOWNLOADS,
};

/** How many taken names a person's download steps past before it is refused. */
const MAX_PERSON_DOWNLOAD_COPIES = 1_000;

/**
 * The files one desktop Browser context holds for the agent. A download is held
 * only while an agent action that was allowed to download runs. At any other
 * time a download the person started saves to their Downloads folder, and one
 * a page started on its own is refused. A held file lives in the host's private
 * download folder, never the workspace, and is cancelled the moment more than
 * the cap has arrived.
 */
export class DesktopDownloadHold {
  readonly #root: string | undefined;
  readonly #pending = new Map<Pending, Promise<void>>();
  readonly #held: Held[] = [];
  #reports: BrowserDownloadReport[] = [];
  #holding = false;
  #limits: BrowserTransferLimits = DEFAULT_LIMITS;
  #nextOrdinal = 1;

  /** `root` is the host's private download folder; absent, every download is refused. */
  constructor(root: string | undefined) {
    this.#root = root;
  }

  /** Hold for one agent action, under the person's limits (the defaults when none are passed). */
  begin(limits: BrowserTransferLimits = DEFAULT_LIMITS): void {
    this.#holding = true;
    this.#limits = limits;
  }

  /**
   * Electron's `will-download`: take the download for the agent, let the
   * person's own go to their Downloads folder, or refuse it.
   *
   * `personDownloads` is that folder, named only when the person was the last
   * to drive the pane. Their download is theirs: it is not capped, held or
   * reported to the agent, and it never enters the workspace.
   */
  accept(
    event: { preventDefault?: () => void },
    item: DesktopDownloadItemPort,
    personDownloads?: string,
  ): void {
    if (!this.#holding) {
      const path =
        personDownloads === undefined
          ? undefined
          : freePersonDownloadPath(personDownloads, item.getFilename());
      if (path === undefined) event.preventDefault?.();
      // Without a save path Electron would open a save dialog over the pane.
      else item.setSavePath(path);
      return;
    }
    if (this.#root === undefined) {
      event.preventDefault?.();
      return;
    }
    const name = safeBrowserDownloadName(item.getFilename());
    const maxFileBytes = this.#limits.maxFileBytes;
    if (item.getTotalBytes() > maxFileBytes) {
      // The page said how large it is, and it is too large: nothing is written.
      event.preventDefault?.();
      this.#reports.push({ state: "refused", name, reason: "too-large" });
      return;
    }
    let folder: string;
    try {
      // Private to this user (mkdtemp creates it with mode 0700), made now:
      // Electron needs the save path before this handler returns.
      folder = mkdtempSync(join(this.#root, "d-"));
    } catch {
      event.preventDefault?.();
      this.#reports.push({ state: "refused", name, reason: "failed" });
      return;
    }
    const path = join(folder, "file");
    item.setSavePath(path);
    const entry: Pending = { item, maxFileBytes, cancelledFor: undefined };
    item.on("updated", () => {
      if (item.getReceivedBytes() > maxFileBytes) this.#cancel(entry, "too-large");
    });
    const task = new Promise<void>((resolve) => {
      item.on("done", (_event, state) => {
        void this.#finished(entry, name, folder, path, state).finally(resolve);
      });
    }).finally(() => this.#pending.delete(entry));
    this.#pending.set(entry, task);
  }

  /** Wait (a bounded time) for the downloads this action started, then stop holding. */
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

  takeReports(): ReadonlyArray<BrowserDownloadReport> {
    return this.#reports.splice(0);
  }

  claim(downloadId: string): string | undefined {
    return this.#held.find((held) => held.id === downloadId)?.path;
  }

  async discard(downloadId: string): Promise<void> {
    const index = this.#held.findIndex((held) => held.id === downloadId);
    const [removed] = index === -1 ? [] : this.#held.splice(index, 1);
    if (removed !== undefined) await rm(removed.folder, { recursive: true, force: true });
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
    await Promise.allSettled(
      held.map((entry) => rm(entry.folder, { recursive: true, force: true })),
    );
  }

  #cancel(entry: Pending, reason: "too-large" | "unfinished"): void {
    entry.cancelledFor ??= reason;
    try {
      entry.item.cancel();
    } catch {
      // The download may already be over.
    }
  }

  async #finished(
    entry: Pending,
    name: string,
    folder: string,
    path: string,
    state: string,
  ): Promise<void> {
    const refuse = async (reason: "too-large" | "unfinished" | "failed") => {
      await rm(folder, { recursive: true, force: true });
      this.#reports.push({ state: "refused", name, reason });
    };
    if (state !== "completed") return refuse(entry.cancelledFor ?? "failed");
    let sizeBytes: number;
    let head: Uint8Array;
    try {
      sizeBytes = (await stat(path)).size;
      head = sizeBytes > entry.maxFileBytes ? new Uint8Array() : await readHead(path);
    } catch {
      return refuse("failed");
    }
    if (sizeBytes > entry.maxFileBytes) return refuse("too-large");
    const id = `d${String(this.#nextOrdinal)}`;
    this.#nextOrdinal += 1;
    this.#held.push({ id, folder, path });
    while (this.#held.length > this.#limits.maxHeldDownloads) {
      const oldest = this.#held.shift();
      if (oldest !== undefined) void rm(oldest.folder, { recursive: true, force: true });
    }
    let source;
    try {
      source = browserDownloadSource(entry.item.getURLChain?.() ?? []);
    } catch {
      /* A missing native receipt never borrows the page's origin. */
    }
    this.#reports.push({
      state: "held",
      downloadId: id,
      name,
      sizeBytes,
      mediaType: sniffBrowserDownload(head).mediaType,
      ...(source === undefined ? {} : { source }),
    });
  }
}

/**
 * Where a person's download lands: the page's suggested name reduced to a safe
 * basename, numbered past any file already there so nothing is overwritten.
 */
function freePersonDownloadPath(folder: string, suggested: string): string | undefined {
  const name = safeBrowserDownloadName(suggested);
  for (let copy = 1; copy <= MAX_PERSON_DOWNLOAD_COPIES; copy += 1) {
    const path = join(folder, numberedBrowserDownloadName(name, copy));
    if (!existsSync(path)) return path;
  }
  return undefined;
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
