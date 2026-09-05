import { describe, expect, it } from "vitest";
import { compareWorkPathNames } from "./workPathConfinement";

describe("compareWorkPathNames", () => {
  it("puts names in one order regardless of case", () => {
    const names = ["beta", "Alpha", "gamma"];
    expect([...names].sort(compareWorkPathNames)).toEqual(["Alpha", "beta", "gamma"]);
  });

  it("orders two spellings of one name rather than leaving them to the filesystem", () => {
    // Base sensitivity calls these equal, which left the pair in whatever order
    // the directory happened to enumerate — the one thing this comparator
    // exists to remove.
    expect(compareWorkPathNames("A", "a")).not.toBe(0);
    expect(compareWorkPathNames("a", "A")).toBe(-compareWorkPathNames("A", "a"));
    expect(["a", "A", "a"].sort(compareWorkPathNames)).toEqual(["A", "a", "a"]);
  });

  it("still reports an identical name as equal", () => {
    expect(compareWorkPathNames("notes", "notes")).toBe(0);
  });
});
