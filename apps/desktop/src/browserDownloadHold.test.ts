import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopDownloadHold, type DesktopDownloadItemPort } from "./browserDownloadHold";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function root(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "desktop-hold-"));
  folders.push(folder);
  return folder;
}

/** Electron's DownloadItem as far as the hold uses it. */
class FakeItem extends EventEmitter implements DesktopDownloadItemPort {
  savePath: string | undefined;
  received = 0;
  readonly cancel = vi.fn(() => {
    this.emit("done", {}, "cancelled");
  });
  constructor(
    private readonly name: string,
    private readonly total = 0,
  ) {
    super();
  }
  getFilename() {
    return this.name;
  }
  getTotalBytes() {
    return this.total;
  }
  getReceivedBytes() {
    return this.received;
  }
  setSavePath(path: string) {
    this.savePath = path;
  }
  async complete(body: string | Uint8Array) {
    if (this.savePath === undefined) throw new Error("no save path");
    await writeFile(this.savePath, body);
    this.emit("done", {}, "completed");
  }
}

describe("DesktopDownloadHold", () => {
  it("refuses a download when no agent action is running, and when it has no folder", () => {
    const refused = vi.fn();
    const item = new FakeItem("a.txt");
    new DesktopDownloadHold("/unused").accept({ preventDefault: refused }, item);
    expect(refused).toHaveBeenCalledOnce();
    expect(item.savePath).toBeUndefined();
    const noFolder = new DesktopDownloadHold(undefined);
    noFolder.begin();
    noFolder.accept({ preventDefault: refused }, new FakeItem("b.txt"));
    expect(refused).toHaveBeenCalledTimes(2);
  });

  it("holds a download of an agent action in the private folder and reports it by its bytes", async () => {
    const hold = new DesktopDownloadHold(await root());
    hold.begin();
    const item = new FakeItem("../../report.pdf", 8);
    const refused = vi.fn();
    hold.accept({ preventDefault: refused }, item);
    expect(refused).not.toHaveBeenCalled();
    await item.complete("%PDF-1.4");
    await hold.finish();
    expect(hold.takeReports()).toEqual([
      {
        state: "held",
        downloadId: "d1",
        name: "report.pdf",
        sizeBytes: 8,
        mediaType: "application/pdf",
      },
    ]);
    const path = hold.claim("d1");
    expect(path).toBeDefined();
    expect(await readFile(path ?? "", "utf8")).toBe("%PDF-1.4");
    await hold.discard("d1");
    expect(existsSync(path ?? "")).toBe(false);
    expect(hold.claim("d1")).toBeUndefined();
  });

  it("refuses at once a download whose announced size is over the cap, writing nothing", async () => {
    const hold = new DesktopDownloadHold(await root());
    hold.begin();
    const refused = vi.fn();
    const item = new FakeItem("big.bin", 26 * 1024 * 1024);
    hold.accept({ preventDefault: refused }, item);
    expect(refused).toHaveBeenCalledOnce();
    expect(item.savePath).toBeUndefined();
    await hold.finish();
    expect(hold.takeReports()).toEqual([
      { state: "refused", name: "big.bin", reason: "too-large" },
    ]);
  });

  it("cancels a download as it passes the cap while it is still arriving", async () => {
    const hold = new DesktopDownloadHold(await root());
    hold.begin();
    const item = new FakeItem("stream.bin");
    hold.accept({}, item);
    item.received = 25 * 1024 * 1024;
    item.emit("updated", {}, "progressing");
    expect(item.cancel).not.toHaveBeenCalled();
    item.received = 25 * 1024 * 1024 + 1;
    item.emit("updated", {}, "progressing");
    expect(item.cancel).toHaveBeenCalledOnce();
    await hold.finish();
    expect(hold.takeReports()).toEqual([
      { state: "refused", name: "stream.bin", reason: "too-large" },
    ]);
    expect(hold.claim("d1")).toBeUndefined();
  });

  it("keeps five and discards the oldest; closing deletes the rest", async () => {
    const hold = new DesktopDownloadHold(await root());
    hold.begin();
    const paths: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const item = new FakeItem(`f${String(index)}.txt`);
      hold.accept({}, item);
      await item.complete("x");
      paths.push(item.savePath ?? "");
    }
    await hold.finish();
    expect(hold.claim("d1")).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(paths[0] ?? "")).toBe(false);
    for (const id of ["d2", "d3", "d4", "d5", "d6"]) expect(hold.claim(id)).toBeDefined();
    await hold.dispose();
    for (const path of paths) expect(existsSync(path)).toBe(false);
  });

  it("stops accepting downloads once it starts waiting, so none slips past the bounded wait", async () => {
    const hold = new DesktopDownloadHold(await root());
    hold.begin();
    const running = new FakeItem("running.bin");
    hold.accept({}, running);
    const finishing = hold.finish();
    const refused = vi.fn();
    const late = new FakeItem("late.txt");
    hold.accept({ preventDefault: refused }, late);
    expect(refused).toHaveBeenCalledOnce();
    expect(late.savePath).toBeUndefined();
    await running.complete("x");
    await finishing;
    expect(hold.takeReports().map((report) => report.name)).toEqual(["running.bin"]);
  });
});
