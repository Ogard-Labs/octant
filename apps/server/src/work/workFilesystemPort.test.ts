import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { readFile, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { liveWorkFilesystem } from "./workFilesystemPort";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Resolution hands the port canonical paths, so the fixture resolves its root:
// macOS's tmpdir sits behind the /var → /private/var symlink, which the
// darwin child-open guard would otherwise (correctly) refuse.
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-work-filesystem-")));
  directories.push(root);
  return root;
}

describe("live Work filesystem directory chain", () => {
  it("creates nested children through a proven parent directory on the host filesystem", async () => {
    const root = fixture();
    const parent = await liveWorkFilesystem.openDirectory(root);
    try {
      await parent.mkdir("reports");
      const reports = await parent.openDirectory("reports");
      try {
        expect((await reports.stat()).isDirectory).toBe(true);
        const file = await reports.openWriteFile("summary.txt", { exclusiveCreate: true });
        await file.write(new TextEncoder().encode("confined bytes"));
        await file.close();
      } finally {
        await reports.close();
      }
    } finally {
      await parent.close();
    }
    expect(new TextDecoder().decode(await readFile(join(root, "reports", "summary.txt")))).toBe(
      "confined bytes",
    );
  });

  it("refuses a child entry that is a symlink or a traversing name", async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, "inside"));
    symlinkSync(outside, join(root, "escape"));
    const parent = await liveWorkFilesystem.openDirectory(root);
    try {
      await expect(parent.openDirectory("escape")).rejects.toThrow();
      await expect(parent.openWriteFile("escape", { exclusiveCreate: false })).rejects.toThrow();
      await expect(parent.openDirectory("../inside")).rejects.toThrow();
      await expect(parent.mkdir("..")).rejects.toThrow();
    } finally {
      await parent.close();
    }
  });

  it("never opens a decoy behind an ancestor swapped in after the parent was proven", async () => {
    const root = fixture();
    const outside = fixture();
    mkdirSync(join(root, "a", "b"), { recursive: true });
    mkdirSync(join(outside, "b"));
    const original = await stat(join(root, "a", "b"), { bigint: true });
    const decoy = await stat(join(outside, "b"), { bigint: true });

    const proven = await liveWorkFilesystem.openDirectory(join(root, "a"));
    try {
      await rename(join(root, "a"), join(root, "a-moved"));
      symlinkSync(outside, join(root, "a"));

      // Linux resolves the child against the held directory object and finds
      // the moved original; macOS refuses the symlinked ancestor outright.
      // Either way the swapped-in decoy must never answer.
      let opened;
      try {
        opened = await proven.openDirectory("b");
      } catch {
        return;
      }
      try {
        const identity = await opened.stat();
        expect(identity.device).toBe(String(original.dev));
        expect(identity.inode).toBe(String(original.ino));
        expect(
          identity.device === String(decoy.dev) && identity.inode === String(decoy.ino),
        ).toBe(false);
      } finally {
        await opened.close();
      }
    } finally {
      await proven.close();
    }
  });
});
