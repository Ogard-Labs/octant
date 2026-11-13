import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DownloadFolderWatch,
  PlaywrightDownloadHold,
  type PlaywrightDownloadPort,
} from "./playwrightDownloadHold";

const folders: string[] = [];
const delayed = vi.hoisted(() => ({ path: "", stage: "", entered: false, release: () => {} }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const pause = async (path: unknown, stage: string) => {
    if (path !== delayed.path || delayed.stage !== stage || delayed.entered) return;
    delayed.entered = true;
    await new Promise<void>((resolve) => {
      delayed.release = resolve;
    });
  };
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      const result = await fs.stat(...args);
      await pause(args[0], "stat");
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const result = await fs.open(...args);
      await pause(args[0], "head");
      return result;
    },
  };
});
afterEach(async () => {
  delayed.release();
  Object.assign(delayed, { path: "", stage: "", entered: false, release: () => {} });
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function fakeDownload(
  name: string,
  body: string | Uint8Array,
  options: { readonly never?: boolean } = {},
) {
  const folder = await mkdtemp(join(tmpdir(), "hold-unit-"));
  folders.push(folder);
  const path = join(folder, "guid");
  await writeFile(path, body);
  let cancelled = false;
  const download: PlaywrightDownloadPort & { readonly cancelled: () => boolean } = {
    suggestedFilename: () => name,
    path: () =>
      options.never === true
        ? new Promise<string>((_resolve, reject) => {
            const timer = setInterval(() => {
              if (cancelled) {
                clearInterval(timer);
                reject(new Error("cancelled"));
              }
            }, 5);
          })
        : Promise.resolve(path),
    cancel: vi.fn(async () => {
      cancelled = true;
    }),
    delete: vi.fn(async () => undefined),
    cancelled: () => cancelled,
  };
  return download;
}

describe("PlaywrightDownloadHold", () => {
  it.each(["stat", "head"])(
    "refuses cancellation that arrives while the completed file waits for %s",
    async (stage) => {
      const folder = await mkdtemp(join(tmpdir(), "hold-unit-inspection-race-"));
      folders.push(folder);
      const path = join(folder, "finished.txt");
      await writeFile(path, "small final file");
      const watch = new DownloadFolderWatch(folder);
      watch.finished(path);
      const hold = new PlaywrightDownloadHold(watch);
      const download = {
        suggestedFilename: () => "report.txt",
        path: async () => path,
        cancel: vi.fn(async () => {}),
        delete: vi.fn(async () => {}),
      };
      Object.assign(delayed, { path, stage });
      hold.begin();
      hold.onDownload(download);
      try {
        await vi.waitFor(() => expect(delayed.entered).toBe(true));
        await writeFile(
          join(folder, "unattributed.crdownload"),
          new Uint8Array(25 * 1024 * 1024 + 1),
        );
        await vi.waitFor(() => expect(download.cancel).toHaveBeenCalled());
        delayed.release();
        await hold.finish();
        expect(hold.takeReports()).toEqual([
          { state: "refused", name: "report.txt", reason: "too-large" },
        ]);
        expect(hold.claim("d1")).toBeUndefined();
        expect(download.delete).toHaveBeenCalledOnce();
      } finally {
        delayed.release();
        await hold.dispose();
      }
    },
  );
  it("cancels a download the page starts when no agent action is running", async () => {
    const hold = new PlaywrightDownloadHold();
    const download = await fakeDownload("a.txt", "hello");
    hold.onDownload(download);
    expect(download.cancel).toHaveBeenCalledOnce();
    await hold.finish();
    expect(hold.takeReports()).toEqual([]);
  });

  it("holds a download started during an action, naming it safely and sniffing its type", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    hold.onDownload(await fakeDownload("../../etc/report.txt", "hello"));
    await hold.finish();
    expect(hold.takeReports()).toEqual([
      {
        state: "held",
        downloadId: "d1",
        name: "report.txt",
        sizeBytes: 5,
        mediaType: "text/plain",
      },
    ]);
    // Once reported, never reported again; and a download after the action is cancelled.
    expect(hold.takeReports()).toEqual([]);
    const late = await fakeDownload("late.txt", "x");
    hold.onDownload(late);
    expect(late.cancel).toHaveBeenCalledOnce();
  });

  it("keeps five and discards the oldest", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    const downloads = [];
    for (let index = 0; index < 6; index += 1) {
      const download = await fakeDownload(`f${String(index)}.txt`, "x");
      downloads.push(download);
      hold.onDownload(download);
    }
    await hold.finish();
    expect(hold.claim("d1")).toBeUndefined();
    expect(downloads[0]?.delete).toHaveBeenCalled();
    for (const id of ["d2", "d3", "d4", "d5", "d6"]) expect(hold.claim(id)).toBeDefined();
  });

  it("holds to the limits the person set in Settings instead of the defaults", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin({ maxFileBytes: 4, maxHeldDownloads: 2 });
    const downloads = [
      await fakeDownload("a.txt", "x"),
      await fakeDownload("b.txt", "x"),
      await fakeDownload("c.txt", "x"),
      await fakeDownload("over.txt", "12345"),
    ];
    for (const download of downloads) hold.onDownload(download);
    await hold.finish();
    expect(hold.takeReports()).toContainEqual({
      state: "refused",
      name: "over.txt",
      reason: "too-large",
    });
    expect(["d1", "d2", "d3", "d4"].filter((id) => hold.claim(id) !== undefined)).toHaveLength(2);
    await hold.dispose();
  });

  it("deletes a held file when it is discarded or the context closes", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    const first = await fakeDownload("a.txt", "x");
    const second = await fakeDownload("b.txt", "x");
    hold.onDownload(first);
    hold.onDownload(second);
    await hold.finish();
    // Which file is d1 depends on which finished reading first.
    await hold.discard("d1");
    expect(
      vi.mocked(first.delete).mock.calls.length + vi.mocked(second.delete).mock.calls.length,
    ).toBe(1);
    expect(hold.claim("d1")).toBeUndefined();
    await hold.dispose();
    expect(first.delete).toHaveBeenCalled();
    expect(second.delete).toHaveBeenCalled();
  });

  it("refuses a finished file over the cap and deletes it", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    const big = await fakeDownload("big.bin", new Uint8Array(25 * 1024 * 1024 + 1));
    hold.onDownload(big);
    await hold.finish();
    expect(hold.takeReports()).toEqual([
      { state: "refused", name: "big.bin", reason: "too-large" },
    ]);
    expect(big.delete).toHaveBeenCalled();
  });

  it("cancels the folder's file when it passes the cap while still arriving", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hold-unit-watch-"));
    folders.push(folder);
    await writeFile(join(folder, "guid.crdownload"), new Uint8Array(25 * 1024 * 1024 + 1));
    const hold = new PlaywrightDownloadHold(new DownloadFolderWatch(folder));
    hold.begin();
    const download = await fakeDownload("stream.bin", "", { never: true });
    hold.onDownload(download);
    await hold.finish();
    expect(download.cancelled()).toBe(true);
    expect(hold.takeReports()).toEqual([
      { state: "refused", name: "stream.bin", reason: "too-large" },
    ]);
  });

  it("cancels ambiguous concurrent downloads when an unattributed file exceeds the cap", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hold-unit-concurrent-"));
    folders.push(folder);
    const watch = new DownloadFolderWatch(folder);
    const first = new PlaywrightDownloadHold(watch);
    const second = new PlaywrightDownloadHold(watch);
    first.begin();
    second.begin();
    const big = await fakeDownload("big.bin", "", { never: true });
    const small = await fakeDownload("small.txt", "", { never: true });
    first.onDownload(big);
    second.onDownload(small);
    await writeFile(join(folder, "first.crdownload"), new Uint8Array(25 * 1024 * 1024 + 1));
    await writeFile(join(folder, "second.crdownload"), "still arriving");
    try {
      await vi.waitFor(() => {
        expect(big.cancelled()).toBe(true);
        expect(small.cancelled()).toBe(true);
      });
      await Promise.all([first.finish(), second.finish()]);
      expect(first.takeReports()).toEqual([
        { state: "refused", name: "big.bin", reason: "too-large" },
      ]);
      expect(second.takeReports()).toEqual([
        { state: "refused", name: "small.txt", reason: "too-large" },
      ]);
    } finally {
      await Promise.all([first.dispose(), second.dispose()]);
    }
  });

  it("never holds a file whose completion races a size cancellation", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hold-unit-late-completion-"));
    folders.push(folder);
    const path = join(folder, "finished.txt");
    await writeFile(path, "small final file");
    await writeFile(join(folder, "large.crdownload"), new Uint8Array(25 * 1024 * 1024 + 1));
    const watch = new DownloadFolderWatch(folder);
    watch.finished(path);
    const hold = new PlaywrightDownloadHold(watch);
    let finish = (_path: string) => {};
    const completion = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const download = {
      suggestedFilename: () => "report.txt",
      path: () => completion,
      cancel: vi.fn(async () => {
        finish(path);
      }),
      delete: vi.fn(async () => {}),
    };
    hold.begin();
    hold.onDownload(download);
    try {
      await hold.finish();
      expect(hold.takeReports()).toEqual([
        { state: "refused", name: "report.txt", reason: "too-large" },
      ]);
      expect(hold.claim("d1")).toBeUndefined();
      expect(download.delete).toHaveBeenCalledOnce();
    } finally {
      await hold.dispose();
    }
  });

  it("stops accepting downloads once it starts waiting, so none slips past the bounded wait", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    const running = await fakeDownload("running.bin", "", { never: true });
    hold.onDownload(running);
    const finishing = hold.finish();
    // A download that starts while the action's downloads are being waited on.
    const late = await fakeDownload("late.txt", "x");
    hold.onDownload(late);
    expect(late.cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(running.cancelled()).toBe(false));
    running.cancel();
    await finishing;
    expect(hold.takeReports().map((report) => report.name)).not.toContain("late.txt");
    expect(hold.claim("d1")).toBeUndefined();
  });

  it("measures each context's own files, so one oversize file never cancels another context's download", async () => {
    const folder = await mkdtemp(join(tmpdir(), "hold-unit-shared-"));
    folders.push(folder);
    const watch = new DownloadFolderWatch(folder);
    const first = new PlaywrightDownloadHold(watch);
    const second = new PlaywrightDownloadHold(watch);
    first.begin();
    const big = await fakeDownload("big.bin", "", { never: true });
    first.onDownload(big);
    await writeFile(join(folder, "aaaa.crdownload"), new Uint8Array(25 * 1024 * 1024 + 1));
    await vi.waitFor(() => expect(big.cancelled()).toBe(true));
    second.begin();
    const small = await fakeDownload("small.txt", "hello");
    second.onDownload(small);
    await second.finish();
    await first.finish();
    expect(small.cancel).not.toHaveBeenCalled();
    expect(second.takeReports()).toEqual([
      { state: "held", downloadId: "d1", name: "small.txt", sizeBytes: 5, mediaType: "text/plain" },
    ]);
    expect(first.takeReports()).toEqual([
      { state: "refused", name: "big.bin", reason: "too-large" },
    ]);
  });
});
