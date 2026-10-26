import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDesktopArtifact, type DesktopArtifactFile } from "./desktopArtifactRead";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function checkoutWith(contents: string): { readonly root: string; readonly file: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-desktop-artifact-")));
  directories.push(root);
  const file = join(root, "app.bin");
  writeFileSync(file, contents);
  return { root, file };
}

/** Opens the real file, then lets `change` alter it on disk after the first chunk is read. */
function changingAfterFirstRead(change: () => void) {
  return async (path: string, flags: number): Promise<DesktopArtifactFile> => {
    const handle = await open(path, flags);
    let reads = 0;
    return {
      stat: () => handle.stat(),
      read: async (buffer, offset, length, position) => {
        reads += 1;
        // Only the first call returns real bytes, so the read is split and the
        // change lands between its parts.
        const first = reads === 1;
        const result = await handle.read(buffer, offset, first ? 1 : length, position);
        if (first) change();
        return result;
      },
      close: () => handle.close(),
    };
  };
}

describe("desktop artifact read", () => {
  it("refuses a file that grows while it is being read", async () => {
    const { root, file } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => appendFileSync(file, " and more")),
      }),
    ).resolves.toEqual({ status: "refused", reason: "changed-while-read" });
  });

  it("refuses a file that shrinks while it is being read", async () => {
    const { root, file } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => truncateSync(file, 2)),
      }),
    ).resolves.toEqual({ status: "refused", reason: "changed-while-read" });
  });

  it("reads an unchanged file whole and names its hash", async () => {
    const { root } = checkoutWith("built app");
    await expect(
      readDesktopArtifact({
        root,
        path: "app.bin",
        maximumBytes: 1_024,
        openFile: changingAfterFirstRead(() => undefined),
      }),
    ).resolves.toMatchObject({
      status: "read",
      artifact: { path: "app.bin", name: "app.bin", size: 9 },
      bytes: new TextEncoder().encode("built app"),
    });
  });
});
