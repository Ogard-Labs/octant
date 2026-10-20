import { describe, expect, it } from "vitest";
import {
  createAppearanceStore,
  DEFAULT_APPEARANCE,
  keepsWallpaper,
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
  it("starts a fresh install on Soft glow with the effect off", () => {
    expect(DEFAULT_APPEARANCE.picture).toBe("soft-glow");
    expect(DEFAULT_APPEARANCE.effect).toEqual({ kind: "none", cell: 4, levels: 4 });
  });

  it("replays saved backgrounds from before pictures as the ground they showed", () => {
    const parse = (backgroundMode: string, extra: object = {}) =>
      parseAppearancePreferences(JSON.stringify({ backgroundMode, ...extra }));
    expect(parse("code-gradient").picture).toBe("plain");
    expect(parse("atmosphere").picture).toBe("atmosphere");
    const custom = parse("custom", { customImageUri: "file:///a.jpg" });
    expect(custom.picture).toBe("custom");
    expect(custom.customImageUri).toBe("file:///a.jpg");
    expect(parse("custom").picture).toBe("plain");
  });

  it("clamps saved effect dials and ignores unknown effect kinds", () => {
    const parsed = parseAppearancePreferences(
      JSON.stringify({ picture: "soft-sunset", effect: { kind: "dither", cell: 40, levels: 1 } }),
    );
    expect(parsed.picture).toBe("soft-sunset");
    expect(parsed.effect).toEqual({ kind: "dither", cell: 16, levels: 2 });
    const odd = parseAppearancePreferences(
      JSON.stringify({ picture: "soft-glow", effect: { kind: "sparkle" } }),
    );
    expect(odd.effect.kind).toBe("none");
  });

  it("keeps the picture and effect across a save and load", async () => {
    const store = createAppearanceStore(memoryStorage());
    await store.setPicture("soft-graphite");
    const next = await store.setEffect({ kind: "dither", cell: 8, levels: 6 });
    expect(next.picture).toBe("soft-graphite");
    expect(await store.load()).toEqual(next);
  });

  it("defaults to Soft glow, system theme, and flat surfaces", () => {
    expect(parseAppearancePreferences(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreferences("{")).toEqual(DEFAULT_APPEARANCE);
    expect(DEFAULT_APPEARANCE.colorSchemePreference).toBe("system");
    expect(DEFAULT_APPEARANCE.surfaceStyle).toBe("flat");
  });

  it("parses legacy prefs without theme/surface as system + flat", () => {
    expect(parseAppearancePreferences(JSON.stringify({ backgroundMode: "code-gradient" }))).toEqual(
      {
        picture: "plain",
        effect: DEFAULT_APPEARANCE.effect,
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
    expect(withImage.picture).toBe("custom");

    const cleared = await store.clearCustomImage();
    expect(cleared.surfaceStyle).toBe("glass");
    expect(cleared.picture).toBe("plain");
  });

  it("persists theme preference independently of wallpaper", async () => {
    const store = createAppearanceStore(memoryStorage());
    const dark = await store.setColorSchemePreference("dark");
    expect(dark.colorSchemePreference).toBe("dark");
    expect(dark.picture).toBe("soft-glow");

    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.colorSchemePreference).toBe("dark");
    expect(withImage.picture).toBe("custom");

    const cleared = await store.clearCustomImage();
    expect(cleared.colorSchemePreference).toBe("dark");
    expect(cleared.picture).toBe("plain");
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

    const first = store.setPicture("atmosphere");
    const second = store.setPicture("plain");
    await Promise.resolve();
    expect(getCount).toBe(1);
    expect(releaseFirstGet).toBeDefined();
    releaseFirstGet?.();
    await Promise.all([first, second]);
    expect(await store.load()).toEqual({
      picture: "plain",
      effect: DEFAULT_APPEARANCE.effect,
      colorSchemePreference: "system",
      surfaceStyle: "flat",
    });
  });

  it("persists the opt-in atmosphere background independently of theme", async () => {
    const store = createAppearanceStore(memoryStorage());
    const atmosphere = await store.setPicture("atmosphere");
    expect(atmosphere.picture).toBe("atmosphere");
    expect(atmosphere.surfaceStyle).toBe("flat");
    expect(await store.load()).toEqual(atmosphere);

    const dark = await store.setColorSchemePreference("dark");
    expect(dark.picture).toBe("atmosphere");

    const canvas = await store.setPicture("plain");
    expect(canvas.picture).toBe("plain");
    expect(canvas.colorSchemePreference).toBe("dark");
  });

  it("persists and clears a custom background image", async () => {
    const store = createAppearanceStore(memoryStorage());
    const withImage = await store.saveCustomImage("data:image/png;base64,abc");
    expect(withImage.picture).toBe("custom");
    expect(withImage.customImageUri).toBe("data:image/png;base64,abc");
    expect(await store.load()).toEqual(withImage);

    const cleared = await store.clearCustomImage();
    expect(cleared).toEqual({
      picture: "plain",
      effect: DEFAULT_APPEARANCE.effect,
      colorSchemePreference: "system",
      surfaceStyle: "flat",
    });
    expect(await store.load()).toEqual(cleared);
  });
});

describe("wallpaper survival", () => {
  it("falls back to the plain page when the stored photo file is gone", async () => {
    const storage = memoryStorage();
    const present = createAppearanceStore(storage, { fileExists: async () => true });
    await present.saveCustomImage("file:///docs/background.jpg");
    expect((await present.load()).customImageUri).toBe("file:///docs/background.jpg");

    const missing = createAppearanceStore(storage, { fileExists: async () => false });
    expect(await missing.load()).toEqual({
      picture: "plain",
      effect: DEFAULT_APPEARANCE.effect,
      colorSchemePreference: "system",
      surfaceStyle: "flat",
    });
  });

  it("keeps inline photos without asking the file system", async () => {
    const fileExists = async () => false;
    expect(await keepsWallpaper("data:image/png;base64,AAAA", { fileExists })).toBe(true);
    expect(
      await keepsWallpaper("file:///x.jpg", {
        fileExists: async () => Promise.reject(new Error("io")),
      }),
    ).toBe(false);
  });
});
