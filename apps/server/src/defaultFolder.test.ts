import { describe, expect, it } from "vitest";
import {
  defaultFolderProjectRoot,
  effectiveDefaultFolder,
  hostDefaultFolder,
  judgeDefaultFolder,
} from "./defaultFolder";

const home = "/Users/ada";

describe("the default folder", () => {
  it("falls back to Documents/Octant in the home folder until someone names one", () => {
    expect(hostDefaultFolder(home)).toBe("/Users/ada/Documents/Octant");
    expect(effectiveDefaultFolder({}, home)).toBe("/Users/ada/Documents/Octant");
    expect(effectiveDefaultFolder({ defaultFolder: "/Users/ada/Work" as never }, home)).toBe(
      "/Users/ada/Work",
    );
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
