import { describe, expect, it } from "vitest";
import { sameHostPath } from "./hostPaths";

describe("host path comparison", () => {
  it("treats Windows paths as the same whatever their drive-letter case and slashes", () => {
    expect(sameHostPath("c:/Users/Me/wt", "C:\\Users\\me\\wt\\", "win32")).toBe(true);
    expect(sameHostPath("C:\\Users\\me\\wt", "C:\\Users\\me\\other", "win32")).toBe(false);
  });

  it("keeps letter case meaningful on other hosts", () => {
    expect(sameHostPath("/Users/Me/wt", "/Users/me/wt", "linux")).toBe(false);
    expect(sameHostPath("/Users/me/wt/", "/Users/me/wt", "linux")).toBe(true);
  });
});
