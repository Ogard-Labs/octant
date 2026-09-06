import { describe, expect, it } from "vitest";
import { contrastRatio, oklchToHex, parseHexColor, relativeLuminance } from "./color";

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

describe("oklch to hex", () => {
  it("turns lightness with no chroma into a neutral grey and full lightness into white", () => {
    expect(oklchToHex({ l: 1, c: 0, h: 0 })).toBe("#ffffff");
    expect(oklchToHex({ l: 0, c: 0, h: 0 })).toBe("#000000");
    const grey = parseHexColor(oklchToHex({ l: 0.6, c: 0, h: 200 }));
    expect(Math.abs(grey.r - grey.g)).toBeLessThanOrEqual(1);
    expect(Math.abs(grey.g - grey.b)).toBeLessThanOrEqual(1);
  });

  it("keeps a colour the screen cannot show at its lightness by giving up chroma, not clipping", () => {
    // A vivid light blue is outside sRGB; the result must stay a valid hex
    // at about the same luminance rather than a clipped, darker blue.
    const hex = oklchToHex({ l: 0.85, c: 0.3, h: 260 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(relativeLuminance(parseHexColor(hex))).toBeGreaterThan(0.55);
  });
});
