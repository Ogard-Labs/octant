import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNodePortableImageFiles,
  createPortableImagePort,
  isPortableImageBytes,
  readPortableImageLocation,
  relaunchPortableImage,
  replacePortableImage,
  type PortableImageChild,
  type PortableImageFiles,
  type PortableImageSpawnOptions,
} from "./portableImageUpdate";

const digestOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function imageBytes(marker: string): Uint8Array {
  const payload = Buffer.from(marker);
  const bytes = Buffer.alloc(11 + payload.byteLength);
  bytes[8] = 0x41;
  bytes[9] = 0x49;
  bytes[10] = 0x02;
  payload.copy(bytes, 11);
  return bytes;
}

const roots: string[] = [];

async function imageDir(): Promise<{ readonly root: string; readonly path: string }> {
  const root = await mkdtemp(join(tmpdir(), "octant-image-"));
  roots.push(root);
  const path = join(root, "Octant.AppImage");
  await writeFile(path, imageBytes("running"));
  await chmod(path, 0o755);
  return { root, path };
}

function recording(inner: PortableImageFiles): {
  readonly files: PortableImageFiles;
  readonly events: string[];
} {
  const events: string[] = [];
  const note = (kind: string, path: string): void => {
    events.push(`${kind} ${basename(path)}`);
  };
  return {
    events,
    files: {
      writeFile: async (path, bytes) => {
        note("write", path);
        await inner.writeFile(path, bytes);
      },
      chmod: (path, mode) => inner.chmod(path, mode),
      fsync: async (path) => {
        note("fsync", path);
        await inner.fsync(path);
      },
      rename: async (from, to) => {
        events.push(`rename ${basename(from)} -> ${basename(to)}`);
        await inner.rename(from, to);
      },
      keepCopy: async (from, to) => {
        events.push(`keep ${basename(from)} -> ${basename(to)}`);
        await inner.keepCopy(from, to);
      },
      readFile: (path) => inner.readFile(path),
      readPrefix: (path, length) => inner.readPrefix(path, length),
      unlink: (path) => inner.unlink(path),
      lstat: (path) => inner.lstat(path),
      canWrite: (directory) => inner.canWrite(directory),
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("portable image location", () => {
  it("refuses a launch that did not come from a portable image", async () => {
    const files = createNodePortableImageFiles();
    const { path } = await imageDir();

    expect(await readPortableImageLocation({}, files)).toEqual({ kind: "not-portable" });
    expect(await readPortableImageLocation({ APPIMAGE: "relative.AppImage" }, files)).toEqual({
      kind: "not-portable",
    });
    expect(await readPortableImageLocation({ APPIMAGE: path }, files)).toMatchObject({
      kind: "portable",
      path,
    });
  });

  it("refuses a package or archive even when a path is named", async () => {
    const files = createNodePortableImageFiles();
    const { root } = await imageDir();
    const archive = join(root, "octant.tar");
    await writeFile(archive, Buffer.from("not an image"));

    expect(await readPortableImageLocation({ APPIMAGE: archive }, files)).toEqual({
      kind: "not-portable",
    });
  });

  it("refuses to follow a symlink to the image", async () => {
    const files = createNodePortableImageFiles();
    const { root, path } = await imageDir();
    const link = join(root, "linked.AppImage");
    await symlink(path, link);

    expect(await readPortableImageLocation({ APPIMAGE: link }, files)).toEqual({
      kind: "not-portable",
    });
  });

  it("refuses a portable image whose directory cannot be written", async () => {
    const inner = createNodePortableImageFiles();
    const { path } = await imageDir();
    const files: PortableImageFiles = {
      ...inner,
      canWrite: async () => false,
    };

    expect(await readPortableImageLocation({ APPIMAGE: path }, files)).toEqual({
      kind: "not-writable",
      path,
    });
  });
});

describe("replacing a portable image", () => {
  it("does not write when the bytes are not the signed image", async () => {
    const inner = createNodePortableImageFiles();
    let writes = 0;
    const files: PortableImageFiles = {
      ...inner,
      writeFile: async (file, bytes) => {
        writes += 1;
        await inner.writeFile(file, bytes);
      },
    };
    const { path } = await imageDir();
    const before = await files.readFile(path);
    const next = imageBytes("replacement");

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(imageBytes("someone-else")),
        files,
        relaunch: async () => undefined,
      }),
    ).toEqual({ kind: "corrupt" });
    expect(writes).toBe(0);
    expect(await files.readFile(path)).toEqual(before);
    expect(await files.lstat(join(dirname(path), ".Octant.AppImage.octant-new"))).toBeUndefined();
  });

  it("does not write a file that is not a portable image", async () => {
    const files = createNodePortableImageFiles();
    const { path } = await imageDir();
    const before = await files.readFile(path);
    const archive = Buffer.from("not-an-image");

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: archive,
        expectedSha256: digestOf(archive),
        files,
        relaunch: async () => undefined,
      }),
    ).toEqual({ kind: "corrupt" });
    expect(await files.readFile(path)).toEqual(before);
  });

  it("writes the new image beside the current one, flushes it, then renames", async () => {
    const inner = createNodePortableImageFiles();
    const traced = recording(inner);
    const { path } = await imageDir();
    const next = imageBytes("replacement");
    let relaunched = "";

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(next),
        files: traced.files,
        relaunch: async (launched) => {
          relaunched = launched;
        },
      }),
    ).toEqual({ kind: "relaunched" });

    const wrote = traced.events.indexOf("write .Octant.AppImage.octant-new");
    const flushed = traced.events.indexOf("fsync .Octant.AppImage.octant-new");
    const published = traced.events.indexOf(
      "rename .Octant.AppImage.octant-new -> Octant.AppImage",
    );
    expect(wrote).toBeGreaterThanOrEqual(0);
    expect(flushed).toBeGreaterThan(wrote);
    expect(published).toBeGreaterThan(flushed);
    expect(Buffer.from(await inner.readFile(path))).toEqual(Buffer.from(next));
    expect(relaunched).toBe(path);
    const mode = await stat(path);
    expect(mode.mode & 0o111).not.toBe(0);
    expect(await inner.lstat(join(path, "..", ".Octant.AppImage.octant-previous"))).toBeUndefined();
  });

  it("never leaves the launch path without an image while replacing or rolling back", async () => {
    // A launcher, a desktop entry, or a crash between two renames would find
    // nothing at the path. Every rename the replace makes is observed here.
    for (const relaunchFails of [false, true]) {
      const inner = createNodePortableImageFiles();
      const { path } = await imageDir();
      const gaps: string[] = [];
      const files: PortableImageFiles = {
        ...inner,
        rename: async (from, to) => {
          await inner.rename(from, to);
          if ((await inner.lstat(path)) === undefined) {
            gaps.push(`${basename(from)} -> ${basename(to)}`);
          }
        },
      };
      const next = imageBytes("replacement");

      const result = await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(next),
        files,
        relaunch: async () => {
          if (relaunchFails) throw new Error("exec failed");
        },
      });

      expect(result).toEqual({ kind: relaunchFails ? "rolled-back" : "relaunched" });
      expect(gaps).toEqual([]);
    }
  });

  it("restores the previous image when relaunch fails", async () => {
    const files = createNodePortableImageFiles();
    const { path } = await imageDir();
    const before = await files.readFile(path);
    const next = imageBytes("replacement");

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(next),
        files,
        relaunch: async () => {
          throw new Error("exec failed");
        },
      }),
    ).toEqual({ kind: "rolled-back" });
    expect(await files.readFile(path)).toEqual(before);
    expect(await files.lstat(join(dirname(path), ".Octant.AppImage.octant-new"))).toBeUndefined();
    expect(
      await files.lstat(join(dirname(path), ".Octant.AppImage.octant-previous")),
    ).toBeUndefined();
    expect(
      await files.lstat(join(dirname(path), ".Octant.AppImage.octant-failed")),
    ).toBeUndefined();
  });

  it("does not replace an image whose directory cannot be written", async () => {
    const inner = createNodePortableImageFiles();
    const { path } = await imageDir();
    const before = await inner.readFile(path);
    const next = imageBytes("replacement");
    let wrote = false;
    const files: PortableImageFiles = {
      ...inner,
      canWrite: async () => false,
      writeFile: async (file, bytes) => {
        wrote = true;
        await inner.writeFile(file, bytes);
      },
    };

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(next),
        files,
        relaunch: async () => undefined,
      }),
    ).toEqual({ kind: "not-writable" });
    expect(wrote).toBe(false);
    expect(await inner.readFile(path)).toEqual(before);
  });

  it("says when the previous image could not be restored", async () => {
    const inner = createNodePortableImageFiles();
    const { path } = await imageDir();
    const next = imageBytes("replacement");
    const files: PortableImageFiles = {
      ...inner,
      rename: async (from, to) => {
        if (basename(from).endsWith(".octant-previous") && basename(to) === "Octant.AppImage") {
          throw new Error("restore blocked");
        }
        await inner.rename(from, to);
      },
    };

    expect(
      await replacePortableImage({
        targetPath: path,
        bytes: next,
        expectedSha256: digestOf(next),
        files,
        relaunch: async () => {
          throw new Error("exec failed");
        },
      }),
    ).toEqual({ kind: "restore-failed" });
  });
});

