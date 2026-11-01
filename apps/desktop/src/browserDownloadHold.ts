import { mkdtempSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  BROWSER_DOWNLOAD_SNIFF_BYTES,
  safeBrowserDownloadName,
  sniffBrowserDownload,
} from "@octant/domain";
import {
  MAX_BROWSER_DOWNLOAD_FILE_BYTES,
  MAX_BROWSER_HELD_DOWNLOADS,
  type BrowserDownloadReport,
} from "@octant/contracts";

/** The part of Electron's `DownloadItem` the hold uses. */
export interface DesktopDownloadItemPort {
  getFilename(): string;
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
  cancelledFor: "too-large" | "unfinished" | undefined;
}

/** How long an action waits for a download it started to finish. */
const FINISH_WAIT_MS = 10_000;

/**
 * The files one desktop Browser context holds for the agent. A download is held
 * only while an agent action that was allowed to download runs; at any other
 * time, including whenever the person drives the pane, it is refused. A held
 * file lives in the host's private download folder, never the workspace, and is
 * cancelled the moment more than the cap has arrived.
 */
export class DesktopDownloadHold {
  readonly #root: string | undefined;
  readonly #pending = new Map<Pending, Promise<void>>();
  readonly #held: Held[] = [];
  #reports: BrowserDownloadReport[] = [];
  #holding = false;
  #nextOrdinal = 1;

  /** `root` is the host's private download folder; absent, every download is refused. */
  constructor(root: string | undefined) {
    this.#root = root;
  }

  begin(): void {
    this.#holding = true;
  }

  /** Electron's `will-download`: take the download for the agent, or refuse it. */
  accept(event: { preventDefault?: () => void }, item: DesktopDownloadItemPort): void {
    if (!this.#holding || this.#root === undefined) {
      event.preventDefault?.();
      return;
    }
    const name = safeBrowserDownloadName(item.getFilename());
    if (item.getTotalBytes() > MAX_BROWSER_DOWNLOAD_FILE_BYTES) {
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
    const entry: Pending = { item, cancelledFor: undefined };
    item.on("updated", () => {
      if (item.getReceivedBytes() > MAX_BROWSER_DOWNLOAD_FILE_BYTES)
        this.#cancel(entry, "too-large");
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
      head = sizeBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES ? new Uint8Array() : await readHead(path);
    } catch {
      return refuse("failed");
    }
    if (sizeBytes > MAX_BROWSER_DOWNLOAD_FILE_BYTES) return refuse("too-large");
    const id = `d${String(this.#nextOrdinal)}`;
    this.#nextOrdinal += 1;
    this.#held.push({ id, folder, path });
    while (this.#held.length > MAX_BROWSER_HELD_DOWNLOADS) {
      const oldest = this.#held.shift();
      if (oldest !== undefined) void rm(oldest.folder, { recursive: true, force: true });
    }
    this.#reports.push({
      state: "held",
      downloadId: id,
      name,
      sizeBytes,
      mediaType: sniffBrowserDownload(head).mediaType,
    });
  }
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
