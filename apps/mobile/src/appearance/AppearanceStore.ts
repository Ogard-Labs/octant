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
  surfaceStyle: "glass",
};

function parseColorSchemePreference(value: unknown): ColorSchemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function parseSurfaceStyle(value: unknown): SurfaceStylePreference {
  if (value === "flat" || value === "glass") return value;
  return "glass";
}

export function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (raw === null || raw.length === 0) return DEFAULT_APPEARANCE;
  try {
    const parsed = JSON.parse(raw) as Partial<AppearancePreferences>;
    const colorSchemePreference = parseColorSchemePreference(parsed.colorSchemePreference);
    const surfaceStyle = parseSurfaceStyle(parsed.surfaceStyle);
    const mode = parsed.backgroundMode === "custom" ? "custom" : "code-gradient";
    if (mode === "custom" && typeof parsed.customImageUri === "string") {
      return {
        backgroundMode: "custom",
        customImageUri: parsed.customImageUri,
        colorSchemePreference,
        surfaceStyle,
      };
    }
    return {
      backgroundMode: "code-gradient",
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
}

/**
 * Local appearance preferences. Image payload lives in a separate storage key
 * so preference JSON stays small (SecureStore-friendly).
 */
export function createAppearanceStore(storage: ExpoSecureStringStorage): AppearanceStore {
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
      return {
        backgroundMode: "code-gradient",
        colorSchemePreference: prefs.colorSchemePreference,
        surfaceStyle: prefs.surfaceStyle,
      };
    }
    const image = await storage.getItem(IMAGE_KEY);
    if (image === null || image.length === 0) {
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

  const save = async (prefs: AppearancePreferences): Promise<void> => {
    if (prefs.backgroundMode === "custom" && prefs.customImageUri !== undefined) {
      await storage.setItem(IMAGE_KEY, prefs.customImageUri);
      await writeMeta(prefs);
      return;
    }
    await storage.deleteItem(IMAGE_KEY);
    await writeMeta({
      backgroundMode: "code-gradient",
      colorSchemePreference: prefs.colorSchemePreference,
      surfaceStyle: prefs.surfaceStyle,
    });
  };

  return {
    load,
    save,
    async saveCustomImage(dataUri) {
      const current = await load();
      const next: AppearancePreferences = {
        backgroundMode: "custom",
        customImageUri: dataUri,
        colorSchemePreference: current.colorSchemePreference,
        surfaceStyle: current.surfaceStyle,
      };
      await save(next);
      return next;
    },
    async clearCustomImage() {
      const current = await load();
      const next: AppearancePreferences = {
        backgroundMode: "code-gradient",
        colorSchemePreference: current.colorSchemePreference,
        surfaceStyle: current.surfaceStyle,
      };
      await save(next);
      return next;
    },
    async setColorSchemePreference(preference) {
      const current = await load();
      const next: AppearancePreferences = {
        ...current,
        colorSchemePreference: preference,
      };
      await save(next);
      return next;
    },
    async setSurfaceStyle(style) {
      const current = await load();
      const next: AppearancePreferences = {
        ...current,
        surfaceStyle: style,
      };
      await save(next);
      return next;
    },
  };
}
