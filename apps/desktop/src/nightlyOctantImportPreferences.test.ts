import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPIED_WINDOW_PREFERENCES,
  copyOctantWindowPreferences,
  isCopiedWindowPreference,
  selectWindowPreferences,
} from "./nightlyOctantImportPreferences";

let octant: string;
let scratchDirectory: string;

beforeEach(async () => {
  octant = await realpath(await mkdtemp(join(tmpdir(), "octant-prefs-")));
  scratchDirectory = join(octant, "..", `scratch-${String(Date.now())}`);
  await mkdir(join(octant, "Local Storage", "leveldb"), { recursive: true });
  await writeFile(join(octant, "Local Storage", "leveldb", "000003.log"), "x");
  await writeFile(join(octant, "Local Storage", "leveldb", "LOCK"), "");
});

afterEach(async () => {
  await rm(scratchDirectory, { recursive: true, force: true });
  await rm(octant, { recursive: true, force: true });
});

describe("copying Octant's window preferences", () => {
  it("keeps only the allowlisted keys, never drafts, cursors or caches", () => {
    expect(
      selectWindowPreferences({
        "octant.keybindings.v1": "{}",
        "octant.models.favorites.v1": "[]",
        "octant.sidebar.activity-view.v1.code": "list",
        "octant.composer.thread-drafts.v1": "secret draft",
        "octant.chat.readCursors.v1": "{}",
        "octant.homeList.cache": "{}",
        "octant.models.recent.v1": 5,
        unrelated: "x",
      }),
    ).toEqual([
      ["octant.keybindings.v1", "{}"],
      ["octant.models.favorites.v1", "[]"],
      ["octant.sidebar.activity-view.v1.code", "list"],
    ]);
    expect(isCopiedWindowPreference("octant.browser.profile.x")).toBe(false);
    expect(COPIED_WINDOW_PREFERENCES.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it("reads a scratch copy of Octant's storage, writes the allowlisted keys, and removes the copy", async () => {
    const seen: string[] = [];
    const writeStorage = vi.fn(
      async (entries: ReadonlyArray<readonly [string, string]>) => entries.length,
    );
    const outcome = await copyOctantWindowPreferences({
      octantDataDirectory: octant,
      scratchDirectory,
      overwrite: true,
      rendererOrigin: () => "file://",
      storageReadable: () => true,
      readStorage: async (copy) => {
        seen.push(copy);
        expect(await readdir(join(copy, "Local Storage", "leveldb"))).toEqual(["000003.log"]);
        return { "octant.keybindings.v1": "{}", "octant.chat.readCursors.v1": "{}" };
      },
      writeStorage,
    });
    expect(outcome).toEqual({ status: "copied", copied: 1 });
    expect(writeStorage).toHaveBeenCalledWith([["octant.keybindings.v1", "{}"]], true);
    expect(seen[0]).toBe(scratchDirectory);
    await expect(readdir(scratchDirectory)).rejects.toThrow();
    // Octant's folder is untouched.
    expect(await readdir(join(octant, "Local Storage", "leveldb"))).toEqual(["000003.log", "LOCK"]);
  });

  it("reuses one fixed scratch folder for every import and clears leftovers first", async () => {
    await mkdir(scratchDirectory, { recursive: true });
    await writeFile(join(scratchDirectory, "left-over"), "x");
    const seen: string[][] = [];
    for (let run = 0; run < 2; run += 1) {
      await copyOctantWindowPreferences({
        octantDataDirectory: octant,
        scratchDirectory,
        overwrite: false,
        rendererOrigin: () => "file://",
        storageReadable: () => true,
        readStorage: async (copy) => {
          seen.push((await readdir(copy)).sort());
          return {};
        },
        writeStorage: async () => 0,
      });
    }
    expect(seen).toEqual([
      ["Local Storage", "blank.html"],
      ["Local Storage", "blank.html"],
    ]);
  });

  it("reports a different renderer origin instead of writing into the wrong storage", async () => {
    const writeStorage = vi.fn(async () => 0);
    await expect(
      copyOctantWindowPreferences({
        octantDataDirectory: octant,
        scratchDirectory,
        overwrite: true,
        rendererOrigin: () => undefined,
        storageReadable: () => true,
        readStorage: async () => ({}),
        writeStorage,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "origin-differs" });
    expect(writeStorage).not.toHaveBeenCalled();
  });

  it("asks for a relaunch instead of reading Octant's storage a second time in one process", async () => {
    const readStorage = vi.fn(async () => ({}));
    await expect(
      copyOctantWindowPreferences({
        octantDataDirectory: octant,
        scratchDirectory,
        overwrite: false,
        rendererOrigin: () => "file://",
        storageReadable: () => false,
        readStorage,
        writeStorage: async () => 0,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "relaunch-needed" });
    expect(readStorage).not.toHaveBeenCalled();
  });

  it("reports missing storage and failures without throwing", async () => {
    const missing = await mkdtemp(join(tmpdir(), "octant-prefs-empty-"));
    try {
      await expect(
        copyOctantWindowPreferences({
          octantDataDirectory: missing,
          scratchDirectory,
          overwrite: true,
          rendererOrigin: () => "file://",
          storageReadable: () => true,
          readStorage: async () => ({}),
          writeStorage: async () => 0,
        }),
      ).resolves.toEqual({ status: "unavailable", reason: "octant-storage-missing" });
    } finally {
      await rm(missing, { recursive: true, force: true });
    }
    await expect(
      copyOctantWindowPreferences({
        octantDataDirectory: octant,
        scratchDirectory,
        overwrite: true,
        rendererOrigin: () => "file://",
        storageReadable: () => true,
        readStorage: async () => {
          throw new Error("no page");
        },
        writeStorage: async () => 0,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "failed" });
  });
});
