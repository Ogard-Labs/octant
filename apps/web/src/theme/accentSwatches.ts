import {
  decodeThemeSemanticOverrides,
  type ThemeSemanticOverrides,
  type ThemeSettings,
} from "@octant/contracts/theme";

/**
 * The accent colours Appearance offers in one click. Blue is the colour
 * style's own accent (no override). Mono is the grey look: choosing it sets
 * the Mono style, whose ink accent needs different values per theme mode, so
 * it cannot be a single override. A colour is written as the accent fill with dark ink
 * on top of it, so a filled control stays readable. Accent text keeps the
 * preset's ink: every swatch passes as a fill in both modes, but none clears
 * normal-text contrast on the light page, and a dropped override raised the
 * theme's validation warning.
 */
export const ACCENT_SWATCHES = [
  { id: "blue", label: "Blue", color: "#5b9cf5" },
  { id: "clay", label: "Clay", color: "#d97757" },
  { id: "amber", label: "Amber", color: "#e3a33a" },
  { id: "green", label: "Green", color: "#3fb950" },
  { id: "purple", label: "Purple", color: "#a37cf0" },
  { id: "mono", label: "Mono", color: undefined },
] as const;

export type AccentSwatchId = (typeof ACCENT_SWATCHES)[number]["id"];

// Primary controls (the send button among them) put `primary-foreground` on
// the accent, so it takes the dark ink too: white on these colours measured
// 2.2–3.1:1 in the light theme.
const ACCENT_ROLES = new Set(["accent", "accent-text", "accent-foreground", "primary-foreground"]);
const ON_ACCENT_INK = "#141414";

/** Which swatch the saved settings match, or `custom` for an accent set elsewhere. */
export function currentAccentSwatch(settings: ThemeSettings): AccentSwatchId | "custom" {
  const accent = settings.semanticOverrides.find((entry) => entry.role === "accent")?.color;
  if (accent === undefined) return settings.style === "mono" ? "mono" : "blue";
  const swatch = ACCENT_SWATCHES.find(
    (candidate) => candidate.color?.toLowerCase() === accent.toLowerCase(),
  );
  return swatch?.id ?? "custom";
}

/**
 * The overrides with the accent roles replaced by the chosen swatch's. Under
 * the colour style Blue is the theme's own accent and writes nothing; under
 * Mono it must be written, or the theme's own would be the grey one.
 */
export function overridesForAccent(
  overrides: ThemeSemanticOverrides,
  swatch: AccentSwatchId,
  style: ThemeSettings["style"] = undefined,
): ThemeSemanticOverrides {
  const kept = overrides.filter((entry) => !ACCENT_ROLES.has(entry.role));
  const color = ACCENT_SWATCHES.find((candidate) => candidate.id === swatch)?.color;
  if (color === undefined) return kept;
  if (swatch === "blue" && style !== "mono") return kept;
  return decodeThemeSemanticOverrides([
    ...kept,
    { role: "accent", color },
    { role: "accent-foreground", color: ON_ACCENT_INK },
    { role: "primary-foreground", color: ON_ACCENT_INK },
  ]);
}
