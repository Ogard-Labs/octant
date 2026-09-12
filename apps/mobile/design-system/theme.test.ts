import { describe, expect, it } from "vitest";
import { resolveThemeScheme } from "./resolveThemeScheme";
import { colorsForScheme, darkColors, lightColors } from "./tokens";

describe("mobile theme resolution", () => {
  it("resolves system preference from device scheme", () => {
    expect(resolveThemeScheme("system", "dark")).toBe("dark");
    expect(resolveThemeScheme("system", "light")).toBe("light");
    expect(resolveThemeScheme("system", null)).toBe("light");
    expect(resolveThemeScheme("light", "dark")).toBe("light");
    expect(resolveThemeScheme("dark", "light")).toBe("dark");
  });

  it("keeps the desktop-aligned neutral palette across schemes", () => {
    expect(lightColors.primary).toBe("#1B1B1B");
    expect(darkColors.primary).toBe("#F0F0F0");
    expect(colorsForScheme("dark").canvas).toBe(darkColors.canvas);
    expect(colorsForScheme("light").canvas).toBe(lightColors.canvas);
    expect(darkColors.textPrimary).toBe(darkColors.primary);
  });
});
