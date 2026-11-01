import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserDownloadHoldRoot,
  isInsideBrowserDownloadHold,
  prepareBrowserDownloadHoldRoot,
} from "./browserDownloadHold";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});
async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "hold-test-"));
  cleanup.push(folder);
  return folder;
}

describe("Browser download hold", () => {
  it("empties the hold folder when a host starts, and only its own", async () => {
    const tmp = await temporaryFolder();
    const headless = await prepareBrowserDownloadHoldRoot("headless", tmp);
    const desktop = await prepareBrowserDownloadHoldRoot("desktop", tmp);
    await writeFile(join(headless, "old"), "x");
    await writeFile(join(desktop, "kept"), "x");
    await prepareBrowserDownloadHoldRoot("headless", tmp);
    expect(await isInsideBrowserDownloadHold(join(headless, "old"), tmp)).toBe(false);
    expect(await isInsideBrowserDownloadHold(join(desktop, "kept"), tmp)).toBe(true);
  });

  it("recognises only paths inside a hold folder, not links out of one", async () => {
    const tmp = await temporaryFolder();
    const root = await prepareBrowserDownloadHoldRoot("headless", tmp);
    const outside = join(tmp, "secret");
    await writeFile(outside, "x");
    await mkdir(join(root, "a"));
    await symlink(outside, join(root, "a", "link"));
    await writeFile(join(root, "a", "file"), "x");
    expect(await isInsideBrowserDownloadHold(join(root, "a", "file"), tmp)).toBe(true);
    expect(await isInsideBrowserDownloadHold(join(root, "a", "link"), tmp)).toBe(false);
    expect(await isInsideBrowserDownloadHold(outside, tmp)).toBe(false);
    expect(await isInsideBrowserDownloadHold(join(root, "missing"), tmp)).toBe(false);
    expect(browserDownloadHoldRoot("desktop", tmp)).toContain("octant-browser-downloads-");
  });

  it("replaces a link planted where the folder should be", async () => {
    const tmp = await temporaryFolder();
    const target = await temporaryFolder();
    await symlink(target, browserDownloadHoldRoot("headless", tmp).replace(/\/headless$/, ""));
    const root = await prepareBrowserDownloadHoldRoot("headless", tmp);
    await writeFile(join(root, "f"), "x");
    expect(await isInsideBrowserDownloadHold(join(root, "f"), tmp)).toBe(true);
  });
});
