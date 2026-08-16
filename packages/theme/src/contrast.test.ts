import { describe, expect, it } from "vitest";
import { MINIMUM_CONTRAST, meetsContrast } from "./contrast";

describe("theme contrast validation", () => {
  it("publishes WCAG minimum contrast thresholds", () => {
    expect(MINIMUM_CONTRAST["normal-text"]).toBe(4.5);
    expect(MINIMUM_CONTRAST["large-text"]).toBe(3);
    expect(MINIMUM_CONTRAST["ui"]).toBe(3);
  });

  it("passes black-on-white at normal-text contrast", () => {
    expect(meetsContrast("#000000", "#ffffff", "normal-text")).toBe(true);
  });

  it("fails low-contrast pairs at normal-text level", () => {
    expect(meetsContrast("#1a1a1c", "#0d0d0f", "normal-text")).toBe(false);
  });

  it("passes ui-level contrast for borders and controls", () => {
    expect(meetsContrast("#d8d8d4", "#0d0d0f", "ui")).toBe(true);
  });
});
