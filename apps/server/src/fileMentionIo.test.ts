import { lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileMentionIo, pinFileMentionRoot } from "./fileMentionIo";

describe("pinFileMentionRoot", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("captures the device and inode of the authorized directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-file-mention-"));
    roots.push(root);
    const metadata = await lstat(root, { bigint: true });

    await expect(pinFileMentionRoot(root)).resolves.toEqual({
      kind: "ok",
      rootPath: root,
      rootIdentity: {
        device: metadata.dev.toString(10),
        inode: metadata.ino.toString(10),
      },
    });
  });

  it("refuses a Work root that is a symlink rather than the bound directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-file-mention-"));
    roots.push(parent);
    const target = join(parent, "target");
    const link = join(parent, "work");
    await mkdir(target);
    await symlink(target, link);

    await expect(pinFileMentionRoot(link)).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("createFileMentionIo", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("does not list or read a Work root swapped for a different directory after identity was pinned", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-file-mention-"));
    roots.push(parent);
    const root = join(parent, "work");
    await mkdir(root);
    await writeFile(join(root, "notes.md"), "authorized");
    const pinned = await pinFileMentionRoot(root);
    expect(pinned.kind).toBe("ok");
    if (pinned.kind !== "ok") return;

    await rename(root, join(parent, "authorized"));
    await mkdir(root);
    await writeFile(join(root, "notes.md"), "replacement");

    const io = createFileMentionIo();
    await expect(io.list(root, pinned.rootIdentity)).resolves.toEqual([]);
    await expect(io.locate(root, "notes.md", pinned.rootIdentity)).resolves.toEqual({
      kind: "missing",
    });
  });
});
