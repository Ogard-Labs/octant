import { describe, expect, it } from "vitest";
import { chooseNpmVersion, compareNpmVersions } from "./npmVersionRange";

const published = ["0.9.0", "1.0.0", "1.2.3", "1.9.0", "2.0.0", "2.1.0-beta.1", "3.0.0"];
const distTags = { latest: "3.0.0", next: "2.1.0-beta.1" };
const choose = (requested?: string) => chooseNpmVersion({ requested, published, distTags });

describe("choosing an npm version from what a person typed", () => {
  it.each([
    [undefined, "3.0.0"],
    ["", "3.0.0"],
    ["1.2.3", "1.2.3"],
    ["next", "2.1.0-beta.1"],
    ["^1.0.0", "1.9.0"],
    ["^0.9.0", "0.9.0"],
    ["~1.2.0", "1.2.3"],
    ["1", "1.9.0"],
    ["1.x", "1.9.0"],
    [">=1.2.0 <2", "1.9.0"],
    [">1.2.3", "3.0.0"],
    ["<1", "0.9.0"],
    ["1.0.0 - 1.2.3", "1.2.3"],
    ["^0.9.0 || ^2.0.0", "2.0.0"],
    ["*", "3.0.0"],
  ])("reads %j as %s", (requested, expected) => {
    expect(choose(requested)).toEqual({ status: "chosen", version: expected });
  });

  it("does not pick a prerelease for a range that does not name one", () => {
    expect(choose("^2.0.0")).toEqual({ status: "chosen", version: "2.0.0" });
    expect(choose("2.1.0-beta.1")).toEqual({ status: "chosen", version: "2.1.0-beta.1" });
  });

  it("reports an unpublished version, an unknown tag, and a range it cannot read", () => {
    expect(choose("4.0.0")).toEqual({ status: "none-published" });
    expect(choose("^4.0.0")).toEqual({ status: "none-published" });
    expect(choose("nightly")).toEqual({ status: "none-published" });
    expect(choose("^^1")).toEqual({ status: "range-unreadable" });
    expect(choose("1.2.3+build")).toEqual({ status: "range-unreadable" });
  });

  it("orders versions as semantic versioning does", () => {
    expect(compareNpmVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareNpmVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareNpmVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBeLessThan(0);
    expect(compareNpmVersions("1.0.0", "1.0.0")).toBe(0);
  });
});
