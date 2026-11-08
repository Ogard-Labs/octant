import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveGeneratedImageUnder } from "./generatedImageSave";

const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

describe("saving a generated image under a folder", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "octant-image-save-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the file, and the folders on its path, inside the folder", async () => {
    const saved = await saveGeneratedImageUnder({ root, relativePath: "art/cube.png", bytes });
    expect(saved).toEqual({ status: "saved", relativePath: "art/cube.png" });
    expect(Uint8Array.from(readFileSync(join(root, "art", "cube.png")))).toEqual(bytes);
  });

  it("refuses a path that leaves the folder", async () => {
    const saved = await saveGeneratedImageUnder({ root, relativePath: "../escape.png", bytes });
    expect(saved.status).not.toBe("saved");
  });

  it("never overwrites a file that is already there", async () => {
    writeFileSync(join(root, "cube.png"), "keep");
    const saved = await saveGeneratedImageUnder({ root, relativePath: "cube.png", bytes });
    expect(saved.status).not.toBe("saved");
    expect(readFileSync(join(root, "cube.png"), "utf8")).toBe("keep");
  });
});
