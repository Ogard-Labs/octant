import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaywrightDownloadHold, type PlaywrightDownloadPort } from "./playwrightDownloadHold";

const folders: string[] = [];
afterEach(async () => {
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

  it("deletes a held file when it is discarded or the context closes", async () => {
    const hold = new PlaywrightDownloadHold();
    hold.begin();
    const first = await fakeDownload("a.txt", "x");
    const second = await fakeDownload("b.txt", "x");
    hold.onDownload(first);
    hold.onDownload(second);
    await hold.finish();
    await hold.discard("d1");
    expect(first.delete).toHaveBeenCalled();
    expect(hold.claim("d1")).toBeUndefined();
    await hold.dispose();
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
    const hold = new PlaywrightDownloadHold(folder);
    hold.begin();
    const download = await fakeDownload("stream.bin", "", { never: true });
    hold.onDownload(download);
    await hold.finish();
    expect(download.cancelled()).toBe(true);
    expect(hold.takeReports()).toEqual([
      { state: "refused", name: "stream.bin", reason: "too-large" },
    ]);
  });
});
