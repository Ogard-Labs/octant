import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRememberedThemeMode, rememberThemeMode } from "./firstPaintTheme";

function systemPrefersDark(dark: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("dark") ? dark : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

describe("first paint theme", () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.octantThemeMode;
    document.documentElement.style.removeProperty("color-scheme");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("paints the last chosen light mode before the first render", () => {
    rememberThemeMode("light");
    applyRememberedThemeMode();
    expect(document.documentElement.dataset.octantThemeMode).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("follows the system appearance when the last window followed it", () => {
    rememberThemeMode("system");
    systemPrefersDark(false);
    applyRememberedThemeMode();
    expect(document.documentElement.dataset.octantThemeMode).toBe("light");
  });

  it("leaves the stylesheet's own default when nothing was remembered", () => {
    applyRememberedThemeMode();
    expect(document.documentElement.dataset.octantThemeMode).toBeUndefined();
  });

  it("ignores a stored value that is not a theme mode", () => {
    localStorage.setItem("octant.theme-mode", "sepia");
    applyRememberedThemeMode();
    expect(document.documentElement.dataset.octantThemeMode).toBeUndefined();
  });
});
