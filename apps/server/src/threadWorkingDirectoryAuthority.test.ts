import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeThreadWorkingDirectory } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { resolveThreadWorkingDirectory } from "./threadWorkingDirectoryAuthority";

describe("thread working-directory authority", () => {
  it("resolves the root and one existing nested directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-cwd-"));
    await mkdir(join(root, "packages", "app"), { recursive: true });

    await expect(
      resolveThreadWorkingDirectory(root, decodeThreadWorkingDirectory(".")),
    ).resolves.toBe(await realpath(root));
    await expect(
      resolveThreadWorkingDirectory(root, decodeThreadWorkingDirectory("packages/app")),
    ).resolves.toBe(await realpath(join(root, "packages", "app")));
  });

  it("rejects missing directories and symlink escapes", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-cwd-"));
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "escape"), "dir");

    await expect(
      resolveThreadWorkingDirectory(root, decodeThreadWorkingDirectory("missing")),
    ).rejects.toThrow("unavailable");
    await expect(
      resolveThreadWorkingDirectory(root, decodeThreadWorkingDirectory("escape")),
    ).rejects.toThrow("escapes");
  });
});
