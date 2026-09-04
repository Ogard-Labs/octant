import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeGitRepository } from "./initializeGitRepository";

const execFileAsync = promisify(nodeExecFile);

describe("initializeGitRepository", () => {
  it("initializes a non-repository folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-git-init-"));
    try {
      await writeFile(join(root, "README.md"), "hello\n");
      await expect(initializeGitRepository(root)).resolves.toEqual({ status: "initialized" });
      const toplevel = await execFileAsync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      });
      // macOS resolves `tmpdir()` through a symlink, so Git reports the physical
      // path while `mkdtemp` returns the logical one. Compare canonical paths.
      expect(await realpath(toplevel.stdout.trim())).toBe(await realpath(root));
      const branch = await execFileAsync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      });
      expect(branch.stdout.trim()).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("no-ops when the folder is already a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-git-init-existing-"));
    try {
      await execFileAsync("git", ["-C", root, "init", "-b", "development"], { encoding: "utf8" });
      await expect(initializeGitRepository(root)).resolves.toEqual({
        status: "already-repository",
      });
      const branch = await execFileAsync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], {
        encoding: "utf8",
      });
      expect(branch.stdout.trim()).toBe("development");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports failure for a missing path", async () => {
    await expect(initializeGitRepository(join(tmpdir(), "octant-missing-root"))).resolves.toEqual({
      status: "failed",
      message: "Project root is unavailable.",
    });
  });
});
