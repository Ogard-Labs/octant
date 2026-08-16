import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareStore, resolveDataDirectory } from "./storePath";

describe("resolveDataDirectory", () => {
  it("uses the Octant Application Support directory on macOS", () => {
    expect(resolveDataDirectory({ env: {}, platform: "darwin", home: "/Users/test" })).toBe(
      "/Users/test/Library/Application Support/Octant",
    );
  });

  it("uses the safe XDG data default on Linux", () => {
    expect(resolveDataDirectory({ env: {}, platform: "linux", home: "/home/test" })).toBe(
      "/home/test/.local/share/octant",
    );
  });

  it("uses the explicit data directory on other platforms", () => {
    expect(
      resolveDataDirectory({
        env: { OCTANT_DATA_DIR: "/tmp/octant" },
        platform: "linux",
        home: "/home/test",
      }),
    ).toBe("/tmp/octant");
  });

  it.each(["", " ", "relative/path", ".", "~/octant", " /tmp/octant", "/tmp/octant "])(
    "rejects a non-absolute or non-canonical explicit directory: %j",
    (directory) => {
      expect(() =>
        resolveDataDirectory({
          env: { OCTANT_DATA_DIR: directory },
          platform: "darwin",
          home: "/Users/test",
        }),
      ).toThrow("OCTANT_DATA_DIR must be an absolute path");
    },
  );
});

describe("prepareStore", () => {
  it("creates an owner-only directory and returns the Octant database path", async () => {
    const temporaryRoot = await mkdtemp(join(await realpath(tmpdir()), "octant-store-path-"));
    const directory = normalize(join(temporaryRoot, "existing"));

    try {
      await prepareStore({
        env: { OCTANT_DATA_DIR: directory },
        platform: process.platform === "darwin" ? "darwin" : "linux",
        home: temporaryRoot,
      });
      const prepared = await prepareStore({
        env: { OCTANT_DATA_DIR: directory },
        platform: process.platform === "darwin" ? "darwin" : "linux",
        home: temporaryRoot,
      });

      expect(prepared).toEqual({
        directory,
        databasePath: join(directory, "octant.sqlite3"),
      });
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects an existing data directory with unsafe permissions", async () => {
    const temporaryRoot = await mkdtemp(join(await realpath(tmpdir()), "octant-store-mode-"));
    const directory = normalize(join(temporaryRoot, "existing"));
    try {
      await prepareStore({
        env: { OCTANT_DATA_DIR: directory },
        platform: process.platform === "darwin" ? "darwin" : "linux",
        home: temporaryRoot,
      });
      await chmod(directory, 0o755);
      await expect(
        prepareStore({
          env: { OCTANT_DATA_DIR: directory },
          platform: process.platform === "darwin" ? "darwin" : "linux",
          home: temporaryRoot,
        }),
      ).rejects.toMatchObject({ code: "unsafe-mode" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("validates an explicit directory before creating or changing it", async () => {
    const relativeDirectory = `octant-invalid-store-${randomUUID()}`;
    expect(existsSync(relativeDirectory)).toBe(false);

    try {
      await expect(
        prepareStore({
          env: { OCTANT_DATA_DIR: relativeDirectory },
          platform: "darwin",
          home: "/Users/test",
        }),
      ).rejects.toThrow("OCTANT_DATA_DIR must be an absolute path");
      expect(existsSync(relativeDirectory)).toBe(false);
    } finally {
      await rm(relativeDirectory, { recursive: true, force: true });
    }
  });
});
