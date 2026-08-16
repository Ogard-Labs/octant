import { describe, expect, it } from "vitest";
import {
  createAppearanceStore,
  DEFAULT_APPEARANCE,
  parseAppearancePreferences,
} from "./AppearanceStore";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    async getItem(key: string) {
      return map.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      map.set(key, value);
    },
    async deleteItem(key: string) {
      map.delete(key);
    },
  };
}

describe("AppearanceStore", () => {
  it("defaults to atmosphere canvas, system theme, and glass surfaces", () => {
    expect(parseAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreferences("{")).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.colorSchemePreference).toBe("system");
    expect(DEFAULT_APPEARANCE.surfaceStyle).toBe("glass");
  });

  it("parses legacy prefs without theme/surface as system + glass", () => {
    expect(parseAppearancePreferences(JSON.stringify({ backgroundMode: "code-gradient" }))).toEqual(
      {
        backgroundMode: "code-gradient",
        colorSchemePreference: "system",
        surfaceStyle: "glass",
      },
    );
  });

  it("persists surface style independently of wallpaper and theme", async () => {
    const store = createAppearanceStore(memoryStorage());
    const flat = await store.setSurfaceStyle("flat");
    expect(flat.surfaceStyle).toBe("flat");
    expect(flat.colorSchemePreference).toBe("system");

    const dark = await store.setColorSchemePreference("dark");
    expect(dark.surfaceStyle).toBe("flat");
    expect(dark.colorSchemePreference).toBe("dark");

    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.surfaceStyle).toBe("flat");
    expect(withImage.backgroundMode).toBe("custom");

    const cleared = await store.clearCustomImage();
    expect(cleared.surfaceStyle).toBe("flat");
    expect(cleared.backgroundMode).toBe("code-gradient");
  });

  it("persists theme preference independently of wallpaper", async () => {
    const store = createAppearanceStore(memoryStorage());
    const dark = await store.setColorSchemePreference("dark");
    expect(dark.colorSchemePreference).toBe("dark");
    expect(dark.backgroundMode).toBe("code-gradient");

    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.colorSchemePreference).toBe("dark");
    expect(withImage.backgroundMode).toBe("custom");

    const cleared = await store.clearCustomImage();
    expect(cleared.colorSchemePreference).toBe("dark");
    expect(cleared.backgroundMode).toBe("code-gradient");
    expect(await store.load()).toEqual(cleared);
  });

  it("persists and clears a custom background image", async () => {
    const store = createAppearanceStore(memoryStorage());
    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.backgroundMode).toBe("custom");
    expect(withImage.customImageUri).toBe("data:image/png;base64,abc");
    expect(await store.load()).toEqual(withImage);

    const cleared = await store.clearCustomImage();
    expect(cleared).toEqual({
      backgroundMode: "code-gradient",
      colorSchemePreference: "system",
      surfaceStyle: "glass",
    });
    expect(await store.load()).toEqual(cleared);
  });
});
