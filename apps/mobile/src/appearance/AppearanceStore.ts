import type { ExpoSecureStringStorage } from "@octant/client-runtime";
import type {
  CanvasBackgroundMode,
  ColorSchemePreference,
  SurfaceStylePreference,
} from "../../design-system";

const PREFS_KEY = "appearance.preferences.v1";
const IMAGE_KEY = "appearance.backgroundImage.v1";

export interface AppearancePreferences {
  readonly backgroundMode: CanvasBackgroundMode;
  /** Data URI or file URI for custom wallpaper. */
  readonly customImageUri?: string;
  /** User theme: light, dark, or follow OS. */
  readonly colorSchemePreference: ColorSchemePreference;
  /** Frosted glass vs solid flat panels. */
  readonly surfaceStyle: SurfaceStylePreference;
}

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  backgroundMode: "code-gradient",
  colorSchemePreference: "system",
  surfaceStyle: "flat",
};

function parseColorSchemePreference(value: unknown): ColorSchemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function parseSurfaceStyle(value: unknown): SurfaceStylePreference {
  if (value === "flat" || value === "glass") return value;
  return "flat";
}

export function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (raw === null || raw.length === 0) return DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(raw) as Partial<AppearancePreferences>;
    const colorSchemePreference = parseColorSchemePreference(parsed.colorSchemePreference);
    const surfaceStyle = parseSurfaceStyle(parsed.surfaceStyle);
    const mode: CanvasBackgroundMode =
      parsed.backgroundMode === "custom" || parsed.backgroundMode === "atmosphere"
        ? parsed.backgroundMode
        : "code-gradient";
    if (mode === "custom" && typeof parsed.customImageUri === "string") {
      return {
        backgroundMode: "custom",
        customImageUri: parsed.customImageUri,
        colorSchemePreference,
        surfaceStyle,
      };
    }
    return {
      backgroundMode: mode === "custom" ? "code-gradient" : mode,
      colorSchemePreference,
      surfaceStyle,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export interface AppearanceStore {
  readonly load: () => Promise<AppearancePreferences>;
  readonly save: (prefs: AppearancePreferences) => Promise<void>;
  readonly saveCustomImage: (dataUri: string) => Promise<AppearancePreferences>;
  readonly clearCustomImage: () => Promise<AppearancePreferences>;
  readonly setColorSchemePreference: (
    preference: ColorSchemePreference,
  ) => Promise<AppearancePreferences>;
  readonly setSurfaceStyle: (style: SurfaceStylePreference) => Promise<AppearancePreferences>;
  readonly setBackgroundMode: (
    mode: Exclude<CanvasBackgroundMode, "custom">,
  ) => Promise<AppearancePreferences>;
}

export interface AppearanceStoreOptions {
  /** Whether a stored file wallpaper still exists on this device. */
  readonly fileExists?: (uri: string) => Promise<boolean>;
  /** Deletes a wallpaper file the app copied; must ignore files it does not own. */
  readonly removeFile?: (uri: string) => Promise<void>;
}

/**
 * A wallpaper stored as a file path can vanish when the system clears caches
 * or the app is restored onto a new phone. Data URIs live in the store itself
 * and always survive, so only file URIs are checked.
 */
export async function keepsWallpaper(
  uri: string,
  options: AppearanceStoreOptions,
): Promise<boolean> {
  if (!uri.startsWith("file:") || options.fileExists === undefined) return true;
  try {
    return await options.fileExists(uri);
  } catch {
    return false;
  }
}

/**
 * Local appearance preferences. Image payload lives in a separate storage key
 * so preference JSON stays small (SecureStore-friendly).
 */
export function createAppearanceStore(
  storage: ExpoSecureStringStorage,
  options: AppearanceStoreOptions = {},
): AppearanceStore {
  // Overlapping load-then-save writes can persist the earlier tap. Queue them
  // so the last requested mode is the one that remains.
  let writeTail: Promise<void> = Promise.resolve();
  const runExclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writeTail.then(work, work);
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const writeMeta = async (prefs: AppearancePreferences): Promise<void> => {
    const meta: Record<string, string> = {
      backgroundMode: prefs.backgroundMode,
      colorSchemePreference: prefs.colorSchemePreference,
      surfaceStyle: prefs.surfaceStyle,
    };
    if (prefs.backgroundMode === "custom") {
      meta.customImageUri = "stored";
    }
    await storage.setItem(PREFS_KEY, JSON.stringify(meta));
  };

  const load = async (): Promise<AppearancePreferences> => {
    const prefs = parseAppearancePreferences(await storage.getItem(PREFS_KEY));
    if (prefs.backgroundMode !== "custom") {
      return prefs;
    }
    const image = await storage.getItem(IMAGE_KEY);
    if (image === null || image.length === 0 || !(await keepsWallpaper(image, options))) {
      return {
        backgroundMode: "code-gradient",
        colorSchemePreference: prefs.colorSchemePreference,
        surfaceStyle: prefs.surfaceStyle,
      };
    }
    return {
      backgroundMode: "custom",
      customImageUri: image,
      colorSchemePreference: prefs.colorSchemePreference,
      surfaceStyle: prefs.surfaceStyle,
    };
  };

  // The replaced copy is deleted only after the new state is stored, so a
  // failed save never strands the preferences without their wallpaper. A
  // failed delete leaves an orphan file, which is better than a failed save.
  const removeReplacedFile = async (previous: string | null, kept: string | undefined) => {
    if (previous === null || previous === kept || options.removeFile === undefined) return;
    try {
      await options.removeFile(previous);
    } catch {
      // Best effort.
    }
  };

  const save = async (prefs: AppearancePreferences): Promise<void> => {
    const previous = await storage.getItem(IMAGE_KEY);
    if (prefs.backgroundMode === "custom" && prefs.customImageUri !== undefined) {
      await storage.setItem(IMAGE_KEY, prefs.customImageUri);
      await writeMeta(prefs);
      await removeReplacedFile(previous, prefs.customImageUri);
      return;
    }
    await storage.deleteItem(IMAGE_KEY);
    await writeMeta({
      backgroundMode: prefs.backgroundMode === "custom" ? "code-gradient" : prefs.backgroundMode,
      colorSchemePreference: prefs.colorSchemePreference,
      surfaceStyle: prefs.surfaceStyle,
    });
    await removeReplacedFile(previous, undefined);
  };

  return {
    load,
    save,
    async saveCustomImage(dataUri) {
      return runExclusive(async () => {
        const current = await load();
        const next: AppearancePreferences = {
          backgroundMode: "custom",
          customImageUri: dataUri,
          colorSchemePreference: current.colorSchemePreference,
          surfaceStyle: current.surfaceStyle,
        };
        await save(next);
        return next;
      });
    },
    async clearCustomImage() {
      return runExclusive(async () => {
        const current = await load();
        const next: AppearancePreferences = {
          backgroundMode: "code-gradient",
          colorSchemePreference: current.colorSchemePreference,
          surfaceStyle: current.surfaceStyle,
        };
        await save(next);
        return next;
      });
    },
    async setColorSchemePreference(preference) {
      return runExclusive(async () => {
        const current = await load();
        const next: AppearancePreferences = {
          ...current,
          colorSchemePreference: preference,
        };
        await save(next);
        return next;
      });
    },
    async setSurfaceStyle(style) {
      return runExclusive(async () => {
        const current = await load();
        const next: AppearancePreferences = {
          ...current,
          surfaceStyle: style,
        };
        await save(next);
        return next;
      });
    },
    async setBackgroundMode(mode) {
      return runExclusive(async () => {
        const current = await load();
        const next: AppearancePreferences = {
          backgroundMode: mode,
          colorSchemePreference: current.colorSchemePreference,
          surfaceStyle: current.surfaceStyle,
        };
        await save(next);
        return next;
      });
    },
  };
}
