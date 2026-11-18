import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableCompileCacheBeneath, mayEnableCompileCache, resolveHostRuntimePaths } from "./paths";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-compile-cache-"));
  roots.push(root);
  return root;
}

describe("mayEnableCompileCache", () => {
  it("accepts a folder only its owner can write and refuses one others can write or own", () => {
    const folder = { isDirectory: true, ownerId: 501 };
    expect(mayEnableCompileCache({ ...folder, mode: 0o40700 }, 501)).toBe(true);
    expect(mayEnableCompileCache({ ...folder, mode: 0o40755 }, 501)).toBe(true);
    expect(mayEnableCompileCache({ ...folder, mode: 0o40775 }, 501)).toBe(false);
    expect(mayEnableCompileCache({ ...folder, mode: 0o40757 }, 501)).toBe(false);
    expect(mayEnableCompileCache({ ...folder, ownerId: 0, mode: 0o40700 }, 501)).toBe(false);
    expect(mayEnableCompileCache({ ...folder, isDirectory: false, mode: 0o100600 }, 501)).toBe(
      false,
    );
  });
});

describe.runIf(process.platform !== "win32")("enableCompileCacheBeneath", () => {
  it("creates nothing when the data folder does not exist yet", async () => {
    const root = await scratch();
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(join(root, "data"), enable)).toBe(false);
    expect(enable).not.toHaveBeenCalled();
    await expect(stat(join(root, "data"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enables the cache in a data folder others can read but not write", async () => {
    const root = await scratch();
    const data = join(root, "data");
    await mkdir(data);
    await chmod(data, 0o755);
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(data, enable)).toBe(true);
    expect(enable).toHaveBeenCalledWith(join(data, "compile-cache"));
  });

  it("skips a data folder that others can write", async () => {
    const root = await scratch();
    const data = join(root, "data");
    await mkdir(data);
    await chmod(data, 0o775);
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(data, enable)).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });

  it("refuses an existing cache folder that others can write or that is a symlink", async () => {
    const root = await scratch();
    const writable = join(root, "writable");
    await mkdir(join(writable, "compile-cache"), { recursive: true });
    await chmod(join(writable, "compile-cache"), 0o777);
    const linked = join(root, "linked");
    await mkdir(linked);
    await symlink(root, join(linked, "compile-cache"));
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(writable, enable)).toBe(false);
    expect(enableCompileCacheBeneath(linked, enable)).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "darwin")(
    "resolves a missing explicit data folder without creating it when asked not to",
    async () => {
      const root = await scratch();
      const data = join(root, "data");
      const input = {
        env: { OCTANT_DATA_DIR: data },
        platform: process.platform,
        home: root,
        temporaryDirectory: root,
        uid: process.getuid?.() ?? 0,
      } as const;
      resolveHostRuntimePaths(input, { createDataDirectory: false });
      await expect(stat(data)).rejects.toMatchObject({ code: "ENOENT" });
      resolveHostRuntimePaths(input);
      expect((await stat(data)).mode & 0o077).toBe(0);
    },
  );

  it("creates only an owner-only cache folder inside a private data folder", async () => {
    const root = await scratch();
    const data = join(root, "data");
    await mkdir(data, { mode: 0o700 });
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(data, enable)).toBe(true);
    expect(enableCompileCacheBeneath(data, enable)).toBe(true);
    expect(enable).toHaveBeenCalledWith(join(data, "compile-cache"));
    expect((await stat(join(data, "compile-cache"))).mode & 0o077).toBe(0);
  });
});
