import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfinedWorkFile } from "./workConfinedWrite";
import { workFilesystemFixture } from "./workFilesystemFixture";
import { liveWorkFilesystem } from "./workFilesystemPort";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("writeConfinedWorkFile", () => {
  it("creates a missing file exclusively and keeps the bytes inside the root", async () => {
    const filesystem = workFilesystemFixture();
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/notes.md",
      allowCreate: true,
      bytes: encoder.encode("# Hello"),
    });
    expect(written).toBe(true);
    expect(decoder.decode(filesystem.readBytes("/work/notes.md"))).toBe("# Hello");
  });

  it("refuses to create through a symlink planted at the target name", async () => {
    const filesystem = workFilesystemFixture();
    filesystem.putFile("/outside/secret.md", encoder.encode("host credentials"));
    filesystem.putSymlink("/work/notes.md", "/outside/secret.md");

    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/notes.md",
      allowCreate: true,
      bytes: encoder.encode("# Hello"),
    });

    expect(written).toBe(false);
    expect(decoder.decode(filesystem.readBytes("/outside/secret.md"))).toBe("host credentials");
  });

  it("refuses to overwrite an object whose identity no longer matches", async () => {
    const filesystem = workFilesystemFixture();
    await filesystem.writeFile("/work/notes.md", encoder.encode("# Hello"));
    const original = await filesystem.lstat("/work/notes.md");
    filesystem.putFile("/work/notes.md", encoder.encode("# Hello"));

    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/notes.md",
      expected: { device: original.device, inode: original.inode },
      allowCreate: false,
      bytes: encoder.encode("# Revised"),
    });

    expect(written).toBe(false);
    expect(decoder.decode(filesystem.readBytes("/work/notes.md"))).toBe("# Hello");
  });

  it("rewrites the same object in place when its identity still matches", async () => {
    const filesystem = workFilesystemFixture();
    await filesystem.writeFile("/work/notes.md", encoder.encode("# Hello"));
    const original = await filesystem.lstat("/work/notes.md");

    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/notes.md",
      expected: { device: original.device, inode: original.inode },
      allowCreate: false,
      bytes: encoder.encode("# Revised"),
    });

    expect(written).toBe(true);
    const after = await filesystem.lstat("/work/notes.md");
    expect(after.inode).toBe(original.inode);
    expect(decoder.decode(filesystem.readBytes("/work/notes.md"))).toBe("# Revised");
  });

  it("refuses an overwrite when a symlink now answers to the name", async () => {
    const filesystem = workFilesystemFixture();
    await filesystem.writeFile("/work/notes.md", encoder.encode("# Hello"));
    const original = await filesystem.lstat("/work/notes.md");
    filesystem.putFile("/outside/secret.md", encoder.encode("host credentials"));
    filesystem.putSymlink("/work/notes.md", "/outside/secret.md");

    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/notes.md",
      expected: { device: original.device, inode: original.inode },
      allowCreate: false,
      bytes: encoder.encode("# Revised"),
    });

    expect(written).toBe(false);
    expect(decoder.decode(filesystem.readBytes("/outside/secret.md"))).toBe("host credentials");
  });

  it("creates under the proven parent directory rather than reopening the path", async () => {
    const filesystem = workFilesystemFixture();
    const parent = await filesystem.lstat("/work");
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/cube.png",
      allowCreate: true,
      parent: {
        absolutePath: "/work",
        identity: { device: parent.device, inode: parent.inode },
        remaining: ["cube.png"],
      },
      bytes: encoder.encode("png"),
    });
    expect(written).toBe(true);
    expect(decoder.decode(filesystem.readBytes("/work/cube.png"))).toBe("png");
  });

  it("refuses a create when the proven parent directory is no longer that object", async () => {
    const filesystem = workFilesystemFixture();
    const parent = await filesystem.lstat("/work");
    const written = await writeConfinedWorkFile({
      filesystem,
      canonicalPath: "/work/cube.png",
      allowCreate: true,
      parent: {
        absolutePath: "/work",
        identity: { device: parent.device, inode: "missing" },
        remaining: ["cube.png"],
      },
      bytes: encoder.encode("png"),
    });
    expect(written).toBe(false);
    expect(filesystem.readBytes("/work/cube.png")).toBeUndefined();
  });

  it("refuses a create after the proven parent is swapped for an escaping symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-create-parent-"));
    const secret = await mkdtemp(join(tmpdir(), "octant-create-secret-"));
    const assets = join(root, "assets");
    try {
      await mkdir(assets);
      const parent = await liveWorkFilesystem.lstat(assets);
      await rm(assets, { recursive: true });
      await symlink(secret, assets);
      const written = await writeConfinedWorkFile({
        filesystem: liveWorkFilesystem,
        canonicalPath: join(assets, "x.png"),
        allowCreate: true,
        parent: {
          absolutePath: assets,
          identity: { device: parent.device, inode: parent.inode },
          remaining: ["x.png"],
        },
        bytes: encoder.encode("png"),
      });
      expect(written).toBe(false);
      expect(await readdir(secret)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(secret, { recursive: true, force: true });
    }
  });

  it("keeps a create on the open parent after the parent name is swapped", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-create-bound-"));
    const secret = await mkdtemp(join(tmpdir(), "octant-create-bound-secret-"));
    const assets = join(root, "assets");
    const assetsReal = join(root, "assets-real");
    try {
      await mkdir(assets);
      const parent = await liveWorkFilesystem.lstat(assets);
      const filesystem = {
        ...liveWorkFilesystem,
        openDirectory: async (path: string) => {
          const directory = await liveWorkFilesystem.openDirectory(path);
          if (path === assets) {
            await rename(assets, assetsReal);
            await symlink(secret, assets);
          }
          return directory;
        },
      };
      const written = await writeConfinedWorkFile({
        filesystem,
        canonicalPath: join(assets, "x.png"),
        allowCreate: true,
        parent: {
          absolutePath: assets,
          identity: { device: parent.device, inode: parent.inode },
          remaining: ["x.png"],
        },
        bytes: encoder.encode("png"),
      });
      expect(written).toBe(true);
      expect(await readdir(secret)).toEqual([]);
      expect(decoder.decode(await readFile(join(assetsReal, "x.png")))).toBe("png");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(secret, { recursive: true, force: true });
    }
  });
});
