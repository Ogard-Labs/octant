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
  it("defaults to the Octant canvas, system theme, and flat surfaces", () => {
    expect(parseAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreferences("{")).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.colorSchemePreference).toBe("system");
    expect(DEFAULT_APPEARANCE.surfaceStyle).toBe("flat");
  });

  it("parses legacy prefs without theme/surface as system + flat", () => {
    expect(parseAppearancePreferences(JSON.stringify({ backgroundMode: "code-gradient" }))).toEqual(
      {
        backgroundMode: "code-gradient",
        colorSchemePreference: "system",
        surfaceStyle: "flat",
      },
    );
  });

  it("persists surface style independently of wallpaper and theme", async () => {
    const store = createAppearanceStore(memoryStorage());
    const glass = await store.setSurfaceStyle("glass");
    expect(glass.surfaceStyle).toBe("glass");
    expect(glass.colorSchemePreference).toBe("system");

    const dark = await store.setColorSchemePreference("dark");
    expect(dark.surfaceStyle).toBe("glass");
    expect(dark.colorSchemePreference).toBe("dark");

    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.surfaceStyle).toBe("glass");
    expect(withImage.backgroundMode).toBe("custom");

    const cleared = await store.clearCustomImage();
    expect(cleared.surfaceStyle).toBe("glass");
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

  it("keeps the last requested background mode when writes overlap", async () => {
    const inner = memoryStorage();
    let releaseFirstGet: (() => void) | undefined;
    let getCount = 0;
    const store = createAppearanceStore({
      async getItem(key) {
        getCount += 1;
        if (getCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstGet = resolve;
          });
        }
        return inner.getItem(key);
      },
      setItem: inner.setItem,
      deleteItem: inner.deleteItem,
    });

    const first = store.setBackgroundMode("atmosphere");
    const second = store.setBackgroundMode("code-gradient");
    await Promise.resolve();
    expect(getCount).toBe(1);
    expect(releaseFirstGet).toBeDefined();
    releaseFirstGet?.();
    await Promise.all([first, second]);
    expect(await store.load()).toEqual({
      backgroundMode: "code-gradient",
      colorSchemePreference: "system",
      surfaceStyle: "flat",
    });
  });

  it("persists the opt-in atmosphere background independently of theme", async () => {
    const store = createAppearanceStore(memoryStorage());
    const atmosphere = await store.setBackgroundMode("atmosphere");
    expect(atmosphere.backgroundMode).toBe("atmosphere");
    expect(atmosphere.surfaceStyle).toBe("flat");
    expect(await store.load()).toEqual(atmosphere);

    const dark = await store.setColorSchemePreference("dark");
    expect(dark.backgroundMode).toBe("atmosphere");

    const canvas = await store.setBackgroundMode("code-gradient");
    expect(canvas.backgroundMode).toBe("code-gradient");
    expect(canvas.colorSchemePreference).toBe("dark");
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
      surfaceStyle: "flat",
    });
    expect(await store.load()).toEqual(cleared);
  });
});
