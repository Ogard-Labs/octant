import { describe, expect, it } from "vitest";
import { mix, withAlpha } from "./tone";

describe("palette tone arithmetic", () => {
  it("tints a theme hue at the requested opacity", () => {
    expect(withAlpha("#1e5fae", 0.18)).toBe("rgba(30, 95, 174, 0.18)");
  });

  it("mixes a hue into its foreground like the desktop's colour mix", () => {
    expect(mix("#1e5fae", "#ffffff", 0.72)).toBe("#5d8cc5");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("leaves a value it cannot read as it was instead of guessing", () => {
    expect(withAlpha("rgba(0,0,0,0.5)", 0.2)).toBe("rgba(0,0,0,0.5)");
    expect(mix("transparent", "#ffffff", 0.5)).toBe("transparent");
  });
});
