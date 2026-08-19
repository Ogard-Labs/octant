import { describe, expect, it } from "vitest";
import { writeConfinedWorkFile } from "./workConfinedWrite";
import { workFilesystemFixture } from "./workFilesystemFixture";

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
});
