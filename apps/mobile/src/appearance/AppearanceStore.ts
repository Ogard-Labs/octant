import type { ExpoSecureStringStorage } from "@octant/client-runtime";
import {
  clampEffect,
  DEFAULT_EFFECT,
  type GroundEffect,
  type GroundPicture,
} from "../../design-system/groundPrint";
import type { ColorSchemePreference, SurfaceStylePreference } from "../../design-system";

const PREFS_KEY = "appearance.preferences.v1";
const IMAGE_KEY = "appearance.backgroundImage.v1";

export interface AppearancePreferences {
  readonly picture: GroundPicture;
  readonly effect: GroundEffect;
  /** Data URI or file URI for custom wallpaper. */
  readonly customImageUri?: string;
  /** User theme: light, dark, or follow OS. */
  readonly colorSchemePreference: ColorSchemePreference;
  /** Frosted glass vs solid flat panels. */
  readonly surfaceStyle: SurfaceStylePreference;
}

/** A fresh install starts on Soft glow with the effect off, like the desktop. */
export const DEFAULT_APPEARANCE: AppearancePreferences = {
  picture: "soft-glow",
  effect: DEFAULT_EFFECT,
  colorSchemePreference: "system",
  surfaceStyle: "flat",
};

const PICTURES: ReadonlyArray<GroundPicture> = [
  "soft-glow",
  "soft-graphite",
  "soft-sunset",
  "atmosphere",
  "custom",
  "plain",
];

function parseColorSchemePreference(value: unknown): ColorSchemePreference {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function parseSurfaceStyle(value: unknown): SurfaceStylePreference {
  if (value === "flat" || value === "glass") return value;
  return "flat";
}

function isPicture(value: unknown): value is GroundPicture {
  return PICTURES.some((picture) => picture === value);
}

/**
 * Preferences written before pictures existed carried a `backgroundMode`; it
 * replays as the ground it showed then, so nobody's phone changes on update.
 */
function parsePicture(parsed: Record<string, unknown>): GroundPicture {
  if (isPicture(parsed.picture)) return parsed.picture;
  if (parsed.backgroundMode === "atmosphere") return "atmosphere";
  if (parsed.backgroundMode === "custom") return "custom";
  return "plain";
}

function parseEffect(value: unknown): GroundEffect {
  if (typeof value !== "object" || value === null) return DEFAULT_EFFECT;
  const record = value as Record<string, unknown>;
  const kind =
    record.kind === "pixelate" || record.kind === "dither" || record.kind === "none"
      ? record.kind
      : "none";
  return clampEffect({
    kind,
    cell: typeof record.cell === "number" ? record.cell : DEFAULT_EFFECT.cell,
    levels: typeof record.levels === "number" ? record.levels : DEFAULT_EFFECT.levels,
  });
}

export function parseAppearancePreferences(raw: string | null): AppearancePreferences {
  if (raw === null || raw.length === 0) return DEFAULT_APPEARANCE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_APPEARANCE;
    const record = parsed as Record<string, unknown>;
    const base = {
      effect: parseEffect(record.effect),
      colorSchemePreference: parseColorSchemePreference(record.colorSchemePreference),
      surfaceStyle: parseSurfaceStyle(record.surfaceStyle),
    };
    const picture = parsePicture(record);
    if (picture === "custom" && typeof record.customImageUri === "string") {
      return { ...base, picture, customImageUri: record.customImageUri };
    }
    return { ...base, picture: picture === "custom" ? "plain" : picture };
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
  readonly setPicture: (
    picture: Exclude<GroundPicture, "custom">,
  ) => Promise<AppearancePreferences>;
  readonly setEffect: (effect: GroundEffect) => Promise<AppearancePreferences>;
}

export interface AppearanceStoreOptions {
  /** Whether a stored file wallpaper still exists on this device. */
  readonly fileExists?: (uri: string) => Promise<boolean>;
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
    const meta: Record<string, unknown> = {
      picture: prefs.picture,
      effect: prefs.effect,
      colorSchemePreference: prefs.colorSchemePreference,
      surfaceStyle: prefs.surfaceStyle,
    };
    if (prefs.picture === "custom") {
      meta.customImageUri = "stored";
    }
    await storage.setItem(PREFS_KEY, JSON.stringify(meta));
  };

  const load = async (): Promise<AppearancePreferences> => {
    const prefs = parseAppearancePreferences(await storage.getItem(PREFS_KEY));
    if (prefs.picture !== "custom") {
      return prefs;
    }
    const { customImageUri: _stored, ...rest } = prefs;
    const image = await storage.getItem(IMAGE_KEY);
    if (image === null || image.length === 0 || !(await keepsWallpaper(image, options))) {
      return { ...rest, picture: "plain" };
    }
    return { ...rest, customImageUri: image };
  };

  const save = async (prefs: AppearancePreferences): Promise<void> => {
    if (prefs.picture === "custom" && prefs.customImageUri !== undefined) {
      await storage.setItem(IMAGE_KEY, prefs.customImageUri);
      await writeMeta(prefs);
      return;
    }
    await storage.deleteItem(IMAGE_KEY);
    await writeMeta({ ...prefs, picture: prefs.picture === "custom" ? "plain" : prefs.picture });
  };

  const update = (change: (current: AppearancePreferences) => AppearancePreferences) =>
    runExclusive(async () => {
      const next = change(await load());
      await save(next);
      return next;
    });

  return {
    load,
    save,
    saveCustomImage: (dataUri) =>
      update((current) => ({ ...current, picture: "custom", customImageUri: dataUri })),
    clearCustomImage: () =>
      update(({ customImageUri: _removed, ...current }) => ({ ...current, picture: "plain" })),
    setColorSchemePreference: (preference) =>
      update((current) => ({ ...current, colorSchemePreference: preference })),
    setSurfaceStyle: (style) => update((current) => ({ ...current, surfaceStyle: style })),
    setPicture: (picture) =>
      update(({ customImageUri: _removed, ...current }) => ({ ...current, picture })),
    setEffect: (effect) => update((current) => ({ ...current, effect: clampEffect(effect) })),
  };
}
