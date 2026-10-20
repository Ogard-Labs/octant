import { describe, expect, it } from "vitest";
import { rippleBrightness } from "./appBackdropCharacters";

describe("character ground click ring", () => {
  const click = { x: 100, y: 100, start: 0 };

  it("lights the ring's edge as it spreads and leaves its centre dark", () => {
    // Half a second in, the ring has travelled 160px.
    expect(rippleBrightness(click, 260, 100, 0.5)).toBeGreaterThan(0.6);
    expect(rippleBrightness(click, 100, 100, 0.5)).toBe(0);
  });

  it("is gone once it has faded, and does nothing before the click", () => {
    expect(rippleBrightness(click, 100 + 320 * 2, 100, 2)).toBe(0);
    expect(rippleBrightness({ ...click, start: 1 }, 100, 100, 0.5)).toBe(0);
  });
});
