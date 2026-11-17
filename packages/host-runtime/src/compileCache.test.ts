import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enableCompileCacheBeneath, mayEnableCompileCache } from "./paths";

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
  it("refuses a folder other users can reach or that another user owns", () => {
    expect(mayEnableCompileCache({ isDirectory: true, ownerId: 501, mode: 0o40700 }, 501)).toBe(
      true,
    );
    expect(mayEnableCompileCache({ isDirectory: true, ownerId: 501, mode: 0o40755 }, 501)).toBe(
      false,
    );
    expect(mayEnableCompileCache({ isDirectory: true, ownerId: 0, mode: 0o40700 }, 501)).toBe(
      false,
    );
    expect(mayEnableCompileCache({ isDirectory: false, ownerId: 501, mode: 0o100600 }, 501)).toBe(
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

  it("skips a data folder that other users can read", async () => {
    const root = await scratch();
    const data = join(root, "data");
    await mkdir(data, { mode: 0o755 });
    const enable = vi.fn();
    expect(enableCompileCacheBeneath(data, enable)).toBe(false);
    expect(enable).not.toHaveBeenCalled();
  });

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
