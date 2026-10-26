import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveCodeDirectoryPort, liveCodeTestSourcePort } from "./codeDirectoryPort";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-code-directory-"));
  roots.push(root);
  return root;
}

describe("liveCodeDirectoryPort.openDirectory", () => {
  it("reports the opened object's own identity and reads names under a bound", async () => {
    const root = await tempRoot();
    const directory = join(root, "src");
    await mkdir(directory);
    for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(join(directory, name), "x");

    const expected = await liveCodeDirectoryPort.lstat(directory);
    const opened = await liveCodeDirectoryPort.openDirectory(directory);
    try {
      // The identity comes from the open handle, which is what a caller
      // compares against the object its containment sequence resolved.
      expect(await opened.stat()).toEqual({
        isDirectory: true,
        device: expected.device,
        inode: expected.inode,
      });

      const first = await opened.read(2);
      const rest = await opened.read(2);
      expect(first).toHaveLength(2);
      expect([...first, ...rest].map((entry) => entry.name).sort()).toEqual([
        "a.ts",
        "b.ts",
        "c.ts",
      ]);
      expect(await opened.read(2)).toEqual([]);
    } finally {
      await opened.close();
    }
  });

  it("refuses a name that is a symlink to a directory", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "kept.ts"), "x");
    await symlink(join(root, "real"), join(root, "link"));

    // O_NOFOLLOW: a directory name replaced by a link is an error, never a
    // redirected enumeration.
    await expect(liveCodeDirectoryPort.openDirectory(join(root, "link"))).rejects.toThrow();
  });

  it("refuses a name that is not a directory", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "notes.md"), "x");

    await expect(liveCodeDirectoryPort.openDirectory(join(root, "notes.md"))).rejects.toThrow();
  });
});

describe("liveCodeTestSourcePort.openFile", () => {
  // A file swapped for a FIFO between the containment check and the open used
  // to block the open until a writer appeared, stalling the read for good.
  it.skipIf(process.platform === "win32")(
    "opens a FIFO without waiting for a writer, so the caller can refuse it",
    async () => {
      const root = await tempRoot();
      const fifo = join(root, "notes.md");
      execFileSync("mkfifo", [fifo]);

      const opened = await Promise.race([
        liveCodeTestSourcePort.openFile(fifo),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);

      expect(opened).not.toBe("blocked");
      if (opened === "blocked") return;
      try {
        expect((await opened.stat()).isFile).toBe(false);
      } finally {
        await opened.close();
      }
    },
  );
});
