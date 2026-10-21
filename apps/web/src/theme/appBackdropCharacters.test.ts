import { describe, expect, it } from "vitest";
import { createRipple, rippleBrightness } from "./appBackdropCharacters";

describe("character ground click wave", () => {
  const circle = { x: 100, y: 100, start: 0, seed: 0, wobble: 0, heart: false };

  it("lights the ring's edge as it spreads and leaves its centre dark", () => {
    // Half a second in, the ring has travelled 160px.
    expect(rippleBrightness(circle, 260, 100, 0.5)).toBeGreaterThan(0.6);
    expect(rippleBrightness(circle, 100, 100, 0.5)).toBe(0);
  });

  it("is gone once it and its echo have faded, and does nothing before the click", () => {
    expect(rippleBrightness(circle, 100 + 320 * 2, 100, 2)).toBe(0);
    expect(rippleBrightness({ ...circle, start: 1 }, 100, 100, 0.5)).toBe(0);
  });

  it("draws a heart with its point below the click and its cleft above", () => {
    const heart = { ...circle, heart: true };
    // At 0.5s a plain ring sits 160px out; a heart reaches further down and
    // barely leaves the click upward.
    expect(rippleBrightness(heart, 100, 100 + 160 * 1.82, 0.5)).toBeGreaterThan(0.6);
    expect(rippleBrightness(heart, 100, 100 - 160, 0.5)).toBe(0);
  });

  it("varies every click and sometimes makes a heart", () => {
    const rolls = [0.1, 0.5, 0.05];
    const ripple = createRipple(0, 0, 0, () => rolls.shift() ?? 0);
    expect(ripple.wobble).toBeGreaterThan(0);
    expect(ripple.heart).toBe(true);
  });
});
