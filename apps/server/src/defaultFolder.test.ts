import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultFolderProjectRoot,
  effectiveDefaultFolder,
  hostDefaultFolder,
  judgeDefaultFolder,
} from "./defaultFolder";

const home = "/Users/ada";

describe("the default folder", () => {
  it("falls back to Octant at the top of the home folder until someone names one", () => {
    expect(hostDefaultFolder(home)).toBe("/Users/ada/Octant");
    expect(effectiveDefaultFolder({}, home)).toBe("/Users/ada/Octant");
    expect(effectiveDefaultFolder({ defaultFolder: "/Users/ada/Work" as never }, home)).toBe(
      "/Users/ada/Work",
    );
  });

  it("keeps a stored folder under Documents where it is", () => {
    expect(
      effectiveDefaultFolder({ defaultFolder: "/Users/ada/Documents/Octant" as never }, home),
    ).toBe("/Users/ada/Documents/Octant");
  });

  it("gives each mode its own subfolder", () => {
    expect(defaultFolderProjectRoot("/Users/ada/Documents/Octant", "work")).toBe(
      "/Users/ada/Documents/Octant/Work",
    );
    expect(defaultFolderProjectRoot("/Users/ada/Documents/Octant", "code")).toBe(
      "/Users/ada/Documents/Octant/Code",
    );
  });

  it("accepts a folder inside home and normalizes it", () => {
    expect(judgeDefaultFolder("/Users/ada/Octant/./tasks/" as never, home)).toEqual({
      status: "accepted",
      folder: "/Users/ada/Octant/tasks",
    });
  });

  it("refuses home itself, anything outside it, and a path that escapes through ..", () => {
    for (const candidate of ["/Users/ada", "/tmp/octant", "/Users/ada/../grace/Octant", "/"]) {
      expect(judgeDefaultFolder(candidate as never, home)).toMatchObject({ status: "refused" });
    }
  });
});

const temporaryFolders: Array<string> = [];
afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function realHomeFolder() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "octant-default-folder-")));
  temporaryFolders.push(base);
  const realHome = join(base, "ada");
  mkdirSync(join(realHome, "Octant"), { recursive: true });
  return { base, realHome };
}

describe("a default folder named through a link", () => {
  // The mirror holds `<default folder>/Artifacts` to the exact path it was
  // given, so a default folder stored as typed through a link left the host's
  // default Artifacts folder refused on every write.
  it("is stored by its real path", () => {
    const { realHome } = realHomeFolder();
    symlinkSync(join(realHome, "Octant"), join(realHome, "Shortcut"));

    expect(judgeDefaultFolder(join(realHome, "Shortcut") as never, realHome)).toEqual({
      status: "accepted",
      folder: join(realHome, "Octant"),
    });
  });

  it("is accepted under a home folder that is itself a link", () => {
    const { base, realHome } = realHomeFolder();
    const linkedHome = join(base, "home-ada");
    symlinkSync(realHome, linkedHome);

    expect(judgeDefaultFolder(join(realHome, "Octant") as never, linkedHome)).toEqual({
      status: "accepted",
      folder: join(realHome, "Octant"),
    });
    expect(judgeDefaultFolder(join(linkedHome, "Octant") as never, linkedHome)).toEqual({
      status: "accepted",
      folder: join(realHome, "Octant"),
    });
  });
});
