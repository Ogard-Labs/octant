import { describe, expect, it } from "vitest";
import { splitPathLabel } from "./pathLabel";

describe("file path labels", () => {
  it("splits a nested path into its directory and its name", () => {
    expect(splitPathLabel("packages/theme/src/color.ts")).toEqual({
      directory: "packages/theme/src/",
      name: "color.ts",
    });
  });

  it("splits a Windows path on its backslash separator", () => {
    expect(splitPathLabel("src\\main\\index.ts")).toEqual({
      directory: "src\\main\\",
      name: "index.ts",
    });
  });

  it("treats a bare file name as a name with no directory", () => {
    expect(splitPathLabel("README.md")).toEqual({ directory: undefined, name: "README.md" });
  });

  it("does not treat a leading separator as a directory to dim", () => {
    expect(splitPathLabel("/etc/hosts")).toEqual({ directory: "/etc/", name: "hosts" });
  });

  it("keeps a label that ends in a separator whole rather than dimming it all", () => {
    expect(splitPathLabel("src/utils/")).toEqual({ directory: undefined, name: "src/utils/" });
  });

  it("keeps an empty label unchanged", () => {
    expect(splitPathLabel("")).toEqual({ directory: undefined, name: "" });
  });
});
