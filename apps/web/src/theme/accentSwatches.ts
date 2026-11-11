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

/** One colour the dark page reads as it is, and a deeper step of it for the light card. */
function deepenedInLight(lightFill: string, darkFill: string, ink: string = DARK_INK) {
  return { light: { fill: lightFill, ink }, dark: { fill: darkFill, ink } };
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
 * A fill is also a switch track, a meter and a primary button, so on the light
 * card it has to reach 3:1 (non-text contrast against #f0f0ef). The dark
 * values already do. Each light value is the dark one with only its OKLCH
 * lightness lowered, in steps of 0.002, until it measured 3.0:1 or more
 * against #f0f0ef; chroma and hue are kept. Dark ink on the deepened fills
 * measures 5.2:1 or more. Slate, Graphite and Carbon already clear 3:1.
 *
 * White cannot be seen on the light page and Carbon cannot be seen on the
 * dark one, so each names a silver for the mode it would vanish in, written
 * as a mode-only override.
 */
export const ACCENT_SWATCHES = [
  { id: "blue", label: "Blue", ...deepenedInLight("#4a8ae2", "#5b9cf5") },
  { id: "sky", label: "Sky", ...deepenedInLight("#0094c9", "#38b2e8") },
  { id: "teal", label: "Teal", ...deepenedInLight("#009b8c", "#2fb5a5") },
  { id: "green", label: "Green", ...deepenedInLight("#1a9f36", "#3fb950") },
  { id: "lime", label: "Lime", ...deepenedInLight("#639900", "#8fc93a") },
  { id: "amber", label: "Amber", ...deepenedInLight("#bb7e00", "#e3a33a") },
  { id: "orange", label: "Orange", ...deepenedInLight("#d26f17", "#f08a3c") },
  { id: "clay", label: "Clay", ...deepenedInLight("#d06f4f", "#d97757") },
  { id: "rose", label: "Rose", ...deepenedInLight("#e05c8c", "#f06a99") },
  { id: "pink", label: "Pink", ...deepenedInLight("#cc63be", "#e57ad6") },
  { id: "purple", label: "Purple", ...deepenedInLight("#9b74e7", "#a37cf0") },
  { id: "indigo", label: "Indigo", ...deepenedInLight("#7581e9", "#7f8cf5") },
  { id: "steel", label: "Steel", ...deepenedInLight("#778ca4", "#7d93ab") },
  { id: "slate", label: "Slate", ...both("#64748b", LIGHT_INK) },
  { id: "silver", label: "Silver", ...deepenedInLight("#89898e", "#8e8e93") },
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

// Primary controls (a dialog's acting answer among them) put `primary-foreground` on
// the accent, so it takes the swatch's ink too.
const ACCENT_ROLES = new Set(["accent", "accent-text", "accent-foreground", "primary-foreground"]);

function accentFor(settings: ThemeSettings, mode: "light" | "dark"): string | undefined {
  const accents = upgradeLegacyAccent(settings.semanticOverrides).filter(
    (entry) => entry.role === "accent",
  );
  const color =
    accents.find((entry) => entry.mode === mode)?.color ??
    accents.find((entry) => entry.mode === undefined)?.color;
  return color?.toLowerCase();
}

/**
 * A swatch chosen before the light fills were deepened was saved as one
 * mode-less set: its dark fill and ink for both modes. Read at paint time and
 * by the picker, that set becomes the pair the swatch writes today, so the
 * person's choice keeps its name and reads at 3:1 on the light card with no
 * write to their settings. Only an exact match is upgraded: a colour that is
 * no swatch's old value, or whose ink entries differ, is left as stored, and
 * so is any swatch whose light and dark fills never differed, and any set
 * that already scopes one of the accent roles to a mode.
 */
export function upgradeLegacyAccent(overrides: ThemeSemanticOverrides): ThemeSemanticOverrides {
  const legacy = (role: string) => overrides.find((e) => e.role === role && e.mode === undefined);
  const accent = legacy("accent");
  if (accent === undefined) return overrides;
  // A set that also scopes one of these roles to a mode is the person's own
  // arrangement, not a swatch's old write. Upgrading it would add a second
  // entry for the same role and mode, which the overrides refuse.
  const scopedToMode = overrides.some(
    (entry) =>
      entry.mode !== undefined &&
      (entry.role === "accent" ||
        entry.role === "accent-foreground" ||
        entry.role === "primary-foreground"),
  );
  if (scopedToMode) return overrides;
  const swatch = SWATCHES.find(
    (candidate) =>
      candidate.light !== undefined &&
      candidate.dark !== undefined &&
      candidate.light.fill !== candidate.dark.fill &&
      candidate.dark.fill.toLowerCase() === accent.color.toLowerCase() &&
      legacy("accent-foreground")?.color.toLowerCase() === candidate.dark.ink.toLowerCase() &&
      legacy("primary-foreground")?.color.toLowerCase() === candidate.dark.ink.toLowerCase(),
  );
  if (swatch?.light === undefined || swatch.dark === undefined) return overrides;
  const kept = overrides.filter(
    (entry) =>
      entry.mode !== undefined ||
      (entry.role !== "accent" &&
        entry.role !== "accent-foreground" &&
        entry.role !== "primary-foreground"),
  );
  return decodeThemeSemanticOverrides([
    ...kept,
    ...paintOverrides(swatch.light, "light"),
    ...paintOverrides(swatch.dark, "dark"),
  ]);
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

/**
 * The colour the picker paints a swatch's dot in a mode; Mono paints the
 * primary ink. A swatch with its own dot keeps it, because the dot names it.
 */
export function swatchDotColor(
  swatch: AccentSwatch,
  mode: "light" | "dark" = "light",
): string | undefined {
  return swatch.dot ?? swatch[mode]?.fill;
}
