import { describe, expect, it } from "vitest";
import { getDefaultToken } from "@octant/theme/tokens";
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
    expect(lightColors.primary).toBe(getDefaultToken("accent", "light"));
    expect(darkColors.primary).toBe(getDefaultToken("accent", "dark"));
    expect(colorsForScheme("dark").canvas).toBe(darkColors.canvas);
    expect(colorsForScheme("light").canvas).toBe(lightColors.canvas);
    expect(darkColors.textPrimary).toBe(darkColors.primary);
  });

  it("projects shared semantic status colors from the product theme", () => {
    expect(lightColors.warning).toBe(getDefaultToken("warning-text", "light"));
    expect(darkColors.warning).toBe(getDefaultToken("warning-text", "dark"));
    expect(lightColors.danger).toBe(getDefaultToken("danger-text", "light"));
    expect(darkColors.success).toBe(getDefaultToken("success-text", "dark"));
  });
});