describe("relaunching a portable image", () => {
  it("does not hand the new image the mount this process is already in", async () => {
    let seen: PortableImageSpawnOptions | undefined;
    const child: PortableImageChild = {
      once: (event, listener) => {
        if (event === "spawn") listener();
      },
      unref: () => undefined,
    };

    await relaunchPortableImage("/opt/Octant.AppImage", {
      env: { APPIMAGE: "/opt/old.AppImage", APPDIR: "/tmp/mount", PATH: "/usr/bin" },
      spawnImpl: (_path, _args, options) => {
        seen = options;
        return child;
      },
    });

    expect(seen?.env.APPIMAGE).toBeUndefined();
    expect(seen?.env.APPDIR).toBeUndefined();
    expect(seen?.env.PATH).toBe("/usr/bin");
    expect(seen?.detached).toBe(true);
  });

  it("quits only after the replaced image has been accepted", async () => {
    const { path } = await imageDir();
    const next = imageBytes("replacement");
    let quit = 0;
    const port = createPortableImagePort({
      env: { APPIMAGE: path },
      quit: () => {
        quit += 1;
      },
      relaunch: async () => {
        throw new Error("exec failed");
      },
    });

    expect(await port.replaceAndRelaunch(next, digestOf(next))).toEqual({ kind: "rolled-back" });
    expect(quit).toBe(0);

    const again = createPortableImagePort({
      env: { APPIMAGE: path },
      quit: () => {
        quit += 1;
      },
      relaunch: async () => undefined,
    });
    expect(await again.replaceAndRelaunch(next, digestOf(next))).toEqual({ kind: "relaunched" });
    expect(quit).toBe(1);
  });
});

describe("image bytes", () => {
  it("recognises a type-2 image and refuses a short or foreign file", () => {
    expect(isPortableImageBytes(imageBytes("ok"))).toBe(true);
    expect(isPortableImageBytes(Buffer.from("short"))).toBe(false);
    expect(isPortableImageBytes(Buffer.alloc(16))).toBe(false);
  });
});
