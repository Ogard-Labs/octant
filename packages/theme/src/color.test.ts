import { describe, expect, it } from "vitest";
import { contrastRatio, parseHexColor, relativeLuminance } from "./color";

describe("theme color primitives", () => {
  it("parses six-digit hex colors into rgb channels", () => {
    expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseHexColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#8B5CF6")).toEqual({ r: 139, g: 92, b: 246 });
  });

  it.each(["#fff", "#GGGGGG", "white", "", "#0000003", "#0000000", "rgb(0,0,0)"])(
    "rejects invalid hex color %s",
    (value) => {
      expect(() => parseHexColor(value)).toThrow();
    },
  );

  it("computes relative luminance per WCAG", () => {
    expect(relativeLuminance(parseHexColor("#000000"))).toBe(0);
    expect(relativeLuminance(parseHexColor("#ffffff"))).toBeCloseTo(1, 5);
  });

  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
    expect(contrastRatio("#000000", "#000000")).toBeCloseTo(1, 5);
  });
});
