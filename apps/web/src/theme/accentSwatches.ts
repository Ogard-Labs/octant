import {
  decodeThemeSemanticOverrides,
  type ThemeSemanticOverrides,
  type ThemeSettings,
} from "@octant/contracts/theme";

/** The fill and the ink a filled control puts on it, in one theme mode. */
export interface AccentPaint {
  readonly fill: string;
  readonly ink: string;
}

export interface AccentSwatch {
  readonly id: string;
  readonly label: string;
  /** Present when the swatch writes a colour; Mono writes the Mono style instead. */
  readonly light?: AccentPaint;
  readonly dark?: AccentPaint;
  /** The picker's dot, when the swatch's namesake is not its light fill. */
  readonly dot?: string;
}

const DARK_INK = "#141414";
const LIGHT_INK = "#ffffff";

function both(fill: string, ink: string = DARK_INK) {
  return { light: { fill, ink }, dark: { fill, ink } };
}

/**
 * The accent colours Appearance offers in one click. Blue is the colour
 * style's own accent (no override). Mono is the grey look: choosing it sets
 * the Mono style, whose ink accent needs different values per theme mode.
 *
 * A swatch writes the accent fill and the ink on top of it. Each ink clears
 * normal-text contrast on its fill, or the theme drops the override; most take
 * dark ink, and the deep greys take white (white on the chromatic colours
 * measured 2.2–3.1:1). Accent text keeps the preset's ink: no swatch clears
 * normal-text contrast on the light page.
 *
 * Most colours read in both modes as one value. White cannot be seen on the
 * light page and Carbon cannot be seen on the dark one, so each names a
 * silver for the mode it would vanish in, written as a mode-only override.
 */
export const ACCENT_SWATCHES = [
  { id: "blue", label: "Blue", ...both("#5b9cf5") },
  { id: "sky", label: "Sky", ...both("#38b2e8") },
  { id: "teal", label: "Teal", ...both("#2fb5a5") },
  { id: "green", label: "Green", ...both("#3fb950") },
  { id: "lime", label: "Lime", ...both("#8fc93a") },
  { id: "amber", label: "Amber", ...both("#e3a33a") },
  { id: "orange", label: "Orange", ...both("#f08a3c") },
  { id: "clay", label: "Clay", ...both("#d97757") },
  { id: "rose", label: "Rose", ...both("#f06a99") },
  { id: "pink", label: "Pink", ...both("#e57ad6") },
  { id: "purple", label: "Purple", ...both("#a37cf0") },
  { id: "indigo", label: "Indigo", ...both("#7f8cf5") },
  { id: "steel", label: "Steel", ...both("#7d93ab") },
  { id: "slate", label: "Slate", ...both("#64748b", LIGHT_INK) },
  { id: "silver", label: "Silver", ...both("#8e8e93") },
  { id: "graphite", label: "Graphite", ...both("#636366", LIGHT_INK) },
  {
    id: "carbon",
    label: "Carbon",
    light: { fill: "#2b2b2e", ink: LIGHT_INK },
    dark: { fill: "#9a9aa0", ink: DARK_INK },
  },
  {
    id: "white",
    label: "White",
    light: { fill: "#8a8a8f", ink: DARK_INK },
    dark: { fill: "#ffffff", ink: DARK_INK },
    dot: "#ffffff",
  },
  { id: "mono", label: "Mono" },
] as const satisfies ReadonlyArray<AccentSwatch>;

export type AccentSwatchId = (typeof ACCENT_SWATCHES)[number]["id"];

const SWATCHES: ReadonlyArray<AccentSwatch & { readonly id: AccentSwatchId }> = ACCENT_SWATCHES;

// Primary controls (the send button among them) put `primary-foreground` on
// the accent, so it takes the swatch's ink too.
const ACCENT_ROLES = new Set(["accent", "accent-text", "accent-foreground", "primary-foreground"]);

function accentFor(settings: ThemeSettings, mode: "light" | "dark"): string | undefined {
  const accents = settings.semanticOverrides.filter((entry) => entry.role === "accent");
  const color =
    accents.find((entry) => entry.mode === mode)?.color ??
    accents.find((entry) => entry.mode === undefined)?.color;
  return color?.toLowerCase();
}

/** Which swatch the saved settings match, or `custom` for an accent set elsewhere. */
export function currentAccentSwatch(settings: ThemeSettings): AccentSwatchId | "custom" {
  const light = accentFor(settings, "light");
  const dark = accentFor(settings, "dark");
  if (light === undefined && dark === undefined) {
    return settings.style === "mono" ? "mono" : "blue";
  }
  const swatch = SWATCHES.find(
    (candidate) =>
      candidate.light?.fill.toLowerCase() === light && candidate.dark?.fill.toLowerCase() === dark,
  );
  return swatch?.id ?? "custom";
}

function paintOverrides(
  paint: AccentPaint,
  mode: "light" | "dark" | undefined,
): ReadonlyArray<{
  readonly role: string;
  readonly color: string;
  readonly mode?: "light" | "dark";
}> {
  const scope = mode === undefined ? {} : { mode };
  return [
    { role: "accent", color: paint.fill, ...scope },
    { role: "accent-foreground", color: paint.ink, ...scope },
    { role: "primary-foreground", color: paint.ink, ...scope },
  ];
}

/**
 * The overrides with the accent roles replaced by the chosen swatch's. Under
 * the colour style Blue is the theme's own accent and writes nothing; under
 * Mono it must be written, or the theme's own would be the grey one.
 */
export function overridesForAccent(
  overrides: ThemeSemanticOverrides,
  swatchId: AccentSwatchId,
  style: ThemeSettings["style"] = undefined,
): ThemeSemanticOverrides {
  const kept = overrides.filter((entry) => !ACCENT_ROLES.has(entry.role));
  const swatch = SWATCHES.find((candidate) => candidate.id === swatchId);
  if (swatch?.light === undefined || swatch.dark === undefined) return kept;
  if (swatch.id === "blue" && style !== "mono") return kept;
  const { light, dark } = swatch;
  const sameInBothModes = light.fill === dark.fill && light.ink === dark.ink;
  return decodeThemeSemanticOverrides([
    ...kept,
    ...(sameInBothModes
      ? paintOverrides(light, undefined)
      : [...paintOverrides(light, "light"), ...paintOverrides(dark, "dark")]),
  ]);
}

/** The colour the picker paints a swatch's dot; Mono paints the primary ink. */
export function swatchDotColor(swatch: AccentSwatch): string | undefined {
  return swatch.dot ?? swatch.light?.fill;
}
