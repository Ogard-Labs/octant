import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyOctantSideFiles, removeCopiedFiles } from "./octantImportFiles";

// Writes go through this mock so a copy can fail part way, after its file
// was created and some bytes landed, as a full disk does.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

const directories: Array<string> = [];

afterEach(() => {
  vi.mocked(fs.writeSync).mockReset();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("copying Octant's side files", () => {
  it("takes back a file whose copy failed part way", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const base = mkdtempSync(join(tmpdir(), "octant-import-files-"));
    directories.push(base);
    const octant = join(base, "Octant");
    const nightly = join(base, "Octant Nightly");
    const thread = "0c7a0000-0000-4000-8000-000000000b01";
    const folder = join(octant, "work-threads", thread);
    mkdirSync(folder, { recursive: true });
    mkdirSync(nightly);
    // Larger than one copy chunk, so the copy writes twice.
    writeFileSync(join(folder, "large.bin"), Buffer.alloc(3 << 20, 1));
    let writes = 0;
    vi.mocked(fs.writeSync).mockImplementation(((...args: Parameters<typeof actual.writeSync>) => {
      writes += 1;
      if (writes === 2) throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      return actual.writeSync(...args);
    }) as typeof fs.writeSync);

    expect(() =>
      copyOctantSideFiles({
        octantDirectory: octant,
        nightlyDirectory: nightly,
        importId: "import-1",
        threads: new Set([thread]),
        aggregates: new Set(),
        imageArtifacts: new Set(),
      }),
    ).toThrow("no space left");
    removeCopiedFiles(nightly, "import-1");

    expect(writes).toBe(2);
    expect(existsSync(join(nightly, "work-threads", thread, "large.bin"))).toBe(false);
    expect(existsSync(join(nightly, "work-threads"))).toBe(false);
  });
});
